import { clearPayloadSecrets, consumeDeploymentForm, validateWizardValues } from "./form-state.mjs";

const api = window.deployer;
const form = document.querySelector("#wizard");
const sections = [...document.querySelectorAll("[data-step]")];
const indicators = [...document.querySelectorAll("[data-step-indicator]")];
const secrets = {
  telegramToken: document.querySelector("#telegramToken"),
  deepseekKey: document.querySelector("#deepseekKey"),
  pairingCode: document.querySelector("#pairingCode"),
};
let currentStep = 1;
let personaPath = "";
let outputDir = "";
let running = false;
let resumeMode = false;
let canResume = false;

function showStep(step) {
  currentStep = Math.max(1, Math.min(5, step));
  for (const section of sections) section.hidden = Number(section.dataset.step) !== currentStep;
  for (const indicator of indicators) {
    const active = Number(indicator.dataset.stepIndicator) === currentStep;
    if (active) indicator.setAttribute("aria-current", "step");
    else indicator.removeAttribute("aria-current");
  }
}

function values() {
  return {
    projectName: document.querySelector("#projectName").value.trim(),
    outputDir: document.querySelector("#outputDir").value.trim(),
    personaPath,
    model: document.querySelector('input[name="model"]:checked').value,
    acceptedDisclaimer: document.querySelector("#acceptDisclaimer").checked,
  };
}

function renderSummary() {
  const value = values();
  const rows = [
    ["项目", value.projectName || "—"], ["目录", value.outputDir || "—"],
    ["人格", personaPath || "通用人格"], ["模型", value.model],
  ];
  const summary = document.querySelector("#summary");
  summary.replaceChildren(...rows.flatMap(([term, description]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = description;
    return [dt, dd];
  }));
}

for (const button of document.querySelectorAll(".next")) button.addEventListener("click", () => {
  if (currentStep === 3) {
    const error = validateWizardValues({
      ...values(),
      telegramToken: secrets.telegramToken.value,
      deepseekKey: secrets.deepseekKey.value,
      pairingCode: secrets.pairingCode.value,
    });
    document.querySelector("#configError").textContent = error;
    if (error) return;
    renderSummary();
  }
  showStep(currentStep + 1);
});
for (const button of document.querySelectorAll(".back")) button.addEventListener("click", () => showStep(currentStep - 1));

document.querySelector("#checkEnvironment").addEventListener("click", async () => {
  const status = document.querySelector("#environmentStatus");
  status.textContent = "正在检查…";
  try { const result = await api.checkEnvironment(); status.textContent = result.message; status.dataset.ready = String(result.ready); }
  catch { status.textContent = "连接失败，请检查网络后重试 Cloudflare 授权"; }
});

document.querySelector("#selectPersona").addEventListener("click", async () => {
  const selected = await api.selectPersona();
  if (selected) { personaPath = selected.path; document.querySelector("#personaPath").value = selected.name; }
});

document.querySelector("#acceptDisclaimer").addEventListener("change", (event) => {
  document.querySelector("#deploy").disabled = !event.target.checked;
});

api.onProgress((event) => {
  const item = document.createElement("li");
  item.dataset.status = event.status;
  item.textContent = `${event.step}: ${event.message}`;
  document.querySelector("#progress").append(item);
  document.querySelector("#deploymentStatus").textContent = event.status === "failed" ? "部署中断，可重新输入密钥后恢复" : "部署进行中";
  if (event.step === "log") document.querySelector("#log").textContent += `${event.message}\n`;
  if (event.status === "failed") {
    canResume = event.recoverable === true;
    const action = document.querySelector("#resume");
    action.disabled = false;
    action.textContent = canResume ? "恢复部署" : "返回修改";
  }
});

api.onUpdateStatus((status) => {
  const target = document.querySelector("#updateStatus");
  if (target && typeof status?.message === "string") target.textContent = status.message;
});

async function submit(resume = false) {
  if (running) return;
  const payload = consumeDeploymentForm(secrets, values());
  if (!resume) canResume = false;
  outputDir = payload.outputDir;
  running = true;
  showStep(5);
  document.querySelector("#deploymentStatus").textContent = resume ? "正在恢复部署…" : "正在部署…";
  try {
    const response = resume ? await api.resume(payload) : await api.start(payload);
    document.querySelector("#deploymentStatus").textContent = `部署完成：${response.result.workerUrl ?? "Cloudflare Worker 已创建"}`;
    document.querySelector("#deploymentStatus").textContent += "；首次使用请发送 /pair <配对/迁移密钥>";
    document.querySelector("#openOutput").disabled = false;
    document.querySelector("#resume").disabled = true;
    resumeMode = false;
  } catch {
    document.querySelector("#deploymentStatus").textContent = canResume
      ? "部署未完成。日志已脱敏，可重新填写密钥后恢复。"
      : "部署尚未建立恢复点，请返回修改后重新开始。";
    const action = document.querySelector("#resume");
    action.disabled = false;
    action.textContent = canResume ? "恢复部署" : "返回修改";
  } finally {
    clearPayloadSecrets(payload);
    running = false;
  }
}

form.addEventListener("submit", (event) => { event.preventDefault(); void submit(resumeMode); });
document.querySelector("#resume").addEventListener("click", () => { resumeMode = canResume; showStep(3); });
document.querySelector("#openOutput").addEventListener("click", () => { if (outputDir) void api.openOutputFolder(outputDir); });

const notice = document.querySelector("#notice");
for (const button of document.querySelectorAll("[data-disclaimer-button]")) button.addEventListener("click", async () => {
  document.querySelector("#noticeText").textContent = await api.readDisclaimer("zh");
  notice.showModal();
});
document.querySelector("#closeNotice").addEventListener("click", () => notice.close());
