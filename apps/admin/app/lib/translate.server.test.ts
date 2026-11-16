import { beforeEach, describe, expect, it, vi } from "vitest";

// The session: requireAuth refreshes, getAuthenticatedUser reads the access token. No D1.
vi.mock("./auth.server", () => ({
  requireAuth: vi.fn(async () => ({ id: "usr_1", email: "a@example.com", roles: ["Admin"] })),
  getAuthenticatedUser: vi.fn(async () => ({ sessionToken: "s", user: { id: "usr_1" }, tokens: { access: "staff-access-token" } })),
}));
vi.mock("./logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { requireAuth } from "./auth.server";
import { translateEnabled, translateFields, validateTranslate } from "./translate.server";

const env = { VIDEOS_ADMIN_API_URL: "https://admin.api.qa.example/" };
const request = new Request("https://admin.auth.qa.example/api/translate", { method: "POST" });
const body = { from: "en" as const, to: "ar" as const, texts: ["Videos", "Read Surah Al-Fatiha"], field: "clients.name" as const };

/** The admin-api answer (mocked: no real AI anywhere in tests). */
const answer = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));

describe("translate.server", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is off without VIDEOS_ADMIN_API_URL", async () => {
    expect(translateEnabled({})).toBe(false);
    expect(translateEnabled({ VIDEOS_ADMIN_API_URL: "  " })).toBe(false);
    expect(translateEnabled(env)).toBe(true);
    const fetcher = vi.fn();
    expect(await translateFields(request, {}, body, fetcher)).toEqual({ ok: false, status: 404, code: "feature_off" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls admin-api with the staff member's own token and maps items (Quran refused)", async () => {
    const fetcher = answer(200, {
      success: true,
      result: { items: [{ text: "المرئيات", cached: false }, { text: "", refused: "quran", quran: [{ range: "1:1-7", label: "Al-Fatiha" }], cached: false }], provider: "workers-ai" },
    });
    const out = await translateFields(request, env, body, fetcher as unknown as typeof fetch);
    expect(requireAuth).toHaveBeenCalledWith(request, env, true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://admin.api.qa.example/api/translate/fields");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer staff-access-token");
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(out).toEqual({ ok: true, items: [{ text: "المرئيات" }, { text: "", refused: "quran", quran: [{ range: "1:1-7", label: "Al-Fatiha" }] }] });
  });

  it("passes known refusals through and hides the rest as 502", async () => {
    expect(await translateFields(request, env, body, answer(429, { success: false, code: "daily_limit" }) as unknown as typeof fetch)).toEqual({ ok: false, status: 429, code: "daily_limit" });
    expect(await translateFields(request, env, body, answer(403, { success: false, code: "forbidden" }) as unknown as typeof fetch)).toEqual({ ok: false, status: 403, code: "forbidden" });
    expect(await translateFields(request, env, body, answer(500, { oops: 1 }) as unknown as typeof fetch)).toEqual({ ok: false, status: 502, code: "translation_failed" });
    const down = vi.fn(async () => {
      throw new Error("connect failed");
    });
    expect(await translateFields(request, env, body, down as unknown as typeof fetch)).toEqual({ ok: false, status: 503, code: "unavailable" });
  });

  it("a short answer is a failure, never a misaligned fill", async () => {
    const fetcher = answer(200, { success: true, result: { items: [{ text: "x" }] } });
    expect(await translateFields(request, env, body, fetcher as unknown as typeof fetch)).toEqual({ ok: false, status: 502, code: "translation_failed" });
  });

  it("validates like admin-api", () => {
    expect(validateTranslate(body)).toBeNull();
    expect(validateTranslate({ ...body, to: "en" })).toBe("same_language");
    expect(validateTranslate({ ...body, from: "fr" })).toBe("invalid_language");
    expect(validateTranslate({ ...body, field: "users.bio" })).toBe("invalid_field");
    expect(validateTranslate({ ...body, texts: [] })).toBe("too_many_texts");
    expect(validateTranslate({ ...body, texts: Array(51).fill("a") })).toBe("too_many_texts");
    expect(validateTranslate({ ...body, texts: ["a".repeat(5001)] })).toBe("text_too_long");
    expect(validateTranslate({ ...body, texts: Array(5).fill("a".repeat(4500)) })).toBe("too_much_text");
    expect(validateTranslate(null)).toBe("invalid_request");
  });
});
