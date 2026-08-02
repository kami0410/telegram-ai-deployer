export type RecoveryPurpose = "setup" | "recover";

export interface RecoveryPageInput {
  challengeId: string;
  purpose: RecoveryPurpose;
  nonce: string;
}

export interface RenderedRecoveryPage {
  body: string;
  headers: Headers;
}

function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function requireSafeNonce(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("invalid_csp_nonce");
  }
  return value;
}

export function renderRecoveryPage(
  input: RecoveryPageInput,
): RenderedRecoveryPage {
  const nonce = requireSafeNonce(input.nonce);
  const challenge = jsonForScript(input.challengeId);
  const endpoint = jsonForScript(
    input.purpose === "setup"
      ? "/api/recovery/setup"
      : "/api/recovery/complete",
  );
  const successMessage = jsonForScript(
    input.purpose === "setup"
      ? "设置成功。请立即保存恢复钥匙：\n\n"
      : "迁移成功。请立即保存新的恢复钥匙：\n\n",
  );
  const oldKeyField =
    input.purpose === "recover"
      ? '<label for="old-key">恢复钥匙</label><input id="old-key" autocomplete="off" required>'
      : "";

  const body = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Persona 账号恢复</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;background:#fafafa;color:#171717}",
    "main{background:white;border:1px solid #ddd;border-radius:16px;padding:1.5rem;box-shadow:0 8px 30px #0000000d}",
    "label,input,button{display:block;width:100%;box-sizing:border-box}input,button{margin-top:.5rem;padding:.8rem;border-radius:10px;border:1px solid #bbb}button{background:#171717;color:white;cursor:pointer}#result{white-space:pre-wrap;overflow-wrap:anywhere}",
    "</style>",
    "</head>",
    "<body><main>",
    "<h1>Persona 账号恢复</h1>",
    "<p>恢复钥匙不会写入聊天记录。成功后旧钥匙立即失效。</p>",
    '<form id="recovery-form">',
    oldKeyField,
    '<button type="submit">确认并生成新钥匙</button>',
    "</form>",
    '<p id="result" role="status"></p>',
    `<script nonce="${nonce}">`,
    `const challengeId = ${challenge};`,
    `const purpose = ${jsonForScript(input.purpose)};`,
    `const successMessage = ${successMessage};`,
    'const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";',
    "function encodeKey(bytes){let buffer=0,bits=0,body=\"\";for(const byte of bytes){buffer=(buffer<<8)|byte;bits+=8;while(bits>=5){bits-=5;body+=alphabet[(buffer>>bits)&31];buffer&=(1<<bits)-1;}}return \"YR-\"+(body.match(/.{4}/g)||[]).join(\"-\");}",
    "async function sha256(value){const digest=await crypto.subtle.digest(\"SHA-256\",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,\"0\")).join(\"\");}",
    'document.getElementById("recovery-form").addEventListener("submit",async(event)=>{event.preventDefault();const result=document.getElementById("result");result.textContent="正在验证……";const newKey=encodeKey(crypto.getRandomValues(new Uint8Array(10)));const payload={challengeId,newKeyHash:await sha256(newKey)};if(purpose==="recover"){payload.oldKey=document.getElementById("old-key").value;}try{const response=await fetch(' +
      endpoint +
      ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});if(!response.ok){throw new Error("request_failed");}document.getElementById("recovery-form").hidden=true;result.textContent=successMessage+newKey;}catch{result.textContent="验证失败或链接已失效，请重新发起恢复。";}});',
    "</script>",
    "</main></body></html>",
  ].join("\n");

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });

  return { body, headers };
}
