import assert from "node:assert/strict";
import { decryptBackup, encryptBackup, readConfiguredDatabaseName } from "./persona-backup.mjs";

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
assert.equal(
  readConfiguredDatabaseName('{"d1_databases":[{"binding":"DB","database_name":"my-bot-db"}]}'),
  "my-bot-db",
);
console.log("persona backup encryption tests passed");
