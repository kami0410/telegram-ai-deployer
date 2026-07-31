# 首次部署故障处理

## 账号首次发布到 workers.dev

如果 `first-deploy` 出现：

`You need to register a workers.dev subdomain before publishing`

这表示 Cloudflare 账号尚未注册 `workers.dev` 公共子域名，不是机器人项目本身的错误。打开 Wrangler 错误中给出的 Cloudflare Dashboard 页面，完成一次子域名注册，然后回到部署器点击「恢复部署」。同一账号只需注册一次。

## health 检查失败

如果 `health` 出现 `fetch failed`，Worker 可能已经部署成功，常见原因是首次发布后的边缘传播、网络代理或临时连接失败。等待几十秒后点击「恢复部署」；也可以在浏览器打开生成的 `https://<worker>.workers.dev/health`，看到 `{"ok":true}` 即表示健康检查通过。

健康检查用于确认 Worker 可从公网访问，不会改变 D1、Queues、Vectorize 或已保存的密钥。若连续失败，请检查代理是否允许访问该 workers.dev 地址。
