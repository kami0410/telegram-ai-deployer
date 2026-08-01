# 加密全库备份

账号恢复密钥只负责在同一个 D1 数据库中迁移 Telegram 账号。若要防范 Cloudflare 项目或数据库丢失，请在本项目目录运行：

```powershell
npm.cmd run backup
```

脚本会自动读取 `wrangler.jsonc` 中绑定为 `DB` 的数据库名，导出远程 D1，并用 PBKDF2-SHA256 与 AES-256-GCM 加密。备份写入未纳入 Git 的 `backups` 文件夹，临时明文 SQL 会在成功或失败后删除。密码至少 12 位且不会保存，丢失后无法恢复。

恢复时请创建一个全新的空 D1 数据库，然后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\persona-backup.ps1 -Mode restore -InputPath "D:\backup\persona-example.personabackup" -Database "新数据库名" -ConfirmEmptyDatabase
```

恢复完成后，把 `wrangler.jsonc` 中的 `database_id` 和 `database_name` 改为新数据库，再运行 `npm.cmd run deploy`。不要把备份文件、密码或解密后的 SQL 上传到 GitHub。
