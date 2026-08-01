const NARRATION_CUES = /(?:背景|场景|海边|窗外|夜色|雨声|下雨|风声|阳光|灯光|房间|宿舍|教室|街道|周围|空气|屏幕|手机|镜头|时间流逝|世界|她|女孩|笑了笑|微笑|叹(?:了)?口气|沉默|顿了顿|轻声|小声|抬头|低头|转身|看向|望向|放下|拿起|走到|坐在|站在|靠在|眨眼|点头|摇头|语气|声音|表情|眼神|动作)/u;
const UNSUPPORTED_REALITY_CLAIM = /我(?:刚刚|刚才|今天|现在)(?:去了|到了|买了|吃了|拍了|看见了|遇到了|在(?:宿舍|教室|学校|外面|家里))/u;

/** Removes role-play stage directions while retaining ordinary clarifications. */
export function sanitizePersonaReply(text: string): string {
  const cleaned = text
    .replace(/[（(【[]([^（）()【】\[\]\n]{1,160})[）)】\]]/gu, (match, content: string) =>
      NARRATION_CUES.test(content) ? "" : match)
    .replace(/\*[^*\n]{1,160}\*/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n")
    .filter((line) => !UNSUPPORTED_REALITY_CLAIM.test(line))
    .join("\n")
    .trim();
  return cleaned.length > 0 ? cleaned : "怎么了呀";
}
