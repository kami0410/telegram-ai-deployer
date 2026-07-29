import test from "node:test";
import assert from "node:assert/strict";
import { runDeployment, resumeDeployment } from "../lib/deploy.mjs";

const exampleInput = {
  projectName: "example-bot",
  outputDir: "D:\\Bots\\example-bot",
  telegramToken: "example-telegram-token-that-is-not-valid",
  deepseekKey: "example-deepseek-key-that-is-not-valid",
  pairingCode: "example-1234",
  model: "deepseek-v4-flash",
  thinking: false,
  disclaimerAccepted: true,
};

function fakeDependencies({ failAt = null, existingState = null } = {}) {
  const events = [];
  const states = [];
  const calls = [];
  const methods = {};
  for (const step of [
    "environment", "template", "d1", "queues", "vectorize", "migration",
    "first-deploy", "secrets", "final-deploy", "webhook", "health",
  ]) {
    methods[step] = async () => {
      calls.push(step);
      if (step === failAt) throw new Error("failed-" + step);
      if (step === "d1") return { databaseId: "00000000-0000-0000-0000-000000000000" };
      if (step === "first-deploy" || step === "final-deploy") {
        return { workerUrl: "https://example.invalid" };
      }
      return {};
    };
  }
  return {
    events,
    states,
    calls,
    dependencies: {
      runStep: async (step, context) => methods[step](context),
      emit: (event) => events.push(event),
      readState: async () => existingState,
      writeState: async (state) => states.push(JSON.stringify(state)),
      now: () => "2026-07-29T00:00:00.000Z",
    },
  };
}

test("emits ordered progress and never persists secrets", async () => {
  const fixture = fakeDependencies();
  const result = await runDeployment(exampleInput, fixture.dependencies);
  assert.deepEqual(
    fixture.events.filter((event) => event.status === "succeeded").map((event) => event.step),
    [
      "environment", "template", "d1", "queues", "vectorize", "migration",
      "first-deploy", "secrets", "final-deploy", "webhook", "health",
    ],
  );
  assert.equal(result.workerUrl, "https://example.invalid");
  assert.doesNotMatch(fixture.states.join("\n"), /example-deepseek|example-telegram|example-1234/iu);
});

test("records a recoverable failure without marking the step complete", async () => {
  const fixture = fakeDependencies({ failAt: "vectorize" });
  await assert.rejects(() => runDeployment(exampleInput, fixture.dependencies), /failed-vectorize/u);
  assert.deepEqual(fixture.calls, ["environment", "template", "d1", "queues", "vectorize"]);
  assert.deepEqual(fixture.events.at(-1), {
    step: "vectorize",
    status: "failed",
    message: "Deployment step failed",
    recoverable: true,
  });
});

test("resume skips completed steps but requires freshly supplied secrets", async () => {
  const existingState = {
    version: 1,
    projectName: "example-bot",
    outputDir: "D:\\Bots\\example-bot",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    completedSteps: ["environment", "template", "d1", "queues"],
    resources: {},
    workerUrl: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  const fixture = fakeDependencies({ existingState });
  await resumeDeployment(exampleInput, fixture.dependencies);
  assert.deepEqual(fixture.calls.slice(0, 2), ["vectorize", "migration"]);
  await assert.rejects(
    () => resumeDeployment({ ...exampleInput, telegramToken: "" }, fixture.dependencies),
    /telegram token/iu,
  );
});

test("resume replays secret-dependent tail after an application restart", async () => {
  const existingState = {
    version: 1,
    projectName: "example-bot",
    outputDir: "D:\\Bots\\example-bot",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    completedSteps: [
      "environment", "template", "d1", "queues", "vectorize", "migration",
      "first-deploy", "secrets", "final-deploy",
    ],
    resources: {},
    workerUrl: "https://example.invalid",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  const fixture = fakeDependencies({ existingState });
  await resumeDeployment(exampleInput, fixture.dependencies);
  assert.deepEqual(fixture.calls, ["secrets", "final-deploy", "webhook", "health"]);
});
