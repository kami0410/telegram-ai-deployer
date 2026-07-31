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
  <title>Persona Bot 管理面板</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/app.js" defer></script>
  <style>
    :root{color-scheme:light dark;--bg:var(--tg-theme-bg-color,#f5f4f0);--panel:var(--tg-theme-secondary-bg-color,#fff);--text:var(--tg-theme-text-color,#202124);--muted:var(--tg-theme-hint-color,#73777f);--accent:var(--tg-theme-button-color,#3f7cff);--accentText:var(--tg-theme-button-text-color,#fff);--danger:#c33d47;--line:color-mix(in srgb,var(--text) 14%,transparent);font-family:ui-rounded,"SF Pro Rounded","PingFang SC","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);min-height:100vh}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{max-width:760px;margin:auto;padding:20px 16px 92px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.head h1{font-size:24px;margin:0}.sub{color:var(--muted);font-size:13px;margin-top:4px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 8px 26px rgba(0,0,0,.04)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric strong{display:block;font-size:25px}.metric span,.meta{font-size:13px;color:var(--muted)}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.between{justify-content:space-between}.button{border:0;border-radius:12px;padding:10px 14px;background:var(--accent);color:var(--accentText);font-weight:650}.button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}.button.danger{background:var(--danger);color:#fff}.button.small{padding:7px 10px;font-size:13px}.filters{display:grid;grid-template-columns:1fr auto;gap:8px}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);padding:11px}textarea{min-height:150px;resize:vertical}.item-title{font-weight:700}.item-value{white-space:pre-wrap;margin:8px 0;line-height:1.55}.badge{display:inline-flex;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent);font-size:12px}.empty{text-align:center;color:var(--muted);padding:30px 10px}.view[hidden]{display:none}.error{position:sticky;top:8px;z-index:5;background:#7d2229;color:white;border-radius:12px;padding:10px 12px;margin-bottom:10px}.loading{opacity:.55;pointer-events:none}.nav{position:fixed;left:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(720px,calc(100% - 20px));display:grid;grid-template-columns:repeat(5,1fr);gap:5px;padding:7px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:18px;backdrop-filter:blur(18px);box-shadow:0 10px 30px rgba(0,0,0,.15)}.nav button{border:0;background:transparent;color:var(--muted);padding:9px 4px;border-radius:12px;font-size:13px}.nav button.active{background:var(--accent);color:var(--accentText)}details pre{overflow:auto;max-height:280px;font-size:12px;white-space:pre-wrap}dialog{width:min(620px,calc(100% - 24px));border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--text);padding:18px}dialog::backdrop{background:rgba(0,0,0,.42)}label{display:block;font-size:13px;color:var(--muted);margin:11px 0 5px}@media(min-width:600px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.shell{padding-top:32px}}
  </style>
</head>
<body>
  <main class="shell" id="app">
    <div class="head"><div><h1>Persona Bot 管理面板</h1><div class="sub">只对当前绑定账号开放</div></div><button id="export" class="button ghost small">导出</button></div>
    <div id="error" class="error" role="alert" hidden></div>
    <section class="view" data-view="overview"><div id="overview" class="grid"></div><div class="card"><h2>管理说明</h2><p class="meta">这里管理长期记忆、人格历史和待确认草稿，不显示完整聊天记录。删除与回滚都需要确认。</p></div></section>
    <section class="view" data-view="memories" hidden><div class="filters"><input id="memory-search" type="search" placeholder="搜索记忆" aria-label="搜索记忆"><select id="memory-category" aria-label="记忆分类"><option value="">全部分类</option><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select></div><div id="memories"></div><button id="more-memories" class="button ghost" hidden>加载更多</button></section>
    <section class="view" data-view="episodes" hidden><div class="filters"><span></span><select id="episode-category" aria-label="情景分类"><option value="">全部分类</option><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select></div><div id="episodes"></div></section>
    <section class="view" data-view="persona" hidden><div id="persona"></div></section>
    <section class="view" data-view="drafts" hidden><div id="drafts"></div></section>
  </main>
  <nav class="nav" aria-label="管理区域"><button class="active" data-target="overview">概览</button><button data-target="memories">记忆</button><button data-target="episodes">情景</button><button data-target="persona">人格</button><button data-target="drafts">草稿</button></nav>
  <dialog id="memory-editor"><form method="dialog" id="memory-form"><h2>编辑记忆</h2><input id="memory-id" type="hidden"><input id="memory-updated" type="hidden"><label for="memory-value">内容</label><textarea id="memory-value" maxlength="1000" required></textarea><label for="memory-edit-category">分类</label><select id="memory-edit-category"><option>identity</option><option>preference</option><option>relationship</option><option>goal</option><option>routine</option><option>wellbeing</option><option>study</option><option>interest</option></select><label for="memory-confidence">置信度</label><select id="memory-confidence"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select><div class="row" style="margin-top:14px"><button value="cancel" class="button ghost">取消</button><button id="save-memory" value="default" class="button">保存</button></div></form></dialog>
</body>
</html>`;

const SCRIPT = String.raw`(() => {
  "use strict";
  const webApp = window.Telegram && window.Telegram.WebApp;
  if (webApp) { webApp.ready(); webApp.expand(); }
  const initData = webApp ? Telegram.WebApp.initData : "";
  const state = { view: "overview", cursor: null, memories: [], memoryConflictId: null };
  const byId = (id) => document.getElementById(id);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const errorBox = byId("error");
  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }
  async function api(path, options = {}) {
    clearError();
    const headers = new Headers(options.headers || {});
    headers.set("telegram-init-data", initData);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({ error: "invalid_response" }));
    if (!response.ok) throw new Error(data.error || "request_failed");
    return data;
  }
  function dateTime(epoch) { return epoch ? new Date(epoch * 1000).toLocaleString("zh-CN") : "—"; }
  function button(text, style, handler) { const value = node("button", "button small " + (style || ""), text); value.type = "button"; value.addEventListener("click", handler); return value; }
  function card() { return node("article", "card"); }
  async function loadOverview() {
    const data = await api("/api/app/overview");
    const root = byId("overview"); root.replaceChildren();
    [["人格版本", data.currentPersonaVersion ? "v" + data.currentPersonaVersion : "—"], ["长期记忆", String(data.memoryCount)], ["待确认草稿", String(data.pendingDraftCount)], ["最近变更", dateTime(data.personaUpdatedAt)]].forEach(([label, value]) => {
      const item = node("div", "card metric"); item.append(node("strong", "", value), node("span", "", label)); root.append(item);
    });
  }
  function memoryCard(item) {
    const root = card(); const title = node("div", "row between");
    const left = node("div"); left.append(node("span", "badge", item.category + " / " + item.confidence));
    const actions = node("div", "row");
    actions.append(button("编辑", "ghost", () => openMemory(item)), button("删除", "danger", async () => {
      if (!confirm("确认删除这条长期记忆？此操作不可撤销。")) return;
      try { await api("/api/app/memories/" + item.id, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) }); await loadMemories(true); await loadOverview(); } catch (error) { showError(error.message); }
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
    title.append(node("span", "badge", item.category), button("删除", "danger", async () => {
      if (!confirm("确认删除这条情景记忆？此操作不可撤销。")) return;
      try { await api("/api/app/episodes/" + item.id, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) }); await loadEpisodes(); } catch (error) { showError(error.message); }
    }));
    const labels = [item.people.length ? "人物：" + item.people.join("、") : "", item.topics.length ? "主题：" + item.topics.join("、") : ""].filter(Boolean).join(" · ");
    root.append(title, node("p", "item-value", item.content), node("div", "meta", [labels, "发生于 " + dateTime(item.occurredAt)].filter(Boolean).join(" · ")));
    return root;
  }
  async function loadEpisodes() {
    const category = byId("episode-category").value; const data = await api("/api/app/episodes" + (category ? "?category=" + encodeURIComponent(category) : ""));
    const root = byId("episodes"); root.replaceChildren(...data.items.map(episodeCard));
    if (!data.items.length) root.append(node("div", "empty", "还没有情景记忆"));
  }
  function openMemory(item) {
    state.memoryConflictId = null; byId("memory-id").value = String(item.id); byId("memory-updated").value = String(item.updatedAt); byId("memory-value").value = item.factValue; byId("memory-edit-category").value = item.category; byId("memory-confidence").value = item.confidence; byId("memory-editor").showModal();
  }
  async function openMemoryConflict(id) {
    const item = await api("/api/app/memory-conflicts/" + id); state.memoryConflictId = id; byId("memory-id").value = ""; byId("memory-updated").value = ""; byId("memory-value").value = item.candidateFactValue; byId("memory-edit-category").value = item.candidateCategory; byId("memory-confidence").value = item.candidateConfidence; byId("memory-editor").showModal();
  }
  async function loadPersona() {
    const data = await api("/api/app/persona"); const root = byId("persona"); root.replaceChildren();
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
    state.view = name; document.querySelectorAll(".view").forEach((view) => { view.hidden = view.dataset.view !== name; }); document.querySelectorAll(".nav button").forEach((item) => item.classList.toggle("active", item.dataset.target === name));
    try { if (!initData) throw new Error("请从 Telegram 机器人中打开管理面板"); if (name === "overview") await loadOverview(); if (name === "memories") await loadMemories(true); if (name === "episodes") await loadEpisodes(); if (name === "persona") await loadPersona(); if (name === "drafts") await loadDrafts(); } catch (error) { showError(error.message); }
  }
  document.querySelectorAll(".nav button").forEach((item) => item.addEventListener("click", () => showView(item.dataset.target)));
  let searchTimer; byId("memory-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMemories(true).catch((error) => showError(error.message)), 250); }); byId("memory-category").addEventListener("change", () => loadMemories(true).catch((error) => showError(error.message))); byId("more-memories").addEventListener("click", () => loadMemories(false).catch((error) => showError(error.message)));
  byId("episode-category").addEventListener("change", () => loadEpisodes().catch((error) => showError(error.message)));
  byId("memory-form").addEventListener("submit", async (event) => { if (event.submitter && event.submitter.value === "cancel") return; event.preventDefault(); try { const body = { factValue: byId("memory-value").value, category: byId("memory-edit-category").value, confidence: byId("memory-confidence").value }; if (state.memoryConflictId) { await api("/api/app/memory-conflicts/" + state.memoryConflictId, { method: "PATCH", body: JSON.stringify(body) }); state.memoryConflictId = null; } else { await api("/api/app/memories/" + byId("memory-id").value, { method: "PATCH", body: JSON.stringify({ ...body, expectedUpdatedAt: Number(byId("memory-updated").value) }) }); } byId("memory-editor").close(); await loadMemories(true); await loadOverview(); } catch (error) { showError(error.message); } });
  byId("export").addEventListener("click", async () => { try { const response = await fetch("/api/app/export", { headers: { "telegram-init-data": initData } }); if (!response.ok) throw new Error("导出失败"); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "persona-export.json"; link.click(); URL.revokeObjectURL(url); } catch (error) { showError(error.message); } });
  const requestedConflict = location.hash.match(/^#memory-conflict=([0-9a-f-]{36})$/); const requestedDraft = location.hash.match(/^#draft=/); showView(requestedConflict ? "memories" : requestedDraft ? "drafts" : "overview").then(() => { if (requestedConflict) return openMemoryConflict(requestedConflict[1]); }).catch((error) => showError(error.message));
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
