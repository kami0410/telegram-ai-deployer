[English](user-guide.md) · [中文](user-guide-zh.md)

# 使用指南（中文）

本指南按实际使用顺序，详细说明 Cloudflare Telegram AI 机器人部署器的每一步操作。

> [!IMPORTANT]
> 本项目是独立开源工具，与 Cloudflare、Telegram、DeepSeek 无隶属或背书关系。部署会在**你自己的 Cloudflare 账户**中创建付费/免费资源，使用前请阅读 [DISCLAIMER_ZH.md](../DISCLAIMER_ZH.md) 与 [PRIVACY.md](../PRIVACY.md)。

---

## 一、这个软件会做什么

它是一个 Windows 桌面向导，帮你在自己的 Cloudflare 账户里自动创建并配置：

- 一个 **Worker**（机器人后端，含定时任务）
- 一个 **D1 数据库**（聊天记录、配置，含 6 个数据表迁移）
- 一对**队列**（主队列 + 死信队列，削峰与重试）
- 一个 **Vectorize 向量索引**（语义记忆）
- 一个 **Workflow**（提醒/复盘任务）
- 写入 **Secrets**（你的密钥）、注册 **Telegram Webhook**，最后做健康检查

你只需提供三个密钥，其他全自动。

## 二、开始前的准备

### 1. 三个必需账户/密钥

| 项目 | 获取方式 | 费用 |
|---|---|---|
| Cloudflare 账户 | [dash.cloudflare.com](https://dash.cloudflare.com) 注册 | 注册免费 |
| Cloudflare Workers 套餐 | 无需升级，免费套餐即可 | Queues 自 2026 年 2 月起纳入免费套餐（每天 1 万次操作额度），Workflows 也有免费额度（每天 10 万次请求），个人使用足够；注意免费版队列消息只保留 24 小时 |
| Telegram Bot Token | Telegram 内找 [@BotFather](https://t.me/BotFather) → 发送 `/newbot` → 按提示起名 → 得到形如 `123456:ABC-DEF...` 的 Token | 免费 |
| DeepSeek API Key | [platform.deepseek.com](https://platform.deepseek.com) → API Keys → 创建 | 按量计费，先小额充值 |

### 2. 网络环境（请务必阅读）

部署过程需要直接访问以下服务：

- `api.cloudflare.com`（Cloudflare API）
- `api.telegram.org`（Telegram Bot API）
- `api.deepseek.com`（DeepSeek API）

**请在所在地法律法规允许的、能够正常访问上述服务的网络环境下使用**（例如身处境外、或使用企业合规的国际网络出口）。本指南不提供任何绕过网络管理措施的方法。

技术上的两个事实，供已有合规网络出口的用户参考：

- 本应用的网络请求**不读取 Windows 系统代理设置**，只会直连。如果你的合规出口以系统代理形式提供，需要让它工作在网络层（全局/TUN 模式），应用流量才会经过它。
- 也可以通过环境变量为应用单独指定出口（内置 Node.js 24 运行时支持）：关闭应用后，在终端执行
  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://你的出口地址:端口"
  & "C:\你的安装路径\Cloudflare Telegram AI Bot Deployer.exe"
  ```

### 3. 一台 Windows 10/11 x64 电脑

不需要安装 Node.js、npm 或任何其他环境——运行时和部署工具已内置。

## 三、安装

从 [Releases](https://github.com/kami0410/telegram-ai-deployer/releases) 下载最新版：

- **`Telegram.AI.Deployer-x.x.x-x64.exe`**：安装包。双击 → 可选安装目录 → 自动创建桌面和开始菜单快捷方式。不需要管理员权限（安装到当前用户目录）。
- **`Telegram.AI.Deployer-x.x.x-x64.zip`**：免安装绿色版。解压到任意目录，运行其中的 exe 即可。

> 建议核对 Release 页面附带的 SHA256 校验和（PowerShell：`Get-FileHash 文件名 -Algorithm SHA256`）。

## 四、向导逐步操作

### 第 1 步：环境检查

点击「**检查并连接**」。

- 未登录过 Cloudflare 时，会自动拉起浏览器进入 Cloudflare 授权页，登录并点 **Allow** 即可（授权的是 Wrangler CLI，凭证保存在本机用户目录）。
- 显示「**Cloudflare 已连接**」后点「下一步」。
- 如果授权失败，可多点几次检查；也可以用 API Token 方式：在 Cloudflare 后台 → My Profile → API Tokens → 用 "Edit Cloudflare Workers" 模板创建 Token，为本应用所在电脑设置系统环境变量 `CLOUDFLARE_API_TOKEN`，重启应用再检查。

### 第 2 步：人格文件（可选）

选择一个人格提示词文件（`.txt` / `.md` / `.json`，不超过 10 万字符），机器人的说话风格会以它为基础。

- 不选择也可以，会使用通用人格，之后可随时换。
- 该文件只在本机读取并写入你私有的 Worker，**不会上传到任何第三方**（Cloudflare 部署除外）。

### 第 3 步：填写配置

| 字段 | 说明 |
|---|---|
| 模型 | **V4 Flash**（默认，更快更省）或 **V4 Pro**（复杂任务质量优先） |
| 思考模式 | 开关，开启后回答更慢但推理更充分 |
| 项目名称 | 小写字母开头的 2–40 位安全字符（字母/数字/连字符），会用作 Worker 名，也是各资源的命名前缀 |
| 新建/空的项目目录 | 生成的机器人工程存放位置，**必须是新建的或空的目录**，用绝对路径（如 `C:\Bots\my-bot`） |
| Telegram Bot Token | BotFather 给你的那串 |
| DeepSeek API Key | DeepSeek 平台创建的那串 |
| 配对/迁移密钥 | **自己编一个 8–32 位的密码**，是你作为机器人主人的凭证，请记住它 |

> 密钥提交后表单会立即清空，只通过加密通道写入你的 Cloudflare Worker，不会落盘到项目文件。

### 第 4 步：确认免责并部署

勾选「我已阅读并接受免责声明…」（可先点链接查看全文），然后点「**开始部署**」。

部署共 11 个步骤，全程有脱敏日志，通常 2–5 分钟：

1. **environment** — 验证 Cloudflare 登录状态
2. **template** — 在本地生成机器人工程
3. **d1** — 创建 D1 数据库
4. **queues** — 创建主队列和死信队列
5. **vectorize** — 创建向量索引及元数据索引
6. **migration** — 执行 6 个数据库迁移
7. **first-deploy** — 首次上传 Worker 并激活
8. **secrets** — 验证 Telegram Token 和 DeepSeek Key，写入密钥
9. **final-deploy** — 用真实地址重新部署
10. **webhook** — 向 Telegram 注册回调地址
11. **health** — 健康检查

全部变绿即完成。

### 第 5 步：开始使用

1. 在 Telegram 里打开你的机器人，发送：`/pair 你的配对密钥`
2. 配对成功后即可正常聊天。
3. 想改人格/配置：重新运行向导部署（同名项目会复用已有资源）。

## 五、部署中断与恢复

部署进度保存在你指定的项目目录下的 `deployment-state.json` 中。

- 任何一步失败，应用会显示具体原因，「**恢复部署**」按钮变为可用。
- 排除问题后点「恢复部署」，会**从失败的步骤继续**，已完成的资源不会重复创建。
- 注意：恢复时需要重新输入三个密钥（出于安全，密钥从不落盘）。

## 六、常见问题

**Q：环境检查一直显示未连接？**
A：确认浏览器里完成了 Cloudflare 授权；或改用 `CLOUDFLARE_API_TOKEN` 环境变量方式（见第 1 步）。

**Q：secrets 步骤报"无法连接 api.telegram.org"？**
A：当前网络无法直连 Telegram Bot API。请在合规的网络环境下使用（见"二、2"），然后点「恢复部署」，已完成的步骤不会重来。

**Q：报"Telegram token 无效"？**
A：这次是真的连上了但 Token 不对。检查是否复制完整、有无多余空格/换行；或在 BotFather 用 `/token` 重新生成。

**Q：报"DeepSeek key 无效（HTTP 401/402）"？**
A：Key 错误或余额不足，去 DeepSeek 平台核对。

**Q：免费套餐的额度够用吗？**
A：个人使用完全够。免费套餐每天包含：Worker 请求 10 万次、Queues 操作 1 万次、Workflows 请求 10 万次、D1 读取 500 万行。只有免费版队列的消息保留期是 24 小时（付费版 14 天），对机器人场景没有影响。真的超限了再去后台升级 Workers Paid 即可。

**Q：可以部署多个机器人吗？**
A：可以。每个机器人用不同的**项目名称**和**独立空目录**即可，资源完全隔离。

**Q：部署会影响我 Cloudflare 里的其他项目吗？**
A：不会。所有资源名都以你的项目名为前缀，只创建/复用自己的那一套。

## 七、合规与隐私提示

- 请在你所在地区法律法规允许的范围内使用本软件及 Telegram、Cloudflare、DeepSeek 服务，并遵守各平台的服务条款。
- 不要用人格文件导入他人隐私信息或任何违法内容；机器人产出的内容责任由部署者承担。
- 本应用无遥测、不加载远程页面；密钥仅保存在你的 Cloudflare Worker Secrets 中。
- 卸载应用不会删除 Cloudflare 上的资源；如需彻底清理，请在 Cloudflare 后台删除对应 Worker、D1、队列和 Vectorize 索引。
