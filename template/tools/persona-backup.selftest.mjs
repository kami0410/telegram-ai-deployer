import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decryptBackup,
  encryptBackup,
  pruneAutomaticBackups,
} from "./persona-backup.mjs";

const plaintext = new TextEncoder().encode(
  "CREATE TABLE private_chat(content TEXT);\nprivate chat content",
);
const encrypted = await encryptBackup(
  plaintext,
  "correct horse battery staple",
  {
    database: "persona-test",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
);

assert.match(encrypted, /"format":"persona-d1-backup-v1"/u);
assert.doesNotMatch(encrypted, /private chat content/u);
assert.deepEqual(
  await decryptBackup(encrypted, "correct horse battery staple"),
  plaintext,
);
await assert.rejects(
  decryptBackup(encrypted, "wrong passphrase"),
  /backup_decryption_failed/u,
);

const rotationRoot = await mkdtemp(
  path.join(os.tmpdir(), "persona-backup-rotation-"),
);
const outside = path.join(
  os.tmpdir(),
  `persona-outside-${Date.now()}.personabackup`,
);
try {
  for (let index = 0; index < 13; index += 1) {
    const name = `persona-2026-08-${String(index + 1).padStart(2, "0")}T10-00-00.000Z.personabackup`;
    await writeFile(path.join(rotationRoot, name), `backup-${index}`, "utf8");
  }
  await writeFile(
    path.join(rotationRoot, "keep-me.txt"),
    "not a backup",
    "utf8",
  );
  await writeFile(outside, "outside", "utf8");

  const removed = await pruneAutomaticBackups(rotationRoot, 12);
  assert.equal(removed.length, 1);
  const remaining = await readdir(rotationRoot);
  assert.equal(
    remaining.filter((name) => name.endsWith(".personabackup")).length,
    12,
  );
  assert.ok(remaining.includes("keep-me.txt"));
  assert.equal(await readFile(outside, "utf8"), "outside");
} finally {
  await rm(rotationRoot, { recursive: true, force: true });
  await rm(outside, { force: true });
}

console.log("persona backup encryption tests passed");
