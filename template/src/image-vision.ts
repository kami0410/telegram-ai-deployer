import { TelegramError } from "./telegram";

const MAX_IMAGE_BYTES = 8 * 1_024 * 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 通过 Telegram getFile 下载图片并以 base64 返回（内存中，不落库）。
 */
export async function fetchTelegramFileBase64(
  token: string,
  fileId: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let fileResponse: Response;
  try {
    fileResponse = await fetcher(
      `https://api.telegram.org/bot${token}/getFile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new TelegramError("network", true);
  }
  const fileBody: unknown = await fileResponse.json().catch(() => null);
  if (
    !isRecord(fileBody) ||
    fileBody.ok !== true ||
    !isRecord(fileBody.result) ||
    typeof fileBody.result.file_path !== "string"
  ) {
    throw new TelegramError("file_path_missing", false);
  }
  let download: Response;
  try {
    download = await fetcher(
      `https://api.telegram.org/file/bot${token}/${fileBody.result.file_path}`,
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new TelegramError("network", true);
  }
  if (!download.ok) throw new TelegramError(`http_${download.status}`, download.status >= 500);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new TelegramError("image_too_large", false);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export interface VisionAi {
  run(model: string, inputs: unknown): Promise<unknown>;
}

/**
 * 调用 Workers AI 视觉模型，把图片转成简短的中文文字描述。
 * 该模型的输入 schema 为 prompt（纯文本）+ image（data URI 字符串）。
 * 失败时抛出异常，由调用方兜底。
 */
export async function describeImage(
  ai: VisionAi | null | undefined,
  model: string,
  base64: string,
): Promise<string> {
  if (ai === null || ai === undefined) throw new Error("vision_unavailable");
  const response = await ai.run(model, {
    prompt:
      "请用一句简短自然的中文描述这张图片的内容，只描述客观事实（人物、场景、物品、文字），不要评价、不要推测意图。",
    image: `data:image/png;base64,${base64}`,
  });
  if (!isRecord(response)) throw new Error("vision_response_invalid");
  const raw =
    typeof response.response === "string"
      ? response.response
      : typeof response.result === "string"
        ? response.result
        : null;
  if (raw === null) throw new Error("vision_response_invalid");
  const description = raw.trim().slice(0, 500);
  if (description.length === 0) throw new Error("vision_response_empty");
  return description;
}
