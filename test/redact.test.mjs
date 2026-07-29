import test from "node:test";
import assert from "node:assert/strict";
import { createRedactor } from "../lib/redact.mjs";

test("redacts every occurrence of registered secrets", () => {
  const redact = createRedactor(["example-secret-value", "second-secret-value"]);
  assert.equal(
    redact("failed example-secret-value and second-secret-value/example-secret-value"),
    "failed [REDACTED] and [REDACTED]/[REDACTED]",
  );
});

test("ignores empty values and never mutates non-secret text", () => {
  const redact = createRedactor(["", null, undefined]);
  assert.equal(redact("ordinary deployment message"), "ordinary deployment message");
});
