import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cô lập hoàn toàn thư mục profile của test vào thư mục tạm (tmpdir)
// Đảm bảo bun test KHÔNG BAO GIỜ chạm hay xóa phiên thật trong data/chatgpt-profile của người dùng
const testProfileDir = mkdtempSync(join(tmpdir(), "chatgpt-test-profile-"));
process.env.CHATGPT_PROFILE_DIR = testProfileDir;

const { checkIsLoggedIn, isSessionCookieValid, sanitizeBrowserLoginStorageState } = await import("./auth-helper.js");
const {
  clearSessionVerified,
  getSessionVerifiedMarkerPath,
  isSessionCached,
  markSessionVerified,
} = await import("./check-session.js");
const { STORAGE_STATE_PATH } = await import("./config.js");

afterAll(() => {
  try {
    rmSync(testProfileDir, { recursive: true, force: true });
  } catch {}
});

describe("auth-helper: isSessionCookieValid", () => {
  test("xác nhận hợp lệ cho __Secure-next-auth.session-token chuẩn", () => {
    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "valid-session-jwt-token-string-that-is-long-enough",
        expires: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toBe(true);
  });

  test("xác nhận hợp lệ cho chunked cookie (.0, .1)", () => {
    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token.0",
        value: "chunked-session-jwt-part-0-long-enough-content",
        expires: 0,
      })
    ).toBe(true);

    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token.1",
        value: "chunked-session-jwt-part-1-long-enough-content",
        expires: -1,
      })
    ).toBe(true);
  });

  test("từ chối cookie rác hoặc cookie tạm của OAuth flow", () => {
    expect(
      isSessionCookieValid({
        name: "login_session",
        value: "temp-login-session-token-value-from-auth-openai-com",
      })
    ).toBe(false);

    expect(
      isSessionCookieValid({
        name: "auth-session-minimized",
        value: "another-temp-token-from-auth-openai-com",
      })
    ).toBe(false);

    expect(
      isSessionCookieValid({
        name: "__cf_bm",
        value: "cloudflare-bot-management-cookie-token",
      })
    ).toBe(false);
  });

  test("từ chối cookie có value quá ngắn, rỗng hoặc là tombstone 'deleted'", () => {
    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "",
      })
    ).toBe(false);

    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "deleted",
      })
    ).toBe(false);

    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "short",
      })
    ).toBe(false);
  });

  test("từ chối cookie đã hết hạn", () => {
    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "expired-session-jwt-token-string-that-is-long-enough",
        expires: Math.floor(Date.now() / 1000) - 100,
      })
    ).toBe(false);
  });
});

describe("check-session: isSessionCached marker logic", () => {
  const markerPath = getSessionVerifiedMarkerPath();

  test("nhận diện đúng marker hợp lệ và từ chối khi thiếu storage-state.json (chống false-positive)", () => {
    const fakeState = {
      cookies: [
        {
          name: "__Secure-next-auth.session-token",
          value: "test-valid-session-jwt-token-from-storage-state-json",
          expires: Math.floor(Date.now() / 1000) + 7200,
          domain: "chatgpt.com",
          path: "/",
        },
      ],
      origins: [],
    };

    try {
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(fakeState), "utf-8");

      // 1. Có cả storage-state.json và marker -> isSessionCached trả về true
      markSessionVerified();
      expect(existsSync(markerPath)).toBe(true);
      expect(isSessionCached()).toBe(true);

      // 2. Clear marker via clearSessionVerified(false) (bảo toàn storage-state.json nhưng isSessionCached = false để diệt Zombie Session)
      clearSessionVerified(false);
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(STORAGE_STATE_PATH)).toBe(true);
      expect(isSessionCached()).toBe(false);

      // 3. Thiếu storage-state.json thì dù có marker cũng dứt khoát trả về false (AUTH-01)
      rmSync(STORAGE_STATE_PATH, { force: true });
      markSessionVerified();
      expect(isSessionCached()).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("isSessionCached yêu cầu cả storage-state.json hợp lệ và marker .session-verified còn hạn", async () => {
    try {
      clearSessionVerified(true);
      expect(isSessionCached()).toBe(false);

      const fakeState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "test-valid-session-jwt-token-from-storage-state-json",
            expires: Math.floor(Date.now() / 1000) + 7200,
            domain: "chatgpt.com",
            path: "/",
          },
        ],
        origins: [],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(fakeState), "utf-8");

      // Nếu chưa có marker xác thực thì isSessionCached() trả về false
      expect(isSessionCached()).toBe(false);

      // Khi có marker xác thực thì isSessionCached() trả về true
      markSessionVerified();
      expect(isSessionCached()).toBe(true);

      // clearSessionVerified(false) gỡ marker: isSessionCached() trả về false (diệt Zombie Session)
      // nhưng storage-state.json vẫn được bảo toàn trên đĩa (không xóa oan khi mạng lag)
      clearSessionVerified(false);
      expect(existsSync(STORAGE_STATE_PATH)).toBe(true);
      expect(existsSync(markerPath)).toBe(false);
      expect(isSessionCached()).toBe(false);

      // clearSessionVerified(true) dứt khoát xóa cả storage-state.json khi reset/logout
      clearSessionVerified(true);
      expect(existsSync(STORAGE_STATE_PATH)).toBe(false);
      expect(isSessionCached()).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("storage-state.json hết hạn token thì gỡ marker verified và trả về false mà không xóa file thụ động kể cả khi có marker 14 ngày", () => {
    try {
      markSessionVerified();
      expect(existsSync(markerPath)).toBe(true);

      const expiredState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "expired-jwt-token-string-value-is-long-enough",
            expires: Math.floor(Date.now() / 1000) - 3600,
            domain: "chatgpt.com",
            path: "/",
          },
        ],
        origins: [],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(expiredState), "utf-8");

      expect(isSessionCached()).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(STORAGE_STATE_PATH)).toBe(true);

      // Khi gọi clearSessionVerified(true) chủ động thì mới xóa file đĩa
      clearSessionVerified(true);
      expect(existsSync(STORAGE_STATE_PATH)).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("AUTH-01: Chống False-Positive tuyệt đối - nếu thiếu storage-state.json thì dứt khoát trả về false dù marker còn hạn", () => {
    try {
      // Đặt marker hợp lệ trong 14 ngày
      markSessionVerified();
      expect(existsSync(markerPath)).toBe(true);

      // Xóa storage-state.json
      if (existsSync(STORAGE_STATE_PATH)) {
        rmSync(STORAGE_STATE_PATH, { force: true });
      }

      // isSessionCached() BẮT BUỘC phải trả về false và xóa marker rác
      expect(isSessionCached()).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });
});

describe("auth-helper: sanitizeBrowserLoginStorageState", () => {
  test("lọc sạch cookies bên thứ 3 và chỉ giữ lại chatgpt.com và openai.com", () => {
    const rawState = {
      cookies: [
        { name: "token1", domain: ".chatgpt.com", value: "val1" },
        { name: "token2", domain: "auth.openai.com", value: "val2" },
        { name: "ads", domain: ".google.com", value: "bad" },
        { name: "tracker", domain: "analytics.twitter.com", value: "bad" },
        { name: "part", domain: "chatgpt.com", value: "part", partitionKey: "something" },
      ],
      origins: [
        {
          origin: "https://chatgpt.com",
          localStorage: [{ name: "theme", value: "dark" }],
        },
        {
          origin: "https://google.com",
          localStorage: [{ name: "g_state", value: "xyz" }],
        },
      ],
    };

    const sanitized = sanitizeBrowserLoginStorageState(rawState);

    expect(sanitized.cookies.length).toBe(2);
    expect(sanitized.cookies.map((c: any) => c.name)).toEqual(["token1", "token2"]);

    expect(sanitized.origins.length).toBe(1);
    expect(sanitized.origins[0].origin).toBe("https://chatgpt.com");
    expect(sanitized.origins[0].localStorage).toEqual([{ name: "theme", value: "dark" }]);
  });
});

describe("auth-helper: checkIsLoggedIn fail-fast", () => {
  test("fail-fast và trả về false trong ~1.2s khi nút đăng nhập xuất hiện liên tục và không có session cookie", async () => {
    const fakePage = {
      isClosed: () => false,
      locator: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
      context: () => ({
        cookies: async () => [],
      }),
    } as any;

    const start = Date.now();
    const result = await checkIsLoggedIn(fakePage);
    const duration = Date.now() - start;

    expect(result).toBe(false);
    expect(duration).toBeLessThan(4000);
    expect(duration).toBeGreaterThanOrEqual(500);
  });
});

