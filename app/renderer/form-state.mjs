export function createInitialWizardState() {
  return {
    step: 1,
    acceptedDisclaimer: false,
    canDeploy: false,
    running: false,
    recoverable: false,
  };
}

export function consumeDeploymentForm(secretControls, values) {
  const payload = {
    projectName: values.projectName,
    outputDir: values.outputDir,
    personaPath: values.personaPath ?? "",
    model: values.model,
    thinking: values.thinking === true,
    disclaimerAccepted: values.acceptedDisclaimer === true,
    telegramToken: secretControls.telegramToken.value,
    deepseekKey: secretControls.deepseekKey.value,
    pairingCode: secretControls.pairingCode.value,
  };
  secretControls.telegramToken.value = "";
  secretControls.deepseekKey.value = "";
  secretControls.pairingCode.value = "";
  return payload;
}

export function clearPayloadSecrets(payload) {
  for (const key of ["telegramToken", "deepseekKey", "pairingCode"]) payload[key] = "";
}

export function applyProgress(state, event) {
  const completedSteps = [...state.completedSteps ?? []];
  if (event.status === "succeeded" && !completedSteps.includes(event.step)) completedSteps.push(event.step);
  return {
    ...state,
    completedSteps,
    recoverable: event.recoverable === true,
    lastStep: String(event.step ?? ""),
    lastStatus: String(event.status ?? ""),
    lastMessage: String(event.message ?? "").replace(/\s+/gu, " ").trim().slice(0, 2_000),
  };
}

export function validateWizardValues(values) {
  if (!/^[a-z][a-z0-9-]{1,39}$/u.test(values.projectName ?? "")) return "Project name is invalid";
  if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(values.outputDir ?? "")) return "An absolute empty project directory is required";
  if (!["deepseek-v4-flash", "deepseek-v4-pro"].includes(values.model)) return "A supported model is required";
  if ((values.telegramToken ?? "").length < 20 || (values.deepseekKey ?? "").length < 10) return "Telegram and DeepSeek secrets are required";
  if ((values.pairingCode ?? "").length < 8 || values.pairingCode.length > 32) return "The migration key must contain 8-32 characters";
  return "";
}
