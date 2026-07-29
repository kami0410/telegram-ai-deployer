# Windows 可视化部署器设计

## 目标

提供一个可公开发布的 Windows 桌面安装程序，让非技术用户通过图形向导部署一个基于 Cloudflare Workers、Telegram 和 DeepSeek 的私人聊天机器人。优先减少实现过程的模型 token 消耗，因此使用 Electron 复用现有 Node.js 与 Wrangler 部署逻辑。

## 隐私边界

- 开源仓库只包含通用模板、占位符和虚构测试数据。
- 不包含任何真实用户名、机器人名称、域名、Cloudflare 资源 ID、Token、API Key、聊天记录或人格资料。
- Telegram Token、DeepSeek Key、配对码和 Webhook Secret 只在 Electron 主进程内短暂存在。
- 密钥通过 `wrangler secret bulk` 的标准输入写入 Cloudflare，不写入磁盘、页面状态或日志。
- 导入的人格 Prompt 只写入用户生成工程中被 `.gitignore` 排除的文件；界面和日志只显示文件名与字符数，不显示正文。
- 发布前扫描工作树、Git 历史、安装包内容和一次虚构数据生成结果。

## 技术方案

- Electron + Electron Forge 生成 Windows 安装包。
- Renderer 只负责表单和进度展示，不启用 Node.js 集成。
- Preload 暴露最小 IPC 接口；Main 进程负责文件选择、密钥处理和部署执行。
- 部署核心保持为独立 Node.js 模块，GUI 与 CLI 共用，避免两套部署逻辑。
- Main 进程以受控参数调用 Wrangler，不拼接 shell 字符串。
- 所有日志先经过密钥脱敏，再发送给 Renderer。

## 用户流程

1. 环境检查：确认网络、Node/Wrangler 运行条件和 Cloudflare 登录状态；未登录时打开官方授权流程。
2. 基础配置：填写项目英文名、Telegram Bot Token、DeepSeek API Key和 8–32 位配对码。
3. 人格导入：可选择 `.txt`、`.md` 或 `.json`；本地验证格式和安全边界。
4. 模型设置：选择 `deepseek-v4-flash` 或 `deepseek-v4-pro`，并选择是否启用思考模式。默认使用成本更低的 Flash。
5. 部署：逐步显示模板生成、D1、Queue、Vectorize、迁移、Worker、Secrets、Webhook 和健康检查状态。
6. 完成：显示机器人用户名、Worker 地址、生成工程位置及首次 `/pair` 提示。

## 模型配置

- 模型列表使用应用内受控白名单，不允许把任意文本直接写入配置。
- 默认值为 `deepseek-v4-flash`。
- `deepseek-v4-pro` 作为高质量选项。
- 思考模式作为独立布尔设置传给聊天请求；不得通过旧模型别名间接切换。
- 部署摘要在执行前展示最终模型与思考模式。

## 失败与恢复

- 每个部署步骤具有 `pending`、`running`、`succeeded` 或 `failed` 状态。
- 失败时显示脱敏错误、建议操作和“从失败步骤继续”按钮。
- 生成目录包含不含密钥的进度文件；恢复时重新查询云端资源，避免重复创建。
- 用户可取消尚未进入远程变更的步骤；已经创建的云资源不会被自动删除。
- 健康检查或 Webhook 注册失败时保留工程，允许修正后继续。

## 界面范围

- 单窗口、五步向导，不增加账户系统、遥测、自动更新和插件市场。
- 支持浅色/深色系统主题、键盘导航、复制错误摘要和打开生成目录。
- 首版只支持 Windows 10/11 x64。

## 验证标准

- 部署核心单元测试覆盖命名、Prompt 验证、模型白名单、配置生成、脱敏和断点恢复。
- Electron IPC 测试确认 Renderer 无法直接读取密钥或执行任意命令。
- 使用虚构密钥完成 dry-run，并检查生成目录不含秘密值。
- 在测试 Cloudflare 账户进行一次真实全流程部署、健康检查和 Telegram Webhook 验证。
- 构建 Windows 安装包，执行安装、启动、选择自定义安装路径、卸载和残留检查。
- 发布前隐私扫描必须零命中，或每个命中均被人工确认属于通用文档。

## 开源交付

- 新仓库采用 MIT License。
- 提供中文 README、隐私说明、架构说明、贡献指南和 Windows 安装包。
- Git 历史从通用版本开始，不复制私人项目的提交历史。
- GitHub Release 附带安装包、版本号和 SHA-256 校验值。
