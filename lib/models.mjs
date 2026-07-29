export const MODELS = Object.freeze([
  Object.freeze({
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Lower cost and faster responses",
    recommended: true,
  }),
  Object.freeze({
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Higher quality with higher API cost",
    recommended: false,
  }),
]);

export function normalizeModelSelection({ model, thinking }) {
  if (!MODELS.some((candidate) => candidate.id === model)) {
    throw new Error("Unsupported model");
  }
  if (typeof thinking !== "boolean") {
    throw new Error("Thinking must be a boolean");
  }
  return { model, thinking: thinking ? "enabled" : "disabled" };
}
