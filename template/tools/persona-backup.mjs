import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORMAT = "persona-d1-backup-v1";
const ITERATIONS = 210_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTOMATIC_BACKUP_NAME =
  /^persona-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.personabackup$/u;

function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("backup_passphrase_too_short");
  }
  return pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
}

export async function encryptBackup(data, passphrase, metadata) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const envelope = {
    format: FORMAT,
    createdAt: metadata.createdAt,
    database: metadata.database,
    kdf: { name: "pbkdf2-sha256", iterations: ITERATIONS, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export async function decryptBackup(serialized, passphrase) {
  try {
    const envelope = JSON.parse(serialized);
    if (
      envelope?.format !== FORMAT || envelope?.kdf?.name !== "pbkdf2-sha256" ||
      envelope?.cipher?.name !== "aes-256-gcm" ||
      !Number.isSafeInteger(envelope.kdf.iterations) || envelope.kdf.iterations < 100_000
    ) throw new Error("invalid_envelope");
    const salt = Buffer.from(envelope.kdf.salt, "base64");
    const iv = Buffer.from(envelope.cipher.iv, "base64");
    const tag = Buffer.from(envelope.cipher.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid_envelope");
    }
    const key = deriveKey(passphrase, salt, envelope.kdf.iterations);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (error) {
    if (error instanceof Error && error.message === "backup_passphrase_too_short") throw error;
    throw new Error("backup_decryption_failed");
  }
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function runWrangler(args) {
  const wrangler = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`wrangler_failed_${result.status ?? "unknown"}`);
}

export async function pruneAutomaticBackups(outputDirectory, keep) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 1_000) {
    throw new Error("invalid_backup_retention");
  }

  const root = path.resolve(outputDirectory);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !AUTOMATIC_BACKUP_NAME.test(entry.name)) continue;
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root) {
      throw new Error("backup_retention_path_escape");
    }
    candidates.push({
      path: candidate,
      name: entry.name,
      modifiedAt: (await stat(candidate)).mtimeMs,
    });
  }

  candidates.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt ||
      right.name.localeCompare(left.name),
  );
  const removed = [];
  for (const candidate of candidates.slice(keep)) {
    await rm(candidate.path);
    removed.push(candidate.path);
  }
  return removed;
}

async function main() {
  const mode = process.argv[2];
  const database = option("--database", "persona-telegram-bot");
  const passphrase = process.env.YUAN_BACKUP_PASSPHRASE ?? "";
  const temporarySql = path.join(os.tmpdir(), `persona-d1-${randomUUID()}.sql`);
  try {
    if (mode === "backup") {
      const outputDirectory = path.resolve(option("--output", path.join(ROOT, "backups")));
      await mkdir(outputDirectory, { recursive: true });
      runWrangler(["d1", "export", database, "--remote", "--output", temporarySql, "--skip-confirmation"]);
      const createdAt = new Date().toISOString();
      const encrypted = await encryptBackup(await readFile(temporarySql), passphrase, { database, createdAt });
      const outputPath = path.join(outputDirectory, `persona-${createdAt.replaceAll(":", "-")}.personabackup`);
      await writeFile(outputPath, encrypted, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`Encrypted backup created: ${outputPath}\n`);
      const keepValue = option("--keep");
      if (keepValue !== null) {
        const removed = await pruneAutomaticBackups(
          outputDirectory,
          Number(keepValue),
        );
        process.stdout.write(`Old encrypted backups removed: ${removed.length}\n`);
      }
      return;
    }
    if (mode === "restore") {
      const input = option("--input");
      if (input === null || !process.argv.includes("--confirm-empty-database")) {
        throw new Error("restore_requires_input_and_empty_database_confirmation");
      }
      const decrypted = await decryptBackup(await readFile(path.resolve(input), "utf8"), passphrase);
      await writeFile(temporarySql, decrypted, { flag: "wx" });
      runWrangler(["d1", "execute", database, "--remote", "--file", temporarySql, "--yes"]);
      process.stdout.write("Encrypted backup restored into the confirmed empty database.\n");
      return;
    }
    throw new Error("usage_backup_or_restore");
  } finally {
    await rm(temporarySql, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "backup_failed"}\n`);
    process.exitCode = 1;
  });
}
