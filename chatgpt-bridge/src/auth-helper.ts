import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { atomicWriteFile, CHATGPT_LOGIN_URL, findBrowserCandidates, SELECTORS, STORAGE_STATE_PATH } from "./config.js";
import {
  AUTH_PROVIDER_HOSTS,
  allowedLoginStorageHost,
  clearSessionVerified,
  hasValidSessionToken,
  isSessionCookieValid,
  markSessionVerified,
} from "./check-session.js";
import {
  cleanupStaleLocks,
  killOrphanBrowsers,
  killProcessTree,
  registerActiveBrowserPid,
  unregisterActiveBrowserPid,
} from "./browser.js";

export { isSessionCookieValid, hasValidSessionToken, AUTH_PROVIDER_HOSTS, allowedLoginStorageHost };

export async function dismissCookieBannerIfPresent(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    const bannerBtn = page
      .locator(
        'button:has-text("Accept all"), button:has-text("Chấp nhận tất cả"), button:has-text("Accept all cookies"), button#onetrust-accept-btn-handler'
      )
      .first();

    const isVisible = await bannerBtn.isVisible().catch(() => false);
    if (isVisible) {
      await bannerBtn.click({ timeout: 1000 }).catch(() => {});
    }
  } catch {}
}

export function allowedAuthUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "chatgpt.com") {
    return (
      parsed.pathname === "/auth" ||
      parsed.pathname.startsWith("/auth/") ||
      parsed.pathname === "/login"
    );
  }
  return AUTH_PROVIDER_HOSTS.has(parsed.hostname);
}

export async function checkSessionEndpoint(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  return await page
    .evaluate(async () => {
      let timer: any;
      try {
        if (location.origin !== "https://chatgpt.com") {
          return false;
        }
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch("/api/auth/session", {
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const responseUrl = new URL(res.url);
        // Chống bẫy redirect 302 về trang HTML login
        if (
          !res.ok ||
          responseUrl.origin !== location.origin ||
          responseUrl.pathname !== "/api/auth/session" ||
          !res.headers.get("content-type")?.includes("application/json")
        ) {
          return false;
        }
        const payload = await res.json();
        if (!payload || typeof payload !== "object") return false;
        // Bắt lỗi RefreshAccessTokenError
        if (payload.error) return false;
        // Kiểm tra thời hạn expires trong JSON payload
        if (
          typeof payload.expires === "string" &&
          Number.isFinite(Date.parse(payload.expires)) &&
          Date.parse(payload.expires) <= Date.now()
        ) {
          return false;
        }
        const user =
          payload.user && typeof payload.user === "object" && !Array.isArray(payload.user)
            ? payload.user
            : null;
        const hasUser = user !== null && Object.keys(user).length > 0;
        return Boolean(hasUser || payload.accessToken);
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
    .catch(() => false);
}

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const expiredAlert = page
    .locator('[role="alert"], [role="dialog"]')
    .filter({
      hasText:
        /Your session has expired|Phiên làm việc đã hết hạn|Phiên đăng nhập đã hết hạn|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i,
    })
    .last();

  const isExpired = await expiredAlert.isVisible().catch(() => false);
  if (isExpired) {
    clearSessionVerified(false);
    throw new Error("Phiên đăng nhập ChatGPT đã hết hạn (Your session has expired). Vui lòng đăng nhập lại!");
  }

  const subFailure = page
    .locator('[role="alert"]')
    .filter({ hasText: /Failed to load subscription/i })
    .last();
  if (await subFailure.isVisible().catch(() => false)) {
    throw new Error("ChatGPT không thể tải thông tin gói thuê bao (Failed to load subscription).");
  }
}

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const rateLimitModal = page
    .locator('[role="dialog"]')
    .filter({
      hasText:
        /Too many requests|quá nhiều yêu cầu|quá nhiều request|gửi yêu cầu quá nhanh|太多要求|太多请求|リクエストが多すぎます/i,
    })
    .last();

  const isVisible = await rateLimitModal.isVisible().catch(() => false);
  if (!isVisible) return;

  // Cố gắng bấm nút Acknowledge để giải phóng DOM modal
  const ackBtn = rateLimitModal
    .locator('button')
    .filter({ hasText: /^(Got it|知道了|了解|Đã hiểu|OK|Đóng)$/i })
    .last();
  if (await ackBtn.isVisible().catch(() => false)) {
    await ackBtn.click({ timeout: 2000 }).catch(() => {});
  }

  throw new Error("ChatGPT báo lỗi giới hạn tần suất (Rate limit / Too many requests). Vui lòng thử lại sau vài phút.");
}

export async function checkIsLoggedIn(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const start = Date.now();
    let loginBtnSeenCount = 0;
    while (Date.now() - start < 30_000) {
      if (page.isClosed()) return false;

      const isLoginBtnVisible = await page
        .locator(SELECTORS.loginButton)
        .first()
        .isVisible()
        .catch(() => false);

      if (isLoginBtnVisible) {
        loginBtnSeenCount++;
        // Fail-fast: Nếu nút đăng nhập hiển thị liên tiếp >= 2 lần (~1.2s)
        if (loginBtnSeenCount >= 2) {
          const cookies = await page
            .context()
            .cookies(["https://chatgpt.com", "https://auth0.openai.com", "https://auth.openai.com", "https://openai.com"])
            .catch(() => []);
          const hasValidCookie = cookies.some(isSessionCookieValid);
          if (!hasValidCookie) {
            return false;
          }
          // Cookie có trên client nhưng nút Login vẫn hiện -> kiểm tra server session xem đã bị revoke chưa
          const hasActiveSession = await checkSessionEndpoint(page);
          if (!hasActiveSession) {
            return false;
          }
          return true;
        }
      } else {
        loginBtnSeenCount = 0;
        const cookies = await page
          .context()
          .cookies(["https://chatgpt.com", "https://auth0.openai.com", "https://auth.openai.com", "https://openai.com"])
          .catch(() => []);
        const hasValidCookie = cookies.some(isSessionCookieValid);

        if (hasValidCookie) {
          const hasProfileBtn = await page
            .locator(
              '[data-testid="user-menu-button"], [data-testid="profile-button"], button[aria-label*="Account" i], button[aria-label*="Profile" i]'
            )
            .first()
            .isVisible()
            .catch(() => false);

          if (hasProfileBtn) {
            return true;
          }

          const hasActiveSession = await checkSessionEndpoint(page);
          if (hasActiveSession) return true;
        }
      }

      await new Promise((r) => setTimeout(r, 600));
    }

    return false;
  } catch {
    return false;
  }
}

export function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  try {
    rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  } catch {}
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    try {
      rmSync(join(defaultProfile, name), { force: true });
    } catch {}
  }
}

export function sanitizeBrowserLoginStorageState(state: any): any {
  return {
    cookies: (state.cookies || [])
      .filter(
        (cookie: any) =>
          !Object.prototype.hasOwnProperty.call(cookie, "partitionKey") &&
          allowedLoginStorageHost((cookie.domain || "").replace(/^\.+/, ""))
      )
      .map((cookie: any) => ({ ...cookie })),
    origins: (state.origins || [])
      .filter((origin: any) => origin?.origin === "https://chatgpt.com")
      .map((origin: any) => ({
        origin: origin.origin,
        localStorage: (origin.localStorage || []).map((item: any) => ({ ...item })),
      })),
  };
}

export async function saveSanitizedStorageState(
  context: BrowserContext,
  targetPath: string = STORAGE_STATE_PATH
): Promise<boolean> {
  try {
    const raw = await context.storageState();
    const sanitized = sanitizeBrowserLoginStorageState(raw);
    const hasValidToken = hasValidSessionToken(sanitized.cookies || []);
    if (hasValidToken) {
      atomicWriteFile(targetPath, JSON.stringify(sanitized, null, 2));
      if (targetPath === STORAGE_STATE_PATH) {
        markSessionVerified();
      }
      return true;
    }
  } catch {}
  return false;
}

export async function handleLogin(timeoutMs: number = 300_000): Promise<void> {
  const { primary, fallback } = findBrowserCandidates();
  const executablePath = primary[0] || fallback[0];
  if (!executablePath) {
    throw new Error("Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy.");
  }

  const tempProfileDir = mkdtempSync(join(tmpdir(), "chatgpt-login-profile-"));
  let loginBrowser: any = null;
  let context: any = null;

  try {
    console.log("🔑 [Login Mode] Đang mở trình duyệt Chrome nguyên bản để bạn đăng nhập ChatGPT...");
    console.log(`👉 Đường dẫn đăng nhập: ${CHATGPT_LOGIN_URL}`);
    console.log("👉 Vui lòng đăng nhập tài khoản ChatGPT của bạn trên cửa sổ này.");
    console.log("💡 Sau khi đăng nhập xong và thấy giao diện ChatGPT, hãy ĐÓNG CỬA SỔ TRÌNH DUYỆT LẠI.");

    // 1. Mở Chrome THUẦN CHỦNG (100% người thật, KHÔNG cờ automation, KHÔNG cổng debug)
    loginBrowser = spawn(
      executablePath,
      [
        `--user-data-dir=${tempProfileDir}`,
        "--new-window",
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check",
        CHATGPT_LOGIN_URL,
      ],
      { stdio: "ignore" }
    );

    if (loginBrowser?.pid) {
      registerActiveBrowserPid(loginBrowser.pid);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveExit, rejectExit) => {
        timer = setTimeout(() => {
          try {
            if (loginBrowser?.pid) {
              killProcessTree(loginBrowser.pid);
            }
          } catch {}
          rejectExit(new Error("Quá thời gian chờ đăng nhập ChatGPT (5 phút). Đã tự động đóng trình duyệt."));
        }, timeoutMs);

        loginBrowser.once("error", (err: any) => {
          if (timer) clearTimeout(timer);
          rejectExit(err);
        });
        loginBrowser.once("exit", (code: any, signal: any) => {
          if (timer) clearTimeout(timer);
          if (signal) {
            rejectExit(new Error(`Trình duyệt đăng nhập bị tắt bởi tín hiệu: ${signal}`));
          } else {
            // Không reject nếu code !== 0 khi user bấm X trên Windows
            // Bước trích xuất và xác thực storageState tiếp theo là nguồn kiểm chứng chính xác nhất
            resolveExit();
          }
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    console.log("⏳ Đang đồng bộ và lưu phiên đăng nhập...");

    // Settle delay 800ms trên Windows để các tiến trình con Crashpad/GPU kịp đóng và nhả file lock
    await new Promise((r) => setTimeout(r, 800));
    killOrphanBrowsers(tempProfileDir);
    cleanupStaleLocks(tempProfileDir);
    removeTemporaryChromeTabSessions(tempProfileDir);

    // 2. Chrome đã tắt, mọi cookie đã được flush sạch vào tempProfileDir.
    // Dùng Playwright mở chớp nhoáng tempProfileDir để trích xuất storageState trong chế độ hoàn toàn OFFLINE
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        context = await chromium.launchPersistentContext(tempProfileDir, {
          executablePath,
          headless: true,
          chromiumSandbox: true,
          offline: true,
          serviceWorkers: "block",
          ignoreDefaultArgs: [
            "--no-sandbox",
            "--enable-automation",
            "--password-store=basic",
            "--use-mock-keychain",
          ],
          args: [
            "--disable-background-mode",
            "--disable-background-networking",
            "--no-first-run",
            "--no-default-browser-check",
            "--restore-last-session",
          ],
          timeout: 30_000,
        });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        killOrphanBrowsers(tempProfileDir);
        cleanupStaleLocks(tempProfileDir);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Chặn mọi kết nối mạng ra ngoài để bảo mật tuyệt đối và không kích hoạt bot detection
    await context.setOffline(true);
    await context.route("**/*", (route: any) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><title>Login State Extraction</title>',
      })
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://chatgpt.com/?temporary-chat=true", {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    }).catch(() => {});

    const rawState = await context.storageState();
    const state = sanitizeBrowserLoginStorageState(rawState);
    const hasValidToken = hasValidSessionToken(state.cookies || []);

    if (!hasValidToken) {
      throw new Error(
        "Chưa phát hiện phiên đăng nhập hợp lệ. Vui lòng thử đăng nhập lại và đợi trang ChatGPT tải xong trước khi đóng trình duyệt."
      );
    }

    atomicWriteFile(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
    markSessionVerified();

    console.log("\n🎉 Đăng nhập thành công! Phiên đăng nhập đã được lưu vĩnh viễn vào storage-state.json.");
    console.log("Bây giờ bạn có thể tạo ảnh bình thường qua WebUI hoặc CLI!");
  } finally {
    if (loginBrowser?.pid) {
      unregisterActiveBrowserPid(loginBrowser.pid);
      try {
        killProcessTree(loginBrowser.pid);
      } catch {}
    }
    if (context) {
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
    killOrphanBrowsers(tempProfileDir, true);
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(tempProfileDir, { recursive: true, force: true });
        break;
      } catch {
        if (i >= 2) {
          killOrphanBrowsers(tempProfileDir, true);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
