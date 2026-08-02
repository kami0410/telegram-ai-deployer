export type RepairSignalKind = "shorten" | "stop_questions" | "change_topic" | "redo" | "correction";

export interface RepairSignal {
  kind: RepairSignalKind;
  instruction: string;
  expiresAfterSeconds: number;
}

export function detectRepairSignal(input: { text: string; redo?: boolean }): RepairSignal | null {
  const text = input.text.trim();
  if (input.redo === true || /^\/redo(?:\s|$)/iu.test(text)) {
    return { kind: "redo", instruction: "重新回答，不复用刚才的结构或开场；只保留有用信息。", expiresAfterSeconds: 3_600 };
  }
  if (/(?:太长(?:了)?|短一点|少一点|精简(?:一点)?|别说这么多)/u.test(text)) {
    return { kind: "shorten", instruction: "接下来用更短的自然口语，不解释为什么缩短。", expiresAfterSeconds: 3_600 };
  }
  if (/(?:别问了|不要再问|别追问)/u.test(text)) {
    return { kind: "stop_questions", instruction: "停止追问，回应当前内容后自然收住。", expiresAfterSeconds: 3_600 };
  }
  if (/(?:换个话题|不说这个了|聊点别的)/u.test(text)) {
    return { kind: "change_topic", instruction: "立即结束原话题，顺着用户的新方向回应，不追问原因。", expiresAfterSeconds: 3_600 };
  }
  if (/^(?:不是|不对|你记错了|我的意思是|我说的是)[，,：:\s]/u.test(text)) {
    return { kind: "correction", instruction: "简短承认误解并按用户刚给出的事实改口，不辩解系统过程。", expiresAfterSeconds: 3_600 };
  }
  return null;
}
