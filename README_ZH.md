# Cloudflare Telegram AI 机器人部署器

> [!IMPORTANT]
> 本项目是独立开源工具，与 Cloudflare、Telegram 或 DeepSeek 不存在隶属、授权、背书或合作关系。使用前请阅读 [中文免责声明](DISCLAIMER_ZH.md)、[隐私说明](PRIVACY.md)以及第三方服务条款和价格。

这是一个 Windows 可视化向导，用于把私人、纯文字 Telegram AI 机器人部署到用户自己的 Cloudflare 账户。它会创建 Worker、D1、队列、Vectorize、Workflow、Secrets、Webhook，并完成健康检查。

首个版本支持 Windows 10/11 x64。默认模型为成本较低的 DeepSeek V4 Flash，也可以选择 V4 Pro，并独立开关思考模式。

## 安全设计

- 密钥仅在本地输入，提交后立即清空表单，通过 Wrangler Secret 标准输入写入 Cloudflare。
- 密钥、人格正文、部署状态、生成工程和日志不会进入 Git。
- 应用只加载本地资源，不包含遥测。
- 报告安全问题前请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中提交密钥或私人 Prompt。

## 当前状态

Windows 应用正在开发。不要用预发布版本处理无法替代的重要数据。

English documentation: [README.md](README.md)

许可证：[MIT](LICENSE)
