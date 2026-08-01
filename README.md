<div align="right">

[![English](https://img.shields.io/badge/lang-English-lightgrey.svg)](README_EN.md)
[![中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-blue.svg)](README.md)

</div>

# Cloudflare Telegram AI 机器人部署器

> [!IMPORTANT]
> 本项目是独立开源工具，与 Cloudflare、Telegram 或 DeepSeek 不存在隶属、授权、背书或合作关系。使用前请阅读[中文免责声明](DISCLAIMER_ZH.md)、[English Disclaimer](DISCLAIMER.md)、[隐私说明](PRIVACY.md)，并确认第三方服务的条款与价格。

这是一个 Windows 可视化向导，用于把私人、纯文字的 Telegram AI 机器人部署到你自己的 Cloudflare 账号。它负责创建并配置 Worker、D1 数据库、消息队列（含死信队列）、Vectorize 向量索引、Workflow（提醒）、Secrets、Telegram Webhook，并在部署完成后执行健康检查。生成的项目直接落在你选择的本地目录，之后可以继续用 Wrangler 或面板管理。

## 功能特性

- **全程本地可视化向导**：环境检查与 Cloudflare 登录、项目配置、密钥填写、免责确认、部署五步完成；无需单独安装 Node.js 或 Wrangler（安装包已内置）。
- **可恢复部署**：中断后重新打开应用即可继续，已完成的步骤不会重复执行，关键步骤幂等。
- **隐私优先**：密钥只在本机输入，提交后立即清空表单；只通过 Wrangler 标准输入写入 Secrets；应用无遥测、无远程脚本，只加载本地资源。
- **模型可选**：默认 DeepSeek V4 Flash（更快更省），可选 V4 Pro，并带独立的“思考模式”开关。
- **生成的机器人能力**：人格系统（导入/自定义人格、`/persona-add`、`/persona-rollback`、版本历史与导出）、长期记忆（D1 + 向量检索 + 冲突确认）、低频主动联系、每周回顾、提醒与周报，以及 Telegram Web App 管理面板。

## 已修复的部署问题

- **导入人格文件无响应**：已修复打包版 Electron 预加载脚本的兼容性问题，`选择文件` 现在可以正常打开 Windows 文件选择框并导入 `.txt`、`.md` 或 `.json` 人格 Prompt。
- **首次部署卡在 `workers.dev`**：对尚未注册 `workers.dev` 子域名的全新 Cloudflare 账号，应用会明确提示先完成一次 Dashboard 注册，再点击“恢复部署”。同一账号只需操作一次。
- **最后一步 `health: fetch failed`**：健康检查会自动重试；当 Worker 已成功部署但暂时无法访问时，应用会给出可恢复提示，而不是把已部署资源误报为失败。

详细处理步骤见[首次部署故障处理](docs/first-use-troubleshooting-zh.md)。

## 近期更新（生成机器人模板）

- **v1.0.0 正式版**：长期记忆只接受可追溯到用户原话的事实；低相关记忆不再自动注入；模型空响应自动重试并提供简短兜底；历史失败任务不再阻塞主动联系；新增不含聊天正文的队列日志和本地加密 D1 全库备份/恢复工具。
- **v0.1.7**：生成机器人不再输出“（动作）（背景）（环境）”等括号旁白或舞台说明，直接输出对话；模板测试同时适配非空导入人格。
- **v0.1.6**：记忆可靠性修复——逾期记忆更新自动补偿、记忆提取失败持久化、按未摘要消息数触发更新。
- **记忆管理强化**：更宽容的记忆 JSON 解析、应用内管理 episode 记忆。

## 环境要求

- Windows 10/11 x64。
- 一个 Cloudflare 账号（免费计划可用；各服务额度与价格请以官方页面为准）。
- 一个 Telegram Bot Token（由 BotFather 创建）。
- 一个 DeepSeek API Key。
- 能直连 `api.telegram.org` 的网络环境（见下文“网络要求”）。

## 快速开始

1. 在仓库的 **Releases** 页面下载最新版 `Telegram.AI.Deployer-x.x.x-x64.exe`。
2. 运行安装程序，选择安装目录（支持自定义路径，普通用户权限即可，无需管理员）。
3. 启动应用，按向导依次完成：环境检查与 Cloudflare 登录 → 填写项目名称与空目录 → 填写三项密钥 → 阅读并勾选免责声明 → 开始部署。
4. 部署完成后按提示完成 Telegram 配对（首次会给出配对说明），然后开始聊天。
5. 在聊天中发送 `/help` 查看全部命令，发送 `/settings` 打开管理面板。

生成完成后，可在机器人项目目录运行 `npm.cmd run backup` 创建加密 D1 全库备份；具体恢复步骤见项目内的 `BACKUP_ZH.md`。

更详细的步骤见[中文使用指南](docs/user-guide-zh.md)或 [English user guide](docs/user-guide.md)。

## 网络要求

部署过程会从你的电脑直接发起 HTTPS 连接：

- `api.telegram.org` —— 验证 Bot Token、注册 Webhook
- `api.deepseek.com` —— 验证 API Key
- Cloudflare 服务 API —— 通过内置的 Wrangler CLI

这些连接**不遵循 Windows 系统代理**。在无法直连 `api.telegram.org` 的地区（例如中国大陆），部署会在 `secrets` 步骤报“无法连接 api.telegram.org”。解决办法：

- **推荐**：在代理客户端（Clash Verge、v2rayN 等）中开启 **TUN（全局）模式**，让所有应用的流量都经过代理，然后重试失败的步骤。
- **备选**：关闭应用后，在终端中带环境变量启动（应用内置的 Node.js 运行时支持）：

  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"  # 端口按你的代理实际配置修改
  & "C:\你的路径\Cloudflare Telegram AI Bot Deployer.exe"
  ```

## 安全设计

- 密钥仅在本机输入，提交后立即清空表单，通过 Wrangler Secret 标准输入写入 Cloudflare，不落盘到项目文件。
- Wrangler 内置并锁定版本；应用从不执行 `npm`、`npx` 或通过 `PATH` 解析的命令。
- 密钥、导入的人格原文、部署状态、生成工程和日志均不会进入 Git。
- 应用只加载本地资源，不含遥测与远程脚本。
- 报告安全问题前请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中贴出密钥、Token 或私人 Prompt。

## 隐私与免责声明

开始使用即表示你已阅读并同意[免责声明（中文）](DISCLAIMER_ZH.md)、[English Disclaimer](DISCLAIMER.md) 与[隐私说明](PRIVACY.md)。部署会调用 Cloudflare、Telegram、DeepSeek 等第三方服务并可能产生费用；生成机器人会存储聊天记录与记忆数据，请按自己的数据保留策略定期备份、清理和删除。

## 状态与路线图

- 当前状态：`v1.0.0` 正式版。软件仍按“无担保”方式提供；重要数据请定期使用生成项目内的加密备份工具保存副本。
- 路线图方向：生成机器人管理面板增强、部署恢复与诊断细化、多语言使用文档完善。

## 相关文档

- 使用指南：[中文](docs/user-guide-zh.md) · [English](docs/user-guide.md)
- 首次部署故障处理：`docs/first-use-troubleshooting-zh.md`
- 架构说明：`docs/architecture.md` · 发布检查清单：`docs/release-checklist.md`
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 许可证：[MIT](LICENSE)
