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
  const maximum = flow === "normal" ? 3 : 4;

  // 1. Split into sentence segments. A run of newlines attaches to the following
  //    segment and marks a paragraph boundary, so paragraphs can become bubbles
  //    instead of leaving a long newline-heavy tail in the last bubble.
  const segments: Array<{ text: string; paragraph: boolean }> = [];
  let pendingNewlines = "";
  for (const part of text.match(/[^。！？!?\n]+[。！？!?]*|\n+/gu) ?? [text]) {
    if (/^\n+$/u.test(part)) {
      pendingNewlines += part;
      continue;
    }
    segments.push({
      text: pendingNewlines + part,
      paragraph: pendingNewlines.length > 0,
    });
    pendingNewlines = "";
  }
  if (pendingNewlines.length > 0 && segments.length > 0) {
    segments[segments.length - 1]!.text += pendingNewlines;
  }
  if (segments.length === 0) return [text];

  // 2. Merge until the bubble cap. Prefer pairs that do not cross a paragraph
  //    break and merge from the head, so surplus sentences pile up at the front
  //    and the last bubble stays short. When every pair crosses a paragraph
  //    break, merge the shortest pair so no bubble becomes one long paragraph.
  while (segments.length > maximum) {
    let mergeAt = -1;
    for (let index = 1; index < segments.length; index += 1) {
      if (!segments[index]!.paragraph) {
        mergeAt = index - 1;
        break;
      }
    }
    if (mergeAt === -1) {
      let shortest = Number.POSITIVE_INFINITY;
      for (let index = 1; index < segments.length; index += 1) {
        const length =
          segments[index - 1]!.text.length + segments[index]!.text.length;
        if (length < shortest) {
          shortest = length;
          mergeAt = index - 1;
        }
      }
    }
    const [left, right] = segments.splice(mergeAt, 2);
    segments.splice(mergeAt, 0, {
      text: left!.text + right!.text,
      paragraph: left!.paragraph,
    });
  }

  const bubbles = segments.map((segment) => segment.text);

  // 3. A single oversized run still becomes two bubbles so the last bubble is
  //    not one giant sentence.
  if (bubbles.length === 1 && text.length > 160) {
    const middle = Math.floor(text.length / 2);
    const candidates = [text.lastIndexOf("，", middle), text.lastIndexOf(" ", middle)];
    const splitAt = Math.max(...candidates) + 1;
    if (splitAt > 20 && splitAt < text.length - 20) {
      return [text.slice(0, splitAt), text.slice(splitAt)];
    }
  }
  return bubbles;
}
