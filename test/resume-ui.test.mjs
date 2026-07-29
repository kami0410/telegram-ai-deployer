import test from "node:test";
import assert from "node:assert/strict";
import { applyProgress, createInitialWizardState } from "../app/renderer/form-state.mjs";

test("recoverable failure enables resume and retains completed steps", () => {
  let state = createInitialWizardState();
  state = applyProgress(state, { step: "d1", status: "succeeded", message: "done", recoverable: false });
  state = applyProgress(state, { step: "vectorize", status: "failed", message: "failed", recoverable: true });
  assert.equal(state.recoverable, true);
  assert.deepEqual(state.completedSteps, ["d1"]);
  assert.equal(state.lastMessage, "failed");
});

test("ordinary progress cannot expose arbitrary raw error details", () => {
  const state = applyProgress(createInitialWizardState(), {
    step: "vectorize", status: "failed", message: "Request failed\nraw secret-like stderr", recoverable: true,
  });
  assert.equal(state.lastMessage, "Request failed raw secret-like stderr");
  assert.equal(state.lastMessage.includes("\n"), false);
});
