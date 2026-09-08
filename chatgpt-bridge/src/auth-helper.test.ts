import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cô lập hoàn toàn thư mục profile của test vào thư mục tạm (tmpdir)
// Đảm bảo bun test KHÔNG BAO GIỜ chạm hay xóa phiên thật trong data/chatgpt-profile của người dùng
const testProfileDir = mkdtempSync(join(tmpdir(), "chatgpt-test-profile-"));
process.env.CHATGPT_PROFILE_DIR = testProfileDir;

const {
  allowedAuthUrl,
  allowedLoginStorageHost,
  checkIsLoggedIn,
  checkSessionEndpoint,
  dismissChatGptModalsAndOnboarding,
  isSessionCookieValid,
  sanitizeBrowserLoginStorageState,
  saveSanitizedStorageState,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
} = await import("./auth-helper.js");
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

  test("từ chối cookie sắp hết hạn trong vòng 30s (leeway buffer chống chết giữa turn)", () => {
    expect(
      isSessionCookieValid({
        name: "__Secure-next-auth.session-token",
        value: "almost-expired-session-jwt-token-string-that-is-long-enough",
        expires: Math.floor(Date.now() / 1000) + 10,
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
      url: () => "https://chatgpt.com/",
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

  test("fail-fast lập tức (<50ms) khi trang bị redirect về auth/login", async () => {
    const fakePage = {
      isClosed: () => false,
      url: () => "https://chatgpt.com/auth/login",
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
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
    expect(duration).toBeLessThan(100);
  });
});

describe("auth-helper: allowedLoginStorageHost & allowedAuthUrl", () => {
  test("allowedLoginStorageHost chỉ chấp nhận chatgpt.com và openai.com chuẩn chỉ", () => {
    expect(allowedLoginStorageHost("chatgpt.com")).toBe(true);
    expect(allowedLoginStorageHost("sub.chatgpt.com")).toBe(true);
    expect(allowedLoginStorageHost("openai.com")).toBe(true);
    expect(allowedLoginStorageHost("auth.openai.com")).toBe(true);

    // Hostname không được có leading dot (phải được strip trước khi validate host)
    expect(allowedLoginStorageHost(".chatgpt.com")).toBe(false);

    // Bác bỏ domain giả mạo hoặc chứa ký tự độc hại
    expect(allowedLoginStorageHost("notchatgpt.com")).toBe(false);
    expect(allowedLoginStorageHost("chatgpt.com.attacker.com")).toBe(false);
    expect(allowedLoginStorageHost("user:pass@chatgpt.com")).toBe(false);
    expect(allowedLoginStorageHost("chatgpt.com/path")).toBe(false);
    expect(allowedLoginStorageHost("..chatgpt.com")).toBe(false);
    expect(allowedLoginStorageHost("google.com")).toBe(false);
  });

  test("allowedAuthUrl chỉ chấp nhận các OAuth Provider chính chủ và URL auth chuẩn", () => {
    expect(allowedAuthUrl("https://chatgpt.com/auth/login")).toBe(true);
    expect(allowedAuthUrl("https://chatgpt.com/auth")).toBe(true);
    expect(allowedAuthUrl("https://chatgpt.com/login")).toBe(true);
    expect(allowedAuthUrl("https://auth.openai.com/oauth/token")).toBe(true);
    expect(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(allowedAuthUrl("https://accounts.google.com.vn/accounts/SetSID")).toBe(true);
    expect(allowedAuthUrl("https://login.microsoftonline.com/common/oauth2")).toBe(true);
    expect(allowedAuthUrl("https://appleid.apple.com/auth/authorize")).toBe(true);

    // Bác bỏ http hoặc domain bên ngoài
    expect(allowedAuthUrl("http://chatgpt.com/auth/login")).toBe(false);
    expect(allowedAuthUrl("https://chatgpt.com/api/other")).toBe(false);
    expect(allowedAuthUrl("https://malicious-oauth.com/login")).toBe(false);
    expect(allowedAuthUrl("not a url")).toBe(false);
  });
});

describe("auth-helper: runtime alert helpers", () => {
  test("throwIfChatGptSessionFailureAlert ném lỗi khi có modal session expired", async () => {
    const fakePage = {
      isClosed: () => false,
      locator: (sel: string) => ({
        filter: (opt: any) => ({
          last: () => ({
            isVisible: async () => true,
          }),
        }),
      }),
    } as any;

    expect(throwIfChatGptSessionFailureAlert(fakePage)).rejects.toThrow("Phiên đăng nhập ChatGPT đã hết hạn");
  });

  test("throwIfChatGptSessionFailureAlert bỏ qua an toàn khi không có alert", async () => {
    const fakePage = {
      isClosed: () => false,
      locator: (sel: string) => ({
        filter: (opt: any) => ({
          last: () => ({
            isVisible: async () => false,
          }),
        }),
      }),
    } as any;

    expect(throwIfChatGptSessionFailureAlert(fakePage)).resolves.toBeUndefined();
  });

  test("throwIfChatGptRateLimitDialog ném lỗi và tự động click acknowledge khi có modal rate limit", async () => {
    let ackClicked = false;
    const fakePage = {
      isClosed: () => false,
      locator: (sel: string) => ({
        filter: (opt: any) => ({
          last: () => ({
            isVisible: async () => true,
            locator: (btnSel: string) => ({
              filter: (btnOpt: any) => ({
                last: () => ({
                  isVisible: async () => true,
                  click: async () => {
                    ackClicked = true;
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    } as any;

    await expect(throwIfChatGptRateLimitDialog(fakePage)).rejects.toThrow("ChatGPT báo lỗi giới hạn tần suất");
    expect(ackClicked).toBe(true);
  });

  test("throwIfChatGptRateLimitDialog bỏ qua an toàn khi không có modal rate limit", async () => {
    const fakePage = {
      isClosed: () => false,
      locator: (sel: string) => ({
        filter: (opt: any) => ({
          last: () => ({
            isVisible: async () => false,
          }),
        }),
      }),
    } as any;

    await expect(throwIfChatGptRateLimitDialog(fakePage)).resolves.toBeUndefined();
  });
});

describe("check-session: chunked cookies validation", () => {
  const markerPath = getSessionVerifiedMarkerPath();

  test("từ chối khi chỉ có chunk .1 mà thiếu chunk .0 (chống false-positive)", () => {
    try {
      markSessionVerified();
      const partialState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.1",
            value: "valid-looking-jwt-fragment-chunk-1-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(partialState), "utf-8");
      expect(isSessionCached()).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("từ chối khi chunk .0 là 'deleted' dù chunk .1 còn nguyên", () => {
    try {
      markSessionVerified();
      const revokedState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "deleted",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.1",
            value: "valid-looking-jwt-fragment-chunk-1-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(revokedState), "utf-8");
      expect(isSessionCached()).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("chấp nhận khi đầy đủ chunk .0 và .1 hợp lệ", () => {
    try {
      markSessionVerified();
      const validChunkedState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "valid-looking-jwt-fragment-chunk-0-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.1",
            value: "valid-looking-jwt-fragment-chunk-1-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(validChunkedState), "utf-8");
      expect(isSessionCached()).toBe(true);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("chấp nhận khi chunk .0 và .1 hợp lệ dù chunk .2 là tombstone 'deleted' sau khi NextAuth shrink token", () => {
    try {
      markSessionVerified();
      const rotatedState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "valid-looking-jwt-fragment-chunk-0-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.1",
            value: "valid-looking-jwt-fragment-chunk-1-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.2",
            value: "deleted",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(rotatedState), "utf-8");
      expect(isSessionCached()).toBe(true);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("từ chối khi các chunk bị đứt đoạn không liên tục (ví dụ có .0 và .2 nhưng thiếu .1)", () => {
    try {
      markSessionVerified();
      const discontinuousState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "valid-looking-jwt-fragment-chunk-0-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.2",
            value: "valid-looking-jwt-fragment-chunk-2-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(discontinuousState), "utf-8");
      expect(isSessionCached()).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("chấp nhận khi cookie đơn đứng sau một cookie tombstone cùng tên (kiểm tra cookies.some)", () => {
    try {
      markSessionVerified();
      const staleAndNewState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "deleted",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token",
            value: "new-valid-jwt-token-string-that-is-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(staleAndNewState), "utf-8");
      expect(isSessionCached()).toBe(true);
    } finally {
      clearSessionVerified(true);
    }
  });

  test("từ chối khi tồn tại chunk đuôi bị hỏng hoặc hết hạn (chống nhận nhầm token cụt CR-01)", () => {
    try {
      markSessionVerified();
      const corruptedTailState = {
        cookies: [
          {
            name: "__Secure-next-auth.session-token.0",
            value: "valid-looking-jwt-fragment-chunk-0-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.1",
            value: "valid-looking-jwt-fragment-chunk-1-long-enough",
            domain: "chatgpt.com",
            path: "/",
          },
          {
            name: "__Secure-next-auth.session-token.2",
            value: "valid-looking-jwt-fragment-chunk-2",
            domain: "chatgpt.com",
            path: "/",
            expires: 1000, // Hết hạn trong quá khứ!
          },
        ],
      };
      writeFileSync(STORAGE_STATE_PATH, JSON.stringify(corruptedTailState), "utf-8");
      expect(isSessionCached()).toBe(false);
    } finally {
      clearSessionVerified(true);
    }
  });
});

describe("auth-helper: checkSessionEndpoint", () => {
  test("trả về false khi page đã đóng", async () => {
    const closedPage = {
      isClosed: () => true,
    } as any;
    expect(await checkSessionEndpoint(closedPage)).toBe(false);
  });

  test("gọi page.evaluate và xử lý kết quả", async () => {
    const mockPage = {
      isClosed: () => false,
      evaluate: async (fn: any) => true,
    } as any;
    expect(await checkSessionEndpoint(mockPage)).toBe(true);

    const failingPage = {
      isClosed: () => false,
      evaluate: async () => false,
    } as any;
    expect(await checkSessionEndpoint(failingPage)).toBe(false);
  });
});

describe("auth-helper: dismissChatGptModalsAndOnboarding", () => {
  test("trả về false khi page đã đóng", async () => {
    const closedPage = {
      isClosed: () => true,
    } as any;
    expect(await dismissChatGptModalsAndOnboarding(closedPage)).toBe(false);
  });

  test("nhận diện và click nút đóng khi modal onboarding xuất hiện", async () => {
    let clicked = false;
    let hiddenWaited = false;
    const mockDialog = {
      isVisible: async () => true,
      locator: () => ({
        filter: () => ({
          last: () => ({
            isVisible: async () => true,
            click: async () => {
              clicked = true;
            },
          }),
        }),
      }),
      waitFor: async () => {
        hiddenWaited = true;
      },
    };
    const mockPage = {
      isClosed: () => false,
      locator: () => ({
        filter: () => ({
          last: () => mockDialog,
        }),
      }),
    } as any;

    const result = await dismissChatGptModalsAndOnboarding(mockPage);
    expect(result).toBe(true);
    expect(clicked).toBe(true);
    expect(hiddenWaited).toBe(true);
  });
});

describe("auth-helper: saveSanitizedStorageState", () => {
  test("ghi đĩa storage-state.json và gọi markSessionVerified khi có token hợp lệ", async () => {
    const targetFile = join(testProfileDir, "saved-storage.json");
    const mockContext = {
      storageState: async () => ({
        cookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "freshly-rotated-session-token-content-long-enough",
            domain: "chatgpt.com",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 7200,
          },
        ],
        origins: [
          {
            origin: "https://chatgpt.com",
            localStorage: [{ name: "key", value: "val" }],
          },
        ],
      }),
    } as any;

    const saved = await saveSanitizedStorageState(mockContext, targetFile);
    expect(saved).toBe(true);
    expect(existsSync(targetFile)).toBe(true);

    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(targetFile, "utf-8"));
    expect(content.cookies[0].value).toBe("freshly-rotated-session-token-content-long-enough");
  });

  test("không ghi đĩa và trả về false khi token không hợp lệ", async () => {
    const targetFile = join(testProfileDir, "invalid-storage.json");
    const mockContext = {
      storageState: async () => ({
        cookies: [],
        origins: [],
      }),
    } as any;

    const saved = await saveSanitizedStorageState(mockContext, targetFile);
    expect(saved).toBe(false);
    expect(existsSync(targetFile)).toBe(false);
  });
});



