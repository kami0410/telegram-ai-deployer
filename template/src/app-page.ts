const APP_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self' https://telegram.org; style-src 'unsafe-inline'; img-src data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Persona 管理面板</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/app.js" defer></script>
  <style>
    :root{color-scheme:light dark;--bg:var(--tg-theme-bg-color,#f5f4f0);--panel:var(--tg-theme-secondary-bg-color,#fff);--text:var(--tg-theme-text-color,#202124);--muted:var(--tg-theme-hint-color,#73777f);--accent:var(--tg-theme-button-color,#3f7cff);--accentText:var(--tg-theme-button-text-color,#fff);--danger:#c33d47;--line:color-mix(in srgb,var(--text) 14%,transparent);font-family:ui-rounded,"SF Pro Rounded","PingFang SC","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);min-height:100vh}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{max-width:760px;margin:auto;padding:20px 16px 92px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.head h1{font-size:24px;margin:0}.sub{color:var(--muted);font-size:13px;margin-top:4px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 8px 26px rgba(0,0,0,.04)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.check{display:flex;align-items:center;gap:9px;color:var(--text);margin:10px 0}.check input{width:auto}.metric strong{display:block;font-size:25px}.metric span,.meta{font-size:13px;color:var(--muted)}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.between{justify-content:space-between}.button{border:0;border-radius:12px;padding:10px 14px;background:var(--accent);color:var(--accentText);font-weight:650}.button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}.button.danger{background:var(--danger);color:#fff}.button.small{padding:7px 10px;font-size:13px}.filters{display:grid;grid-template-columns:1fr auto;gap:8px}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);padding:11px}textarea{min-height:150px;resize:vertical}.item-title{font-weight:700}.item-value{white-space:pre-wrap;margin:8px 0;line-height:1.55}.badge{display:inline-flex;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent);font-size:12px}.empty{text-align:center;color:var(--muted);padding:30px 10px}.view[hidden]{display:none}.error{position:sticky;top:8px;z-index:5;background:#7d2229;color:white;border-radius:12px;padding:10px 12px;margin-bottom:10px}.loading{opacity:.55;pointer-events:none}.nav{position:fixed;left:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(720px,calc(100% - 20px));display:grid;grid-template-columns:repeat(8,1fr);gap:4px;padding:7px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:18px;backdrop-filter:blur(18px);box-shadow:0 10px 30px rgba(0,0,0,.15)}.nav button{border:0;background:transparent;color:var(--muted);padding:9px 3px;border-radius:12px;font-size:11px}.nav button.active{background:var(--accent);color:var(--accentText)}details pre{overflow:auto;max-height:280px;font-size:12px;white-space:pre-wrap}dialog{width:min(620px,calc(100% - 24px));border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--text);padding:18px}dialog::backdrop{background:rgba(0,0,0,.42)}label{display:block;font-size:13px;color:var(--muted);margin:11px 0 5px}@media(min-width:600px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.shell{padding-top:32px}}
  </style>
  <style>
    :root{--glass-bg:color-mix(in srgb,var(--panel) 78%,transparent);--glass-strong:color-mix(in srgb,var(--panel) 90%,transparent);--glass-line:color-mix(in srgb,#fff 52%,var(--line));--surface:color-mix(in srgb,var(--panel) 96%,var(--accent) 4%);--surface-soft:color-mix(in srgb,var(--panel) 91%,var(--accent) 9%);--shadow-soft:0 12px 32px rgba(25,74,140,.10);--shadow-glass:0 18px 54px rgba(14,68,137,.18),inset 0 1px 0 rgba(255,255,255,.55);--radius-xl:28px;--radius-lg:22px;--radius-md:16px;--success:#27a36a;--warning:#f1a433}[hidden]{display:none!important}
    html{background:var(--bg);scroll-behavior:smooth}body{background:radial-gradient(circle at 8% -8%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 38%),radial-gradient(circle at 100% 18%,color-mix(in srgb,#77b8ff 14%,transparent),transparent 32%),var(--bg);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:-.01em}
    button,input,select,textarea{min-height:44px}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 34%,transparent);outline-offset:2px}.shell{max-width:720px;padding:14px 14px calc(118px + env(safe-area-inset-bottom));overflow-x:hidden}.head{margin:0 0 14px}.hero{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;padding:18px;border:1px solid var(--glass-line);border-radius:var(--radius-xl);background:linear-gradient(135deg,color-mix(in srgb,var(--glass-strong) 92%,#fff 8%),color-mix(in srgb,var(--glass-bg) 86%,var(--accent) 14%));box-shadow:var(--shadow-glass);backdrop-filter:blur(24px) saturate(145%);-webkit-backdrop-filter:blur(24px) saturate(145%)}.hero::before{content:"";position:absolute;z-index:-1;width:190px;height:190px;right:-65px;top:-100px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 30%,#fff),transparent 70%);filter:blur(2px)}.hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.34),transparent 32%,transparent 68%,rgba(255,255,255,.12))}.persona-avatar{width:58px;height:58px;border-radius:20px;object-fit:cover;box-shadow:0 10px 24px rgba(20,108,220,.23);flex:none}.hero-copy{min-width:0}.hero-kicker{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;font-weight:650}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 5px color-mix(in srgb,var(--success) 14%,transparent)}.hero h1{margin:4px 0 2px;font-size:25px;line-height:1.08;letter-spacing:-.04em}.hero .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.version-pill{align-self:start;padding:7px 10px;border:1px solid color-mix(in srgb,var(--accent) 20%,transparent);border-radius:999px;background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent);font-size:12px;font-weight:750}
    .secondary-nav{display:flex;gap:7px;overflow-x:auto;padding:2px 2px 10px;scrollbar-width:none}.secondary-nav::-webkit-scrollbar{display:none}.secondary-nav[hidden]{display:none}.secondary-nav button{min-width:max-content;border:1px solid var(--line);border-radius:999px;padding:8px 14px;background:color-mix(in srgb,var(--panel) 84%,transparent);color:var(--muted);font-size:13px;font-weight:650;box-shadow:0 4px 14px rgba(40,70,110,.04)}.secondary-nav button[aria-selected="true"]{border-color:color-mix(in srgb,var(--accent) 24%,transparent);background:color-mix(in srgb,var(--accent) 13%,var(--panel));color:var(--accent)}
    .card{position:relative;margin:10px 0;padding:16px;border:1px solid color-mix(in srgb,var(--text) 10%,transparent);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-soft)}.card h2{font-size:17px;margin:0 0 6px;letter-spacing:-.025em}.grid{gap:10px}.health-card{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:14px;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--success) 10%,var(--surface)),var(--surface))}.health-copy strong{display:block;font-size:19px}.health-copy span{display:block;margin-top:4px;color:var(--muted);font-size:13px}.health-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.health-badge{padding:6px 9px;border-radius:999px;background:color-mix(in srgb,var(--success) 11%,var(--panel));color:color-mix(in srgb,var(--success) 82%,var(--text));font-size:11px;font-weight:700}.metric{min-height:112px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(145deg,var(--surface),var(--surface-soft))}.metric::before{content:"";width:28px;height:4px;border-radius:99px;background:var(--accent);opacity:.76}.metric strong{font-size:30px;line-height:1;letter-spacing:-.05em}.metric span{font-weight:600}.filters{position:sticky;top:8px;z-index:3;padding:9px;border:1px solid var(--glass-line);border-radius:18px;background:var(--glass-strong);box-shadow:0 8px 22px rgba(22,60,110,.08);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}input,select,textarea{border-color:color-mix(in srgb,var(--text) 12%,transparent);background:color-mix(in srgb,var(--panel) 94%,transparent);transition:border-color .18s,box-shadow .18s,background .18s}input:focus,select:focus,textarea:focus{border-color:color-mix(in srgb,var(--accent) 55%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent);background:var(--panel)}.button{min-height:44px;border-radius:14px;padding:10px 15px;box-shadow:0 7px 18px color-mix(in srgb,var(--accent) 22%,transparent);transition:transform .16s,filter .16s,background .16s}.button:active{transform:scale(.975)}.button.ghost{box-shadow:none;background:color-mix(in srgb,var(--panel) 72%,transparent)}.button.danger{box-shadow:0 7px 18px color-mix(in srgb,var(--danger) 18%,transparent)}.button.small{min-height:38px}.badge{font-weight:650;border:1px solid color-mix(in srgb,var(--accent) 14%,transparent)}.item-value{font-size:15px}.row{gap:7px}.between{align-items:flex-start}.empty{margin:12px 0;border:1px dashed color-mix(in srgb,var(--text) 14%,transparent);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--panel) 60%,transparent)}details{border-top:1px solid var(--line);padding:10px 0}details:first-of-type{margin-top:8px}details summary{cursor:pointer;color:var(--text);font-weight:600}.timeline-card{padding-left:30px}.timeline-card::before{content:"";position:absolute;left:13px;top:23px;width:8px;height:8px;border:3px solid color-mix(in srgb,var(--accent) 22%,var(--panel));border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent)}
    .nav{bottom:max(10px,env(safe-area-inset-bottom));grid-template-columns:repeat(4,1fr);gap:4px;padding:7px;width:min(560px,calc(100% - 20px));border:1px solid var(--glass-line);border-radius:24px;background:var(--glass-strong);box-shadow:0 18px 50px rgba(16,49,93,.22),inset 0 1px 0 rgba(255,255,255,.5);backdrop-filter:blur(26px) saturate(150%);-webkit-backdrop-filter:blur(26px) saturate(150%)}.nav button{display:flex;min-height:54px;align-items:center;justify-content:center;gap:5px;flex-direction:column;padding:6px 3px;border-radius:17px;font-size:11px;font-weight:650;transition:transform .18s,background .18s,color .18s}.nav svg{width:21px;height:21px;stroke:currentColor;stroke-width:1.8;fill:none}.nav button.active{background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 92%,#fff),var(--accent));box-shadow:0 8px 20px color-mix(in srgb,var(--accent) 30%,transparent);transform:translateY(-1px)}dialog{border-color:var(--glass-line);border-radius:var(--radius-xl);background:var(--glass-strong);box-shadow:0 30px 90px rgba(9,31,64,.34);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px)}.error,.toast{position:fixed;z-index:20;left:50%;top:max(12px,env(safe-area-inset-top));transform:translateX(-50%);width:min(520px,calc(100% - 28px));padding:12px 14px;border:1px solid color-mix(in srgb,#fff 22%,transparent);border-radius:16px;color:#fff;box-shadow:0 16px 44px rgba(20,35,60,.25);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}.error{background:color-mix(in srgb,var(--danger) 88%,transparent)}.toast{background:color-mix(in srgb,#176bd3 88%,transparent);transition:opacity .18s,transform .18s}.toast.success{background:color-mix(in srgb,var(--success) 90%,transparent)}.toast[hidden]{display:block;opacity:0;pointer-events:none;transform:translate(-50%,-10px)}.skeleton{overflow:hidden;position:relative;color:transparent!important;min-height:86px}.skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.48),transparent);animation:shimmer 1.2s infinite}@keyframes shimmer{to{transform:translateX(100%)}}.view{animation:view-in .2s ease both}@keyframes view-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    .login-screen{min-height:100vh;display:grid;place-items:center;padding:22px}.login-card{width:min(420px,100%);padding:26px;border:1px solid var(--glass-line);border-radius:30px;background:var(--glass-strong);box-shadow:var(--shadow-glass);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px)}.login-head{display:flex;align-items:center;gap:14px}.login-head h1{margin:0;font-size:25px}.login-card .persona-avatar{width:62px;height:62px}.login-card form{margin-top:22px}.login-card .button{width:100%;margin-top:12px}.login-help{margin:12px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.login-error{min-height:20px;margin-top:8px;color:var(--danger);font-size:13px}
    @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.hero,.nav,.filters,dialog,.error,.toast{background:var(--panel)}}
    @media(max-width:520px){.shell{padding-left:11px;padding-right:11px}.hero{grid-template-columns:auto 1fr;padding:15px}.version-pill{display:none}.persona-avatar{width:52px;height:52px;border-radius:18px}.settings-grid{grid-template-columns:1fr}.row .button.small{flex:1}.between{gap:10px}.between>.row{width:100%}.metric{min-height:104px;padding:14px}}
    @media(min-width:600px){.shell{padding-top:20px}.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.view,.button,.nav button,.toast{animation:none!important;transition:none!important}.skeleton::after{animation:none}}
  </style>
</head>
<body>
  <section id="login-screen" class="login-screen"><div class="login-card"><div class="login-head"><img class="persona-avatar" src="/app/avatar" alt="Persona 的 Telegram 头像"><div><h1>进入 Persona</h1><div class="sub">验证已绑定的 Telegram 账号</div></div></div><p class="login-help">本管理面板只在 Telegram 中打开。点击下方按钮，用当前 Telegram 身份验证；只有已绑定本机器人的账号可以进入。</p><button id="telegram-login" class="button" type="button">使用 Telegram 账号验证</button><div id="login-error" class="login-error" role="alert"></div></div></section>
  <main class="shell" id="app" hidden>
    <header class="head hero"><img class="persona-avatar" src="/app/avatar" alt="Persona 的 Telegram 头像"><div class="hero-copy"><div class="hero-kicker"><span class="status-dot"></span>私人空间 · 安全连接</div><h1>Persona</h1><div class="sub">记忆、关系与人格，都在这里</div></div><div id="hero-version" class="version-pill">同步中</div></header>
    <div id="error" class="error" role="alert" hidden></div>
    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    <div class="secondary-nav" data-secondary-group="memory" hidden><button data-secondary="memories" aria-selected="true">长期记忆</button><button data-secondary="episodes" aria-selected="false">情景记忆</button><button data-secondary="recalls" aria-selected="false">召回解释</button><button data-secondary="sources" aria-selected="false">调用来源</button></div>
    <div class="secondary-nav" data-secondary-group="relationship" hidden><button data-secondary="timeline" aria-selected="true">关系时间线</button><button data-secondary="persona" aria-selected="false">人格核心</button><button data-secondary="drafts" aria-selected="false">待确认草稿</button></div>
    <section class="view" data-view="overview"><div id="overview" class="grid"></div><form id="contact-settings" class="card"><h2>主动联系</h2><label class="check"><input id="contact-enabled" type="checkbox">允许 Persona 主动找我</label><div class="settings-grid"><div><label for="contact-min">每天最少</label><select id="contact-min"><option>1</option><option>2</option><option>3</option></select></div><div><label for="contact-max">每天最多</label><select id="contact-max"><option>1</option><option>2</option><option>3</option></select></div><div><label for="quiet-start">免打扰开始（北京时间）</label><input id="quiet-start" type="time"></div><div><label for="quiet-end">免打扰结束（北京时间）</label><input id="quiet-end" type="time"></div></div><label for="pause-until">暂停至（北京时间，可选）</label><input id="pause-until" type="date"><p id="contact-status" class="meta"></p><button class="button" type="submit">保存主动联系设置</button></form><div class="card"><h2>管理说明</h2><p class="meta">这里管理长期记忆、人格历史和待确认草稿，不显示完整聊天记录。删除与回滚都需要确认。</p></div></section>
    <section class="view" data-view="memories" hidden><div class="filters"><input id="memory-search" type="search" placeholder="搜索记忆" aria-label="搜索记忆"><select id="memory-category" aria-label="记忆分类"><option value="">全部分类</option><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select></div><div id="memories"></div><button id="more-memories" class="button ghost" hidden>加载更多</button></section>
    <section class="view" data-view="episodes" hidden><div class="filters"><span></span><select id="episode-category" aria-label="情景分类"><option value="">全部分类</option><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select></div><div id="episodes"></div></section>
    <section class="view" data-view="sources" hidden><div class="card"><h2>记忆调用来源</h2><p class="meta">只显示生成回复时实际放入上下文的记忆，不显示完整聊天原文。</p></div><div id="sources"></div></section>
    <section class="view" data-view="recalls" hidden><div class="card"><h2>记忆召回解释</h2><p class="meta">显示每次回复选中了哪些记忆、排序原因与分项得分；不保存原始提问。</p></div><div id="recalls"></div></section>
    <section class="view" data-view="timeline" hidden><div class="card"><h2>关系时间线</h2><p class="meta">仅展示有用户消息来源的事件、情绪、约定和未完话题。</p></div><div id="timeline"></div></section>
    <section class="view" data-view="persona" hidden><div id="identity-core"></div><div id="persona"></div></section>
    <section class="view" data-view="drafts" hidden><div id="drafts"></div></section>
    <section class="view" data-view="settings" hidden><div id="settings-content"><div class="card"><h2>数据与隐私</h2><p class="meta">导出属于你的 Persona 人格和长期记忆。文件只会下载到当前设备。</p><button id="export" class="button ghost">导出我的数据</button></div><div class="card"><h2>关于这个面板</h2><p class="meta">登录时使用 Telegram 客户端签名的身份验证，不输入、不保存任何密钥。危险操作仍需二次确认。</p><button id="logout" class="button ghost" type="button">退出管理面板</button></div></div></section>
  </main>
  <nav id="app-nav" class="nav" aria-label="底部导航" hidden><button class="active" data-primary="home" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M9 21v-7h6v7"/></svg><span>首页</span></button><button data-primary="memory"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5A4.5 4.5 0 0 0 4.5 9v7A3.5 3.5 0 0 0 8 19.5h4"/><path d="M12 5.5A4.5 4.5 0 0 1 19.5 9v7a3.5 3.5 0 0 1-3.5 3.5h-4M12 5.5v14"/></svg><span>记忆</span></button><button data-primary="relationship"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 8.5c0 5.5-8.5 11-8.5 11s-8.5-5.5-8.5-11A4.5 4.5 0 0 1 12 6.4a4.5 4.5 0 0 1 8.5 2.1Z"/></svg><span>关系</span></button><button data-primary="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg><span>设置</span></button></nav>
  <dialog id="memory-editor"><form method="dialog" id="memory-form"><h2>编辑记忆</h2><input id="memory-id" type="hidden"><input id="memory-updated" type="hidden"><label for="memory-value">内容</label><textarea id="memory-value" maxlength="1000" required></textarea><label for="memory-edit-category">分类</label><select id="memory-edit-category"><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select><label for="memory-confidence">置信度</label><select id="memory-confidence"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select><div class="row" style="margin-top:14px"><button value="cancel" class="button ghost">取消</button><button id="save-memory" value="default" class="button">保存</button></div></form></dialog>
</body>
</html>`;

const SCRIPT = String.raw`(() => {
  "use strict";
  const state = { view: "overview", primary: "home", secondary: { memory: "memories", relationship: "timeline" }, cursor: null, memories: [], memoryConflictId: null, toastTimer: null };
  const byId = (id) => document.getElementById(id);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const errorBox = byId("error");
  const toastBox = byId("toast");
  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }
  function showToast(message, tone = "success") { clearTimeout(state.toastTimer); toastBox.textContent = message; toastBox.className = "toast " + tone; toastBox.hidden = false; state.toastTimer = setTimeout(() => { toastBox.hidden = true; }, 2200); }
  function skeleton(targetId, count = 3) { const root = byId(targetId); if (!root || root.childElementCount) return; root.replaceChildren(...Array.from({ length: count }, () => node("div", "card skeleton", "正在载入"))); }
  async function api(path, options = {}) {
    clearError();
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
    const data = await response.json().catch(() => ({ error: "invalid_response" }));
    if (!response.ok) throw new Error(data.error || "request_failed");
    return data;
  }
  function dateTime(epoch) { return epoch ? new Date(epoch * 1000).toLocaleString("zh-CN") : "—"; }
  function button(text, style, handler) { const value = node("button", "button small " + (style || ""), text); value.type = "button"; value.addEventListener("click", handler); return value; }
  function card() { return node("article", "card"); }
  function minuteText(value) { if (value === null) return ""; return String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0"); }
  function minuteValue(value) { if (!value) return null; const parts = value.split(":").map(Number); return parts[0] * 60 + parts[1]; }
  function beijingDate(epoch) { return epoch ? new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 10) : ""; }
  async function setControl(kind, id, control, reload) { try { await api("/api/app/memory-controls/" + kind + "/" + id, { method: "PATCH", body: JSON.stringify({ control }) }); await reload(); showToast(control === "pinned" ? "已固定" : control === "ignored" ? "已忽略" : "已恢复"); } catch (error) { showError(error.message); } }
  async function loadOverview() {
    const [data, proactive, quality] = await Promise.all([api("/api/app/overview"), api("/api/app/proactive-stats"), api("/api/app/quality-stats")]);
    const root = byId("overview"); root.replaceChildren();
    byId("hero-version").textContent = data.currentPersonaVersion ? "人格 v" + data.currentPersonaVersion : "人格未启用";
    const health = node("article", "card health-card"); const healthCopy = node("div", "health-copy"); healthCopy.append(node("strong", "", "机器人在线"), node("span", "", "Worker、记忆与管理接口运行正常")); const healthBadges = node("div", "health-badges"); [["当前模型", data.runtime.model.replace("deepseek-v4-", "DeepSeek ")], ["记忆系统", data.runtime.memory], ["状态时间", dateTime(data.runtime.checkedAt)]].forEach(([label, value]) => healthBadges.append(node("span", "health-badge", label + " · " + value))); health.append(healthCopy, healthBadges); root.append(health);
    [["人格版本", data.currentPersonaVersion ? "v" + data.currentPersonaVersion : "—"], ["长期记忆", String(data.memoryCount)], ["情景记忆", String(data.episodeCount)], ["待确认草稿", String(data.pendingDraftCount)], ["最近同步", dateTime(data.personaUpdatedAt)]].forEach(([label, value]) => {
      const item = node("div", "card metric"); item.append(node("strong", "", value), node("span", "", label)); root.append(item);
    });
    const sent = proactive.items.filter((item) => item.decision === "send").reduce((sum, item) => sum + item.count, 0); const replied = proactive.items.filter((item) => item.outcome === "replied").reduce((sum, item) => sum + item.count, 0);
    [["7天主动联系", String(sent)], ["收到回复", String(replied)]].forEach(([label, value]) => { const item = node("div", "card metric"); item.append(node("strong", "", value), node("span", "", label)); root.append(item); });
    const qualityCount = quality.items.reduce((sum, item) => sum + item.count, 0); const qualityItem = node("div", "card metric"); qualityItem.append(node("strong", "", String(qualityCount)), node("span", "", "7天质量事件")); root.append(qualityItem);
    await loadContactSettings();
  }
  async function loadContactSettings() {
    const data = await api("/api/app/chat-preferences");
    byId("contact-enabled").checked = data.proactiveEnabled;
    byId("contact-min").value = String(data.dailyMin); byId("contact-max").value = String(data.dailyMax);
    byId("quiet-start").value = minuteText(data.quietStartMinute); byId("quiet-end").value = minuteText(data.quietEndMinute);
    byId("pause-until").value = beijingDate(data.pausedUntil);
    byId("contact-status").textContent = data.consecutiveUnanswered >= 2 ? "连续未回复，已自动降低主动联系频率。" : "默认每天 2–3 次；连续两次未回复会自动降频。";
  }
  function memoryCard(item) {
    const root = card(); const title = node("div", "row between");
    const left = node("div"); left.append(node("span", "badge", item.category + " / " + item.confidence));
    const actions = node("div", "row");
    actions.append(button(item.control === "pinned" ? "取消固定" : "固定", "ghost", () => setControl("fact", item.id, item.control === "pinned" ? "normal" : "pinned", () => loadMemories(true))), button(item.control === "ignored" ? "恢复" : "忽略", "ghost", () => setControl("fact", item.id, item.control === "ignored" ? "normal" : "ignored", () => loadMemories(true))), button("编辑", "ghost", () => openMemory(item)), button("删除", "danger", async () => {
      if (!confirm("确认删除这条长期记忆？此操作不可撤销。")) return;
      try { await api("/api/app/memories/" + item.id, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) }); await loadMemories(true); await loadOverview(); showToast("记忆已删除"); } catch (error) { showError(error.message); }
    }));
    title.append(left, actions); root.append(title, node("p", "item-value", item.factValue), node("div", "meta", "更新于 " + dateTime(item.updatedAt)));
    return root;
  }
  async function loadMemories(reset) {
    if (reset) { state.cursor = null; state.memories = []; }
    const query = new URLSearchParams(); const q = byId("memory-search").value.trim(); const category = byId("memory-category").value;
    if (q) query.set("q", q); if (category) query.set("category", category); if (state.cursor) query.set("cursor", state.cursor);
    const data = await api("/api/app/memories?" + query.toString());
    state.memories = reset ? data.items : state.memories.concat(data.items); state.cursor = data.nextCursor;
    const root = byId("memories"); root.replaceChildren(...state.memories.map(memoryCard));
    if (!state.memories.length) root.append(node("div", "empty", "还没有符合条件的长期记忆"));
    byId("more-memories").hidden = !state.cursor;
  }
  function episodeCard(item) {
    const root = card(); const title = node("div", "row between");
    const episodeActions = node("div", "row"); episodeActions.append(button(item.control === "pinned" ? "取消固定" : "固定", "ghost", () => setControl("episode", item.id, item.control === "pinned" ? "normal" : "pinned", loadEpisodes)), button(item.control === "ignored" ? "恢复" : "忽略", "ghost", () => setControl("episode", item.id, item.control === "ignored" ? "normal" : "ignored", loadEpisodes)), button("删除", "danger", async () => {
      if (!confirm("确认删除这条情景记忆？此操作不可撤销。")) return;
      try { await api("/api/app/episodes/" + item.id, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) }); await loadEpisodes(); showToast("情景记忆已删除"); } catch (error) { showError(error.message); }
    })); title.append(node("span", "badge", item.category), episodeActions);
    const labels = [item.people.length ? "人物：" + item.people.join("、") : "", item.topics.length ? "主题：" + item.topics.join("、") : ""].filter(Boolean).join(" · ");
    root.append(title, node("p", "item-value", item.content), node("div", "meta", [labels, "发生于 " + dateTime(item.occurredAt)].filter(Boolean).join(" · ")));
    return root;
  }
  async function loadEpisodes() {
    const category = byId("episode-category").value; const data = await api("/api/app/episodes" + (category ? "?category=" + encodeURIComponent(category) : ""));
    const root = byId("episodes"); root.replaceChildren(...data.items.map(episodeCard));
    if (!data.items.length) root.append(node("div", "empty", "还没有情景记忆"));
  }
  async function loadSources() {
    const data = await api("/api/app/reply-memory-usage"); const root = byId("sources"); root.replaceChildren();
    data.items.forEach((usage) => { const item = card(); item.append(node("div", "item-title", "回复 #" + usage.assistantMessageId + " · " + usage.intent), node("div", "meta", dateTime(usage.createdAt))); usage.memories.forEach((memory) => { const row = node("div", "row between"); row.append(node("p", "item-value", memory.text), node("span", "badge", (memory.kind === "fact" ? "长期" : "情景") + " / " + memory.control)); item.append(row); }); root.append(item); });
    if (!data.items.length) root.append(node("div", "empty", "还没有可展示的记忆调用记录"));
  }
  async function loadRecalls() {
    const data = await api("/api/app/memory-recalls"); const root = byId("recalls"); root.replaceChildren();
    for (const summary of data.items) {
      const detail = await api("/api/app/memory-recalls/" + summary.id); const item = card();
      item.append(node("div", "item-title", "回复 #" + (summary.assistantMessageId || "—") + " · 选中 " + summary.itemCount + " 条"), node("div", "meta", summary.model + " · 人格 v" + summary.personaVersion + " · " + dateTime(summary.createdAt)));
      detail.items.forEach((memory) => { const explanation = node("details"); explanation.append(node("summary", "item-value", memory.factValue), node("pre", "", JSON.stringify({ channel: memory.channel, total: memory.totalScore, reasons: memory.reasonCodes, components: memory.components }, null, 2))); item.append(explanation); });
      if (!detail.items.length) item.append(node("div", "meta", "本次没有选中长期记忆")); root.append(item);
    }
    if (!data.items.length) root.append(node("div", "empty", "还没有记忆召回记录"));
  }
  async function loadTimeline() {
    const data = await api("/api/app/relationship-timeline"); const root = byId("timeline"); root.replaceChildren();
    data.items.forEach((entry) => { const item = card(); item.classList.add("timeline-card"); const actions = node("div", "row");
      actions.append(button(entry.control === "pinned" ? "取消固定" : "固定", "ghost", async () => { await api("/api/app/relationship-timeline/" + entry.id, { method: "PATCH", body: JSON.stringify({ control: entry.control === "pinned" ? "normal" : "pinned" }) }); await loadTimeline(); }), button(entry.control === "ignored" ? "恢复" : "忽略", "ghost", async () => { await api("/api/app/relationship-timeline/" + entry.id, { method: "PATCH", body: JSON.stringify({ control: entry.control === "ignored" ? "normal" : "ignored" }) }); await loadTimeline(); }), button("纠错", "ghost", async () => { const value = prompt("修改这条有来源的关系记录", entry.value); if (value === null) return; await api("/api/app/relationship-timeline/" + entry.id, { method: "PATCH", body: JSON.stringify({ value }) }); await loadTimeline(); }));
      item.append(node("span", "badge", entry.kind + " / " + entry.status), node("p", "item-value", entry.value), node("div", "meta", "来源消息 #" + entry.sourceMessageId + " · " + dateTime(entry.updatedAt)), actions); root.append(item); });
    if (!data.items.length) root.append(node("div", "empty", "还没有关系时间线记录"));
  }
  function openMemory(item) {
    state.memoryConflictId = null; byId("memory-id").value = String(item.id); byId("memory-updated").value = String(item.updatedAt); byId("memory-value").value = item.factValue; byId("memory-edit-category").value = item.category; byId("memory-confidence").value = item.confidence; byId("memory-editor").showModal();
  }
  async function openMemoryConflict(id) {
    const item = await api("/api/app/memory-conflicts/" + id); state.memoryConflictId = id; byId("memory-id").value = ""; byId("memory-updated").value = ""; byId("memory-value").value = item.candidateFactValue; byId("memory-edit-category").value = item.candidateCategory; byId("memory-confidence").value = item.candidateConfidence; byId("memory-editor").showModal();
  }
  async function loadPersona() {
    const [data, identity] = await Promise.all([api("/api/app/persona"), api("/api/app/identity-core")]); const root = byId("persona"); root.replaceChildren(); const identityRoot = byId("identity-core"); identityRoot.replaceChildren();
    identity.entries.forEach((entry) => { const item = card(); item.append(node("span", "badge", "稳定身份 v" + entry.version), node("p", "item-value", entry.identityKey + "：" + entry.identityValue), button("撤回此条", "ghost", async () => { await api("/api/app/identity-core/" + entry.id + "/revert", { method: "POST", body: "{}" }); await loadPersona(); })); identityRoot.append(item); });
    identity.candidates.forEach((candidate) => { const item = card(); const actions = node("div", "row"); actions.append(button("确认写入", "", async () => { await api("/api/app/identity-core/" + candidate.id + "/confirm", { method: "POST", body: "{}" }); await loadPersona(); }), button("拒绝", "danger", async () => { await api("/api/app/identity-core/" + candidate.id + "/reject", { method: "POST", body: "{}" }); await loadPersona(); })); item.append(node("span", "badge", "身份候选 · " + candidate.evidenceCount + " 条证据"), node("p", "item-value", candidate.identityKey + "：" + candidate.identityValue), actions); identityRoot.append(item); });
    if (!identity.entries.length && !identity.candidates.length) identityRoot.append(node("div", "card meta", "还没有身份核心条目或待确认候选"));
    if (!data.current) { root.append(node("div", "empty", "当前没有人格数据")); return; }
    data.versions.forEach((version) => {
      const item = card(); const heading = node("div", "row between"); heading.append(node("div", "item-title", "v" + version.version + (version.current ? " · 当前" : "")));
      if (!version.current) heading.append(button("回滚到此版本", "ghost", async () => { if (!confirm("将创建一个新版本并采用 v" + version.version + " 的内容，是否继续？")) return; try { await api("/api/app/persona/rollback", { method: "POST", body: JSON.stringify({ targetVersion: version.version }) }); await loadPersona(); await loadOverview(); } catch (error) { showError(error.message); } }));
      const details = node("details"); const summary = node("summary", "meta", version.changeSummary + " · " + dateTime(version.createdAt)); const pre = node("pre", "", JSON.stringify(version.snapshot, null, 2)); details.append(summary, pre); item.append(heading, details); root.append(item);
    });
  }
  function draftCard(item) {
    const root = card(); root.append(node("div", "item-title", item.operation === "addition" ? "人格新增草稿" : "人格修正草稿"), node("p", "item-value", item.summary), node("div", "meta", item.impactScope + " · 到期 " + dateTime(item.expiresAt)));
    const actions = node("div", "row");
    actions.append(button("确认", "", () => draftAction(item, "confirm")), button("重新生成", "ghost", () => draftAction(item, "regenerate")), button("修改", "ghost", async () => {
      const current = JSON.stringify(item.patch, null, 2); const edited = prompt("编辑草稿 JSON（只允许现有白名单路径）", current); if (edited === null) return;
      try { const patch = JSON.parse(edited); await api("/api/app/drafts/" + item.id, { method: "PATCH", body: JSON.stringify({ summary: item.summary, impactScope: item.impactScope, patch }) }); await loadDrafts(); } catch (error) { showError(error.message); }
    }), button("取消", "danger", () => draftAction(item, "cancel")));
    root.append(actions); return root;
  }
  async function draftAction(item, action) {
    if ((action === "confirm" || action === "cancel") && !confirm(action === "confirm" ? "确认让这份人格草稿生效？" : "确认取消这份草稿？")) return;
    try { await api("/api/app/drafts/" + item.id + "/" + action, { method: "POST", body: JSON.stringify({}) }); await loadDrafts(); await loadOverview(); if (action === "confirm") await loadPersona(); } catch (error) { showError(error.message); }
  }
  async function loadDrafts() { const data = await api("/api/app/drafts"); const root = byId("drafts"); root.replaceChildren(...data.items.map(draftCard)); if (!data.items.length) root.append(node("div", "empty", "没有等待确认的人格草稿")); }
  async function showView(name) {
    state.view = name; document.querySelectorAll(".view").forEach((view) => { view.hidden = view.dataset.view !== name; });
    const targetIds = { overview: "overview", memories: "memories", episodes: "episodes", timeline: "timeline", sources: "sources", recalls: "recalls", persona: "persona", drafts: "drafts" };
    if (targetIds[name]) skeleton(targetIds[name], name === "overview" ? 6 : 3);
    try { if (name === "overview") await loadOverview(); if (name === "memories") await loadMemories(true); if (name === "episodes") await loadEpisodes(); if (name === "timeline") await loadTimeline(); if (name === "sources") await loadSources(); if (name === "recalls") await loadRecalls(); if (name === "persona") await loadPersona(); if (name === "drafts") await loadDrafts(); if (name === "settings") await loadContactSettings(); } catch (error) { showError(error.message); }
  }
  async function showSecondary(group, name) {
    state.secondary[group] = name;
    document.querySelectorAll('[data-secondary-group="' + group + '"] [data-secondary]').forEach((item) => item.setAttribute("aria-selected", String(item.dataset.secondary === name)));
    await showView(name);
  }
  async function showPrimary(name) {
    state.primary = name;
    document.querySelectorAll(".nav [data-primary]").forEach((item) => { const active = item.dataset.primary === name; item.classList.toggle("active", active); if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current"); });
    document.querySelectorAll("[data-secondary-group]").forEach((item) => { item.hidden = item.dataset.secondaryGroup !== name; });
    if (name === "home") await showView("overview");
    else if (name === "settings") await showView("settings");
    else await showSecondary(name, state.secondary[name]);
  }
  document.querySelectorAll(".nav [data-primary]").forEach((item) => item.addEventListener("click", () => showPrimary(item.dataset.primary)));
  document.querySelectorAll("[data-secondary-group] [data-secondary]").forEach((item) => item.addEventListener("click", () => showSecondary(item.closest("[data-secondary-group]").dataset.secondaryGroup, item.dataset.secondary)));
  let searchTimer; byId("memory-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMemories(true).catch((error) => showError(error.message)), 250); }); byId("memory-category").addEventListener("change", () => loadMemories(true).catch((error) => showError(error.message))); byId("more-memories").addEventListener("click", () => loadMemories(false).catch((error) => showError(error.message)));
  byId("episode-category").addEventListener("change", () => loadEpisodes().catch((error) => showError(error.message)));
  byId("settings-content").prepend(byId("contact-settings"));
  byId("contact-settings").addEventListener("submit", async (event) => { event.preventDefault(); try { const pause = byId("pause-until").value; await api("/api/app/chat-preferences", { method: "PATCH", body: JSON.stringify({ proactiveEnabled: byId("contact-enabled").checked, dailyMin: Number(byId("contact-min").value), dailyMax: Number(byId("contact-max").value), quietStartMinute: minuteValue(byId("quiet-start").value), quietEndMinute: minuteValue(byId("quiet-end").value), pausedUntil: pause ? Math.floor(Date.parse(pause + "T00:00:00+08:00") / 1000) : null }) }); await loadContactSettings(); showToast("主动联系设置已保存"); } catch (error) { showError(error.message); } });
  byId("memory-form").addEventListener("submit", async (event) => { if (event.submitter && event.submitter.value === "cancel") return; event.preventDefault(); try { const body = { factValue: byId("memory-value").value, category: byId("memory-edit-category").value, confidence: byId("memory-confidence").value }; if (state.memoryConflictId) { await api("/api/app/memory-conflicts/" + state.memoryConflictId, { method: "PATCH", body: JSON.stringify(body) }); state.memoryConflictId = null; } else { await api("/api/app/memories/" + byId("memory-id").value, { method: "PATCH", body: JSON.stringify({ ...body, expectedUpdatedAt: Number(byId("memory-updated").value) }) }); } byId("memory-editor").close(); await loadMemories(true); await loadOverview(); showToast("记忆已保存"); } catch (error) { showError(error.message); } });
  byId("export").addEventListener("click", async () => { try { const response = await fetch("/api/app/export", { credentials: "same-origin" }); if (!response.ok) throw new Error("导出失败"); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "persona-export.json"; link.click(); URL.revokeObjectURL(url); } catch (error) { showError(error.message); } });
  const requestedConflict = location.hash.match(/^#memory-conflict=([0-9a-f-]{36})$/); const requestedDraft = location.hash.match(/^#draft=/); const initialPrimary = requestedConflict ? "memory" : requestedDraft ? "relationship" : "home"; if (requestedConflict) state.secondary.memory = "memories"; if (requestedDraft) state.secondary.relationship = "drafts";
  async function enterApp() { byId("login-screen").hidden = true; byId("app").hidden = false; byId("app-nav").hidden = false; await showPrimary(initialPrimary); if (requestedConflict) await openMemoryConflict(requestedConflict[1]); }
  function telegramInitData() { const webapp = window.Telegram && window.Telegram.WebApp; return webapp ? webapp.initData : ""; }
  async function telegramLogin() {
    const error = byId("login-error");
    const initData = telegramInitData();
    if (!initData) { error.textContent = "请在 Telegram 中打开本页面后重试。"; return; }
    error.textContent = "正在验证……";
    try {
      const response = await fetch("/api/app/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); error.textContent = data.error === "not_bound" ? "当前 Telegram 账号未绑定这个机器人。" : "验证失败，请从 Telegram 重新打开本页面。"; return; }
      error.textContent = "";
      await enterApp();
    } catch { error.textContent = "暂时无法连接，请稍后重试。"; }
  }
  byId("telegram-login").addEventListener("click", telegramLogin);
  byId("logout").addEventListener("click", async () => { await fetch("/api/app/logout", { method: "POST", credentials: "same-origin" }); location.reload(); });
  fetch("/api/app/session", { credentials: "same-origin" }).then((response) => { if (response.ok) return enterApp(); byId("login-screen").hidden = false; if (telegramInitData()) telegramLogin(); }).catch(() => { byId("login-error").textContent = "暂时无法连接，请稍后重试。"; });
})();`;

export function renderAppPage(): Response {
  return new Response(HTML, {
    headers: { ...APP_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

export function renderAppScript(): Response {
  return new Response(SCRIPT, {
    headers: { ...APP_HEADERS, "content-type": "text/javascript; charset=utf-8" },
  });
}
