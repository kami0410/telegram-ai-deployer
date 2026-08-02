import { describe, expect, it } from "vitest";
import { renderTelegramBotAvatar } from "../src/telegram-avatar";

describe("Telegram bot avatar", () => {
  it("streams the current Telegram profile photo without exposing the token", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/getMe")) {
        return Response.json({ ok: true, result: { id: 77 } });
      }
      if (url.includes("/getUserProfilePhotos")) {
        return Response.json({ ok: true, result: { photos: [[
          { file_id: "small", width: 80, height: 80 },
          { file_id: "large", width: 320, height: 320 },
        ]] } });
      }
      if (url.includes("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "photos/avatar.jpg" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    };

    const response = await renderTelegramBotAvatar("123:secret", fetcher);
    const responseForLeakCheck = response.clone();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("max-age=21600");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests).toHaveLength(4);
    expect(new TextDecoder().decode(await responseForLeakCheck.arrayBuffer())).not.toContain("123:secret");
  });

  it("returns a safe SVG fallback when Telegram has no usable photo", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      ok: true,
      result: { id: 77, photos: [] },
    });

    const response = await renderTelegramBotAvatar("123:secret", fetcher);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(body).toContain("<svg");
    expect(body).not.toContain("123:secret");
  });

  it("uses Telegram's public bot portrait when Bot API photos are unavailable", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return Response.json({ ok: true, result: { id: 77, username: "yuan_test_bot" } });
      }
      if (url.includes("/getUserProfilePhotos")) {
        return Response.json({ ok: true, result: { photos: [] } });
      }
      if (url === "https://t.me/i/userpic/320/yuan_test_bot.jpg") {
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await renderTelegramBotAvatar("123:secret", fetcher);

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });
});
