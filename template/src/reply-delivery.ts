export type DeliveryFlow = "normal" | "comfort" | "conflict" | "safety";

export interface DeliveryRandomSource {
  nextUint32(): number;
}

function randomInteger(
  minimum: number,
  maximum: number,
  random: DeliveryRandomSource,
): number {
  const width = maximum - minimum + 1;
  return minimum + Math.floor((random.nextUint32() / 0x1_0000_0000) * width);
}

export function calculateBubbleGapSeconds(random: DeliveryRandomSource): number {
  return randomInteger(2, 4, random);
}

export function nextBubbleDelaySeconds(
  currentTargetAt: number,
  previousTargetAt: number,
): number {
  return Math.min(4, Math.max(2, currentTargetAt - previousTargetAt));
}

export function replyOutputTokenBudget(
  configured: number,
  flow: DeliveryFlow,
): number {
  const base = Math.max(1, Math.floor(configured));
  if (flow === "safety") return Math.max(base, 220);
  if (flow === "comfort" || flow === "conflict") return Math.max(base, 180);
  return base;
}

export function proactiveOutputTokenBudget(configured: number): number {
  return Math.min(Math.max(1, Math.floor(configured)), 70);
}

export function splitSemanticBubbles(
  text: string,
  flow: DeliveryFlow = "normal",
): string[] {
  if (text.length === 0) return [];
  const rawParts = text.match(/[^。！？!?\n]+[。！？!?]*|\n+/gu) ?? [text];
  const parts: string[] = [];
  for (const part of rawParts) {
    if (part.trim().length === 0 && parts.length > 0) {
      parts[parts.length - 1] = `${parts.at(-1) ?? ""}${part}`;
    } else {
      parts.push(part);
    }
  }
  const maximum = flow === "normal" ? 3 : 4;
  while (parts.length > maximum) {
    const tail = parts.pop();
    if (tail !== undefined) parts[parts.length - 1] = `${parts.at(-1) ?? ""}${tail}`;
  }
  if (parts.length === 1 && text.length > 160) {
    const middle = Math.floor(text.length / 2);
    const candidates = [text.lastIndexOf("，", middle), text.lastIndexOf(" ", middle)];
    const splitAt = Math.max(...candidates) + 1;
    if (splitAt > 20 && splitAt < text.length - 20) {
      return [text.slice(0, splitAt), text.slice(splitAt)];
    }
  }
  return parts;
}
