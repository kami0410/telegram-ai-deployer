import { validateDeploymentInput } from "./validation.mjs";

export const DEPLOYMENT_STEPS = Object.freeze([
  "environment",
  "template",
  "d1",
  "queues",
  "vectorize",
  "migration",
  "first-deploy",
  "secrets",
  "final-deploy",
  "webhook",
  "health",
]);

function initialState(input, now) {
  return {
    version: 1,
    projectName: input.projectName,
    outputDir: input.outputDir,
    model: input.model,
    thinking: input.thinking,
    completedSteps: [],
    resources: {},
    workerUrl: null,
    updatedAt: now(),
  };
}

function assertMatchingState(input, state) {
  if (
    state.version !== 1
    || state.projectName !== input.projectName
    || state.outputDir !== input.outputDir
    || state.model !== input.model
    || state.thinking !== input.thinking
  ) {
    throw new Error("Saved deployment state does not match the current configuration");
  }
}

async function execute(input, dependencies, existingState) {
  const state = existingState ?? initialState(input, dependencies.now);
  let hasPersistedState = existingState !== null;
  if (existingState !== null) assertMatchingState(input, state);

  for (const step of DEPLOYMENT_STEPS) {
    if (state.completedSteps.includes(step)) continue;
    dependencies.emit({ step, status: "running", message: "Deployment step running", recoverable: false });
    try {
      const result = await dependencies.runStep(step, { input, state: structuredClone(state) }) ?? {};
      if (result.resources !== undefined) Object.assign(state.resources, result.resources);
      if (result.databaseId !== undefined) state.resources.databaseId = result.databaseId;
      if (result.workerUrl !== undefined) state.workerUrl = result.workerUrl;
      state.completedSteps.push(step);
      state.updatedAt = dependencies.now();
      if (step !== "environment") {
        await dependencies.writeState(state);
        hasPersistedState = true;
      }
      dependencies.emit({ step, status: "succeeded", message: "Deployment step completed", recoverable: false });
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      dependencies.emit({
        step,
        status: "failed",
        message: "Deployment step failed: " + reason,
        recoverable: hasPersistedState,
      });
      throw error;
    }
  }
  return structuredClone(state);
}

export async function runDeployment(rawInput, dependencies) {
  const input = validateDeploymentInput(rawInput);
  return execute(input, dependencies, null);
}

export async function resumeDeployment(rawInput, dependencies) {
  const input = validateDeploymentInput(rawInput);
  const savedState = await dependencies.readState(input.outputDir);
  if (savedState === null) throw new Error("No deployment state is available to resume");
  const state = structuredClone(savedState);
  if (
    !state.completedSteps.includes("health")
    && state.completedSteps.includes("secrets")
  ) {
    const secretDependent = new Set(["secrets", "final-deploy", "webhook", "health"]);
    state.completedSteps = state.completedSteps.filter((step) => !secretDependent.has(step));
    dependencies.rotateWebhookSecret?.();
  }
  return execute(input, dependencies, state);
}
