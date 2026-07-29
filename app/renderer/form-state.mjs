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
