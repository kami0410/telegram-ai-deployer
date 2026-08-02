const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_JSON_BYTES = 64 * 1024;

const FALLBACK_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#79c7ff"/><stop offset=".55" stop-color="#2588ee"/><stop offset="1" stop-color="#7857e8"/></linearGradient></defs><rect width="64" height="64" rx="20" fill="url(#g)"/><circle cx="25" cy="25" r="15" fill="none" stroke="#fff" stroke-opacity=".78" stroke-width="2"/><circle cx="41" cy="40" r="12" fill="#fff" fill-opacity=".18" stroke="#fff" stroke-opacity=".48"/><path d="M18 37c8 5 17 5 26-2" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="2"/><circle cx="47" cy="16" r="2.5" fill="#fff"/></svg>`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error("telegram_avatar_api_failed");
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_JSON_BYTES) throw new Error("telegram_avatar_response_too_large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error("telegram_avatar_response_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function telegramResult(
  token: string,
  method: string,
  query: URLSearchParams | null,
  fetcher: typeof fetch,
): Promise<unknown> {
  const suffix = query === null ? "" : `?${query.toString()}`;
  const payload = await boundedJson(
    await fetcher(`${TELEGRAM_API_BASE}/bot${token}/${method}${suffix}`),
  );
  if (!record(payload) || payload.ok !== true || !("result" in payload)) {
    throw new Error("telegram_avatar_invalid_response");
  }
  return payload.result;
}

function fallback(): Response {
  return new Response(FALLBACK_AVATAR, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function streamedImage(image: Response): Response | null {
  const contentType = image.headers.get("content-type") ?? "";
  if (!image.ok || image.body === null || !contentType.startsWith("image/")) return null;
  return new Response(image.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=21600, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function renderTelegramBotAvatar(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    const me = await telegramResult(token, "getMe", null, fetcher);
    if (!record(me) || !Number.isSafeInteger(me.id)) throw new Error("telegram_avatar_missing_bot");
    try {
      const photos = await telegramResult(
        token,
        "getUserProfilePhotos",
        new URLSearchParams({ user_id: String(me.id), offset: "0", limit: "1" }),
        fetcher,
      );
      if (!record(photos) || !Array.isArray(photos.photos) || !Array.isArray(photos.photos[0])) {
        throw new Error("telegram_avatar_missing_photo");
      }
      const sizes = photos.photos[0].filter(record);
      const largest = sizes.at(-1);
      if (largest === undefined || typeof largest.file_id !== "string") {
        throw new Error("telegram_avatar_missing_file_id");
      }
      const file = await telegramResult(
        token,
        "getFile",
        new URLSearchParams({ file_id: largest.file_id }),
        fetcher,
      );
      if (!record(file) || typeof file.file_path !== "string" ||
        file.file_path.includes("..") || !/^[A-Za-z0-9_./-]+$/u.test(file.file_path)) {
        throw new Error("telegram_avatar_invalid_file_path");
      }
      const streamed = streamedImage(
        await fetcher(`${TELEGRAM_API_BASE}/file/bot${token}/${file.file_path}`),
      );
      if (streamed !== null) return streamed;
    } catch {
      // Some bot accounts do not expose their own photo through getUserProfilePhotos.
    }
    if (typeof me.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/u.test(me.username)) {
      throw new Error("telegram_avatar_missing_username");
    }
    return streamedImage(
      await fetcher(`https://t.me/i/userpic/320/${encodeURIComponent(me.username)}.jpg`),
    ) ?? fallback();
  } catch {
    return fallback();
  }
}
