const HEADERS = {
  "cache-control": "public, max-age=60",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

interface PageStatus {
  paired: boolean;
  busy: boolean;
  proactive: "enabled" | "paused" | "quiet" | "unknown";
  memoryOk: boolean;
  d1Ms: number | null;
}

function beijingMinute(now: number): number {
  return (Math.floor(now / 60) + 8 * 60) % 1_440;
}

async function collectStatus(env: Env, now: number): Promise<PageStatus> {
  let paired = false;
  let busy = false;
  let proactive: PageStatus["proactive"] = "unknown";
  let memoryOk = false;
  let d1Ms: number | null = null;
  try {
    const owner = await env.DB.prepare(
      "SELECT 1 AS ok FROM owners LIMIT 1",
    ).first<{ ok: number }>();
    paired = owner?.ok === 1;
  } catch {
    // offline: keep default
  }
  try {
    const state = await env.DB.prepare(
      "SELECT busy_until FROM persona_runtime_state LIMIT 1",
    ).first<{ busy_until: number | null }>();
    busy = (state?.busy_until ?? 0) > now;
  } catch {
    // offline: keep default
  }
  try {
    const prefs = await env.DB.prepare(
      `SELECT proactive_enabled, quiet_start_minute, quiet_end_minute, paused_until
       FROM owner_chat_preferences LIMIT 1`,
    ).first<{
      proactive_enabled: number;
      quiet_start_minute: number | null;
      quiet_end_minute: number | null;
      paused_until: number | null;
    }>();
    if (prefs === null) {
      proactive = "enabled";
    } else if (prefs.proactive_enabled !== 1 || (prefs.paused_until ?? 0) > now) {
      proactive = "paused";
    } else if (
      prefs.quiet_start_minute !== null &&
      prefs.quiet_end_minute !== null
    ) {
      const minute = beijingMinute(now);
      const start = prefs.quiet_start_minute;
      const end = prefs.quiet_end_minute;
      const inQuiet = start <= end
        ? minute >= start && minute < end
        : minute >= start || minute < end;
      proactive = inQuiet ? "quiet" : "enabled";
    } else {
      proactive = "enabled";
    }
  } catch {
    // offline: keep default
  }
  try {
    const started = performance.now();
    await env.DB.prepare("SELECT 1").first();
    d1Ms = Math.max(0, Math.round(performance.now() - started));
    memoryOk = true;
  } catch {
    // offline: keep default
  }
  return { paired, busy, proactive, memoryOk, d1Ms };
}

function statusLabels(status: PageStatus): {
  dot: string;
  text: string;
  badge: string;
} {
  if (!status.memoryOk) return { dot: "#f1a433", text: "部分服务不可用", badge: "检查中" };
  if (status.busy) return { dot: "#f1a433", text: "Persona 忙碌中", badge: "稍后回复" };
  return { dot: "#20a66a", text: "Persona 在线", badge: "可正常对话" };
}

function proactiveText(status: PageStatus): string {
  if (status.proactive === "paused") return "已暂停";
  if (status.proactive === "quiet") return "免打扰中";
  if (status.proactive === "enabled") return "已启用";
  return "—";
}

export async function renderPublicPage(
  env: Env,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  const status = await collectStatus(env, now);
  const statusLabel = statusLabels(status);
  const proactive = proactiveText(status);
  const beijing = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(now * 1_000));
  const modelLabel = env.DEEPSEEK_MODEL
    .replace("deepseek-v4-flash", "DeepSeek Flash")
    .replace("deepseek-v4-pro", "DeepSeek Pro");
  const d1Text = status.d1Ms === null ? "—" : `${status.d1Ms} ms`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="Persona · Persona Bot：一个拥有长期记忆、保持边界并尊重隐私的私人 Telegram 聊天机器人。"><meta http-equiv="refresh" content="60"><link rel="icon" href="/app/avatar"><title>Persona · Persona Bot</title><style>
  :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;--bg:#edf5ff;--panel:rgba(255,255,255,.76);--text:#10233f;--muted:#60738d;--blue:#1683f8;--green:#20a66a;--amber:#f1a433;--line:rgba(56,106,168,.13)}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(circle at 12% 0,rgba(52,150,255,.28),transparent 34%),radial-gradient(circle at 92% 20%,rgba(111,85,232,.16),transparent 30%),var(--bg)}main{width:min(900px,calc(100% - 28px));margin:auto;padding:40px 0 48px}.hero,.card{border:1px solid rgba(255,255,255,.75);background:var(--panel);box-shadow:0 22px 70px rgba(30,87,155,.15);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}.hero{display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:center;padding:28px;border-radius:32px}.avatar{width:88px;height:88px;border-radius:28px;object-fit:cover;box-shadow:0 14px 30px rgba(22,131,248,.28)}.status{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:750}.dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 0 6px rgba(32,166,106,.12)}h1{margin:8px 0 4px;font-size:38px;letter-spacing:-.055em}.lead{margin:0;color:var(--muted)}.badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.badge{padding:5px 10px;border-radius:999px;background:rgba(22,131,248,.1);color:var(--blue);font-size:12px;font-weight:700}.h2{display:flex;align-items:center;gap:9px;margin:26px 0 12px;font-size:19px;letter-spacing:-.02em}.h2::before{content:"";width:4px;height:18px;border-radius:99px;background:var(--blue)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{min-height:132px;padding:18px;border-radius:22px}.icon{display:grid;width:36px;height:36px;place-items:center;border-radius:12px;background:rgba(22,131,248,.11);color:var(--blue);font-weight:800}.card strong{display:block;margin:14px 0 6px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:13px;line-height:1.6}.metric{min-height:96px;padding:16px}.metric strong{display:block;font-size:23px;margin:2px 0 4px}.metric span{color:var(--muted);font-size:13px;font-weight:600}.metric p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.wide{grid-column:1/-1}.note{border-left:3px solid rgba(22,131,248,.35);padding:10px 14px;color:var(--muted);font-size:13px;line-height:1.7;background:rgba(22,131,248,.05);border-radius:0 14px 14px 0}.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.step{display:flex;gap:12px;align-items:flex-start}.step-num{display:grid;width:30px;height:30px;flex:none;place-items:center;border-radius:10px;background:rgba(22,131,248,.12);color:var(--blue);font-weight:800;font-size:14px}.step b{display:block;margin-bottom:4px;font-size:14px}.step span{color:var(--muted);font-size:12.5px;line-height:1.6}.cmd-table{width:100%;border-collapse:collapse;font-size:13px}.cmd-table td{padding:8px 10px;border-bottom:1px dashed var(--line);vertical-align:top}.cmd-table td:first-child{white-space:nowrap;font-weight:700;color:var(--blue);font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.cmd-table td:last-child{color:var(--muted);line-height:1.55}.flow{display:flex;flex-direction:column;gap:8px}.flow-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.flow-tag{padding:6px 12px;border-radius:12px;background:rgba(22,131,248,.09);color:var(--blue);font-weight:700;font-size:12.5px}.flow-arrow{color:var(--muted);font-size:13px}.flow-note{color:var(--muted);font-size:12.5px;line-height:1.7}details.faq{border-bottom:1px dashed var(--line)}summary{cursor:pointer;padding:12px 2px;font-weight:700;font-size:14px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px}summary::after{content:"+";color:var(--blue);font-weight:800}details[open] summary::after{content:"–"}details.faq p{margin:0 0 14px;color:var(--muted);font-size:13px;line-height:1.7}details.faq p:first-of-type{margin-top:-4px}.stack{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:22px;color:var(--muted);font-size:13px;flex-wrap:wrap}.button{display:inline-flex;min-height:46px;align-items:center;padding:0 18px;border-radius:15px;background:var(--blue);color:#fff;text-decoration:none;font-weight:750;box-shadow:0 10px 24px rgba(22,131,248,.28)}@media(max-width:700px){main{padding:18px 0 30px}.hero{padding:22px;border-radius:26px}.avatar{width:70px;height:70px;border-radius:22px}h1{font-size:30px}.grid,.steps{grid-template-columns:1fr}.card{min-height:auto}.foot{align-items:flex-start;flex-direction:column}}@media(prefers-color-scheme:dark){:root{--bg:#071220;--panel:rgba(16,34,56,.78);--text:#edf6ff;--muted:#9db0c8;--line:rgba(255,255,255,.1)}.hero,.card{border-color:rgba(255,255,255,.1)}}@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.hero,.card{background:var(--panel)}}
  </style></head><body><main>
  <section class="hero"><img class="avatar" src="/app/avatar" alt="Persona 的 Telegram 头像"><div>
    <span class="status"><span class="dot" style="background:${statusLabel.dot}"></span>${statusLabel.text}</span>
    <h1>Persona Bot</h1><p class="lead">一个拥有长期记忆、保持边界并尊重隐私的私人聊天机器人。</p>
    <div class="badges"><span class="badge">模型 · ${modelLabel}</span><span class="badge">记忆 · D1 + Vectorize</span><span class="badge">每日上限 · ${env.DAILY_MESSAGE_LIMIT} 条</span><span class="badge">${status.paired ? "已就绪" : "等待配对"}</span></div>
  </div></section>

  <div class="h2">当前状态</div>
  <section class="grid">
    <article class="card metric"><span>服务状态</span><strong>${statusLabel.badge}</strong><p>页面每 60 秒自动刷新；健康检查地址 /health。</p></article>
    <article class="card metric"><span>记忆系统</span><strong>${status.memoryOk ? "正常" : "检查中"}</strong><p>数据库响应 ${d1Text}；长期事实、情景记忆与语义检索由 D1 与 Vectorize 支撑。</p></article>
    <article class="card metric"><span>主动联系</span><strong>${proactive}</strong><p>按北京时间调度；可在 Telegram 的 /settings 面板调整。</p></article>
    <article class="card metric"><span>数据安全</span><strong>本地加密备份</strong><p>支持全库加密导出，密码仅由账号所有者保存。</p></article>
  </section>

  <div class="h2">能力</div>
  <section class="grid">
    <article class="card"><span class="icon">AI</span><strong>自然对话</strong><p>按语气分段发送短消息，带自然的输入节奏，偶尔进入短暂忙碌。</p></article>
    <article class="card"><span class="icon">?</span><strong>深度问答 /ask</strong><p>临时启用思考模式的知识问答，不写入人格与记忆。</p></article>
    <article class="card"><span class="icon">∞</span><strong>长期记忆与语义检索</strong><p>只保存你明确说过的稳定事实；语义检索 + 记忆图召回，冲突需你确认。</p></article>
    <article class="card"><span class="icon">◎</span><strong>情景与时间层</strong><p>一次性事件与短期情绪单独存放，话题、周、月与关系脉络分层压缩。</p></article>
    <article class="card"><span class="icon">♟</span><strong>人格系统</strong><p>支持导入人格资料、版本历史、回滚与导出；修正需要你确认后才生效。</p></article>
    <article class="card"><span class="icon">♥</span><strong>关系状态</strong><p>记录有真实来源的情绪、约定与未完话题；可以逐条固定、忽略或纠正。</p></article>
    <article class="card"><span class="icon">✉</span><strong>主动联系</strong><p>默认每天随机联系 2–3 次，可暂停或设置免打扰时段，不打扰时绝不出声。</p></article>
    <article class="card"><span class="icon">⏰</span><strong>提醒与回顾</strong><p>支持自然语言提醒、每周回顾；提醒持久等待，至少送达一次。</p></article>
    <article class="card"><span class="icon">⌘</span><strong>管理面板</strong><p>Telegram 内打开，用绑定账号一键验证；可查看记忆、关系、人格与用量。</p></article>
  </section>

  <div class="h2">开始使用</div>
  <section class="steps">
    <div class="step card"><div class="step-num">1</div><div><b>在 Telegram 打开</b><span>在 Telegram 中找到机器人，点击左下角菜单按钮即可进入管理面板。</span></div></div>
    <div class="step card"><div class="step-num">2</div><div><b>完成配对</b><span>首次部署时在私聊发送 /pair 配对码，绑定唯一使用者。</span></div></div>
    <div class="step card"><div class="step-num">3</div><div><b>开始聊天</b><span>直接发送普通文字即可；/help 查看全部命令。</span></div></div>
  </section>

  <div class="h2">命令速查</div>
  <section class="card wide">
    <table class="cmd-table">
      <tbody>
        <tr><td>/new</td><td>结束当前话题，开始新话题，保留长期记忆与人格。</td></tr>
        <tr><td>/ask &lt;问题&gt;</td><td>临时使用思考模式的知识问答，不写入人格与记忆。</td></tr>
        <tr><td>/memory</td><td>查看最近的结构化长期记忆。</td></tr>
        <tr><td>/settings</td><td>打开管理面板：记忆、关系、人格、主动联系与用量。</td></tr>
        <tr><td>/adjust</td><td>对最近一条回复给出"不像、太黏、太正式、太长"等纠正。</td></tr>
        <tr><td>/persona-add &lt;事实&gt;</td><td>把 Persona 后来明确表达的新事实生成为人格草稿。</td></tr>
        <tr><td>/persona-history</td><td>查看人格版本历史；/persona-rollback &lt;版本&gt; 回滚。</td></tr>
        <tr><td>/remind &lt;时间 内容&gt;</td><td>创建提醒；/reminders 查看，/remind-cancel &lt;编号&gt; 取消。</td></tr>
        <tr><td>/usage</td><td>查看今日 DeepSeek 请求与 token 用量。</td></tr>
        <tr><td>/recovery-key</td><td>设置或轮换恢复密钥；/recover 在换新账号时迁移。</td></tr>
        <tr><td>/forget</td><td>删除当前话题及仅来源于该话题的记忆。</td></tr>
      </tbody>
    </table>
  </section>

  <div class="h2">工作方式</div>
  <section class="card wide">
    <div class="flow">
      <div class="flow-row"><span class="flow-tag">Telegram 消息</span><span class="flow-arrow">→</span><span class="flow-tag">Webhook 校验</span><span class="flow-arrow">→</span><span class="flow-tag">可靠队列</span><span class="flow-arrow">→</span><span class="flow-tag">DeepSeek 生成</span><span class="flow-arrow">→</span><span class="flow-tag">分段回复</span></div>
      <div class="flow-row"><span class="flow-tag">每 15 分钟</span><span class="flow-arrow">→</span><span class="flow-tag">记忆提炼</span><span class="flow-arrow">→</span><span class="flow-tag">D1 存储</span><span class="flow-arrow">→</span><span class="flow-tag">Vectorize 向量化</span></div>
      <p class="flow-note">完整聊天与结构化记忆保存在 D1；Vectorize 只保存向量与记录编号，不保存聊天原文。定时任务负责记忆提炼、主动联系、每周回顾与提醒投递。</p>
    </div>
  </section>

  <div class="h2">隐私与数据</div>
  <section class="grid">
    <article class="card wide"><p class="note">本页是公开状态页：只展示在线状态、模型、记忆能力与隐私说明，不会读取或展示任何聊天内容、记忆统计、Telegram 账号、数据库标识或密钥。聊天数据只通过已绑定的 Telegram 账号访问，并通过加密备份保护。</p></article>
  </section>

  <div class="h2">常见问题</div>
  <section class="card wide">
    <details class="faq"><summary>为什么几分钟没有回复？</summary><p>机器人会模拟输入节奏、分段发送，也可能进入短暂的忙碌状态。先等待，不要连续重复发送同一句。</p></details>
    <details class="faq"><summary>记忆多久更新一次？</summary><p>结构化记忆在积累约 8 轮对话后自动提炼；短时情绪归入情景记忆，长期稳定事实才进入长期记忆。</p></details>
    <details class="faq"><summary>换 Telegram 账号怎么办？</summary><p>在新账号发送 /recover，按提示在 HTTPS 页面完成验证即可迁移，原账号立即失去访问权。</p></details>
    <details class="faq"><summary>数据会丢失吗？</summary><p>聊天与记忆保存在数据库，支持本地加密全库备份；恢复密钥用于账号迁移，备份密码用于灾难恢复。</p></details>
  </section>

  <footer class="foot"><span>状态更新时间（北京时间）：${beijing}</span><a class="button" href="/app">在 Telegram 中打开管理面板</a></footer>
  <div class="stack" style="margin-top:14px"><span class="badge">Cloudflare Workers</span><span class="badge">D1</span><span class="badge">Vectorize</span><span class="badge">Workflows</span><span class="badge">Queues</span><span class="badge">DeepSeek</span></div>
  </main></body></html>`;
  return new Response(html, {
    headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}
