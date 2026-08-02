export type DialogueIntent =
  | "safety"
  | "celebrate"
  | "anxiety"
  | "advice"
  | "listen"
  | "gossip"
  | "conflict"
  | "intimacy"
  | "share"
  | "normal";

export type SupportStage =
  | "safety"
  | "celebrate"
  | "validate"
  | "advise"
  | "listen"
  | "clarify"
  | "banter"
  | "respond";

export interface DialogueGuidance {
  intent: DialogueIntent;
  stage: SupportStage;
  confidence: "low" | "medium" | "high";
}

const SAFETY = /(?:自杀|自残|不想活|结束生命|立刻危险)/u;
const CELEBRATE = /(?:终于|成功|通过|上岸|考上|写完|做完|太开心|好开心|中奖了|拿到(?:了)?)/u;
const ADVICE = /(?:你觉得|怎么办|该不该|要不要|应该吗|给我(?:点|个)?建议|帮我分析)/u;
const LISTEN = /(?:先听我|听我说|让我讲完|别给建议|只想说说|陪我聊聊)/u;
const GOSSIP = /(?:八卦|吃瓜|跟你说(?:个|件)|她们班|他们俩|听说)/u;
const CONFLICT = /(?:生气|气死|吵架|针对我|故意|讨厌|过分|凭什么|不理我|骗我)/u;
const INTIMACY = /(?:喜欢我|爱我|想我|特别的人|在一起|暧昧|表白|吃醋)/u;
const ANXIETY = /(?:难受|焦虑|崩溃|害怕|担心|压力|想哭|伤心|痛苦|失眠|紧张)/u;
const SHARE = /(?:今天|刚刚|刚才|我跟你说|我发现|我吃了|我买了|我去了|我看到|刚(?:吃|买|到|看|去|做))/u;
const DISPUTED_FACT = /(?:肯定|绝对|就是故意|一定是|明摆着|毫无疑问|都怪|全是因为)/u;

export function shouldChallengeAgreement(text: string): boolean {
  return DISPUTED_FACT.test(text) && CONFLICT.test(text);
}

export function classifyDialogue(text: string): DialogueGuidance {
  const value = text.trim();
  if (SAFETY.test(value)) return { intent: "safety", stage: "safety", confidence: "high" };
  if (CELEBRATE.test(value)) return { intent: "celebrate", stage: "celebrate", confidence: "high" };
  if (ADVICE.test(value)) return { intent: "advice", stage: "advise", confidence: "high" };
  if (LISTEN.test(value)) return { intent: "listen", stage: "listen", confidence: "high" };
  if (GOSSIP.test(value)) return { intent: "gossip", stage: "banter", confidence: "medium" };
  if (CONFLICT.test(value)) return { intent: "conflict", stage: "validate", confidence: "high" };
  if (INTIMACY.test(value)) return { intent: "intimacy", stage: "clarify", confidence: "medium" };
  if (ANXIETY.test(value)) return { intent: "anxiety", stage: "validate", confidence: "high" };
  if (SHARE.test(value)) return { intent: "share", stage: "respond", confidence: "medium" };
  return { intent: "normal", stage: "respond", confidence: "low" };
}

export function guidanceForDialogue(
  dialogue: DialogueGuidance,
  sourceText = "",
): string {
  const common =
    "不要每次都套用同一种共情顺序；根据上下文自然变化，避免客服式复述和连续追问。";
  const disagreement =
    dialogue.intent === "conflict" || shouldChallengeAgreement(sourceText)
      ? "认可感受不等于确认推测或替用户断定他人动机；可以温和提出另一种可能。"
      : "认可情绪时不要顺带编造或确认未经证实的事实。";
  const strategies: Record<DialogueIntent, string> = {
    safety: "立即、直接、清楚地确认是否正处于危险中，建议联系当地紧急服务、可信任的现实联系人或专业支持；不使用延迟、调情、角色化回避或保密承诺。",
    celebrate: "先跟着开心并追问一个具体细节，不要立刻转成建议或总结。",
    anxiety: "先理解和回应情绪，再问一个必要问题；不要立刻给方案，除非用户明确求建议。",
    advice: "先用一句话确认处境，再讲必要理由并给明确结论，允许继续讨论。",
    listen: "让用户继续讲，短回应表示在听，不抢着分析或给建议。",
    gossip: "轻松接住并追问自然细节，不夸大、造谣或替任何人下结论。",
    conflict: "先接住生气或委屈，再区分已知事实与猜测；需要时直接但不说教。",
    intimacy: "保持 Persona 已有的害羞和回避节奏，不主动升级关系、不机械否认。",
    share: "围绕用户刚分享的具体细节自然回应或追问，不强行升华。",
    normal: "简短自然地接话；信息不足时不要擅自解释成负面情绪或求建议。",
  };
  return `${strategies[dialogue.intent]}${disagreement}${common}`;
}
