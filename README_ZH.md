# Cloudflare Telegram AI 机器人部署器

> [!IMPORTANT]
> 本项目是独立开源工具，与 Cloudflare、Telegram 或 DeepSeek 不存在隶属、授权、背书或合作关系。使用前请阅读 [中文免责声明](DISCLAIMER_ZH.md)、[隐私说明](PRIVACY.md)以及第三方服务条款和价格。

这是一个 Windows 可视化向导，用于把私人、纯文字 Telegram AI 机器人部署到用户自己的 Cloudflare 账户。它会创建 Worker、D1、队列、Vectorize、Workflow、Secrets、Webhook，并完成健康检查。

首个版本支持 Windows 10/11 x64。默认模型为成本较低的 DeepSeek V4 Flash，也可以选择 V4 Pro，并独立开关思考模式。

## 网络要求

部署过程会从你的电脑直接发起 HTTPS 连接：

- `api.telegram.org` —— 验证 Bot Token、注册 Webhook
- `api.deepseek.com` —— 验证 API Key
- Cloudflare 服务 API —— 通过内置的 Wrangler CLI

这些连接**不走 Windows 系统代理**。在无法直连 `api.telegram.org` 的地区（例如中国大陆），部署会在 `secrets` 步骤报"无法连接 api.telegram.org"。解决方法：

- **推荐**：在代理客户端（Clash Verge、v2rayN 等）中开启 **TUN（全局）模式**，让所有应用的流量都经过代理，然后重试失败的步骤。
- **备选**：关闭应用后，在终端中带环境变量启动（应用内置的 Node.js 24 运行时支持该方式）：

  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"  # 端口按你的代理实际配置修改
  & "C:\你的路径\Cloudflare Telegram AI Bot Deployer.exe"
  ```

## 安全设计

- 密钥仅在本地输入，提交后立即清空表单，通过 Wrangler Secret 标准输入写入 Cloudflare。
- 密钥、人格正文、部署状态、生成工程和日志不会进入 Git。
- 应用只加载本地资源，不包含遥测。
- 报告安全问题前请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中提交密钥或私人 Prompt。

## 当前状态

Windows 应用正在开发。不要用预发布版本处理无法替代的重要数据。

English documentation: [README.md](README.md)

技术文档：[使用指南（中文）](docs/user-guide-zh.md) · [架构说明](docs/architecture.md) · [发布检查清单](docs/release-checklist.md)

许可证：[MIT](LICENSE)
