import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_LOGIN_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  findBrowserCandidates,
  getSafeShortPath,
  SELECTORS,
  STORAGE_STATE_PATH,
  USER_DATA_DIR,
} from "./config.js";
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
  closeBrowserGracefully,
  findBrowserPidsByTagAsync,
  isBrowserProfileInUseAsync,
  isBrowserProfileLockedByFs,
  killOrphanBrowsersAsync,
  killOrphanBrowsersByTagAsync,
  killProcessTree,
  parseDevToolsActivePort,
  registerActiveBrowserPid,
  unregisterActiveBrowserPid,
} from "./browser.js";

export { isSessionCookieValid, hasValidSessionToken, AUTH_PROVIDER_HOSTS, allowedLoginStorageHost };

export async function dismissCookieBannerIfPresent(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    const bannerBtn = page
      .locator(
        'button:has-text("Accept all"), button:has-text("Chấp nhận tất cả"), button:has-text("Accept all cookies"), button#onetrust-accept-btn-handler, button#onetrust-reject-all-handler'
      )
      .first();

    const isVisible = await bannerBtn.isVisible().catch(() => false);
    if (isVisible) {
      await bannerBtn.click({ timeout: 1000 }).catch(() => {});
    }
  } catch {}
}

export async function dismissChatGptModalsAndOnboarding(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const dialog = page
      .locator('[role="dialog"]')
      .filter({
        hasText: /Not in history|Memory off|Welcome to ChatGPT|What's new|Có gì mới|Tiếp tục|Continue|Stay logged out/i,
      })
      .last();

    if (await dialog.isVisible().catch(() => false)) {
      const actionBtn = dialog
        .locator("button")
        .filter({
          hasText: /^(Continue|Got it|Done|Tiếp tục|Đã hiểu|Đóng|OK|Stay logged out)$/i,
        })
        .last();

      if (await actionBtn.isVisible().catch(() => false)) {
        await actionBtn.click({ timeout: 2000 }).catch(() => {});
        await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
        return true;
      }
    }
  } catch {}
  return false;
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
    .locator(
      '[role="alert"]:not([aria-hidden="true"]), [role="dialog"]:not([aria-hidden="true"]):not([data-state="closed"])'
    )
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
    .locator('[role="alert"]:not([aria-hidden="true"])')
    .filter({ hasText: /Failed to load subscription/i })
    .last();
  if (await subFailure.isVisible().catch(() => false)) {
    throw new Error("ChatGPT không thể tải thông tin gói thuê bao (Failed to load subscription).");
  }
}

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const rateLimitModal = page
    .locator(
      '[role="dialog"]:not([aria-hidden="true"]):not([data-state="closed"]), [role="alertdialog"]:not([aria-hidden="true"]):not([data-state="closed"]), [role="alert"]'
    )
    .filter({
      hasText:
        /Too many requests|quá nhiều yêu cầu|quá nhiều request|gửi yêu cầu quá nhanh|image creation limit|giới hạn tạo hình ảnh|giới hạn tạo ảnh|limit for image creation|reached your limit|hit the limit|try again tomorrow|thử lại sau|upgrade to plus|nâng cấp lên plus|太多要求|太多请求|リクエストが多すぎます/i,
    })
    .last();

  const isVisible = await rateLimitModal.isVisible().catch(() => false);
  if (!isVisible) return;

  const modalText =
    typeof rateLimitModal.textContent === "function"
      ? (await rateLimitModal.textContent().catch(() => "")) || ""
      : "";

  // Cố gắng bấm nút Acknowledge để giải phóng DOM modal
  const ackBtn = rateLimitModal
    .locator('button')
    .filter({ hasText: /^(Got it|知道了|了解|Đã hiểu|OK|Đóng)$/i })
    .last();
  if (await ackBtn.isVisible().catch(() => false)) {
    await ackBtn.click({ timeout: 2000 }).catch(() => {});
  }

  if (
    /image creation limit|giới hạn tạo hình ảnh|giới hạn tạo ảnh|limit for image creation|reached your limit|hit the limit/i.test(
      modalText
    )
  ) {
    throw new Error(
      "Tài khoản ChatGPT đã chạm giới hạn tạo ảnh trong ngày của gói Free (Image Creation Limit). Vui lòng thử lại sau hoặc nâng cấp Plus."
    );
  }

  throw new Error("ChatGPT báo lỗi giới hạn tần suất (Rate limit / Too many requests). Vui lòng thử lại sau vài phút.");
}

export async function checkIsLoggedIn(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const start = Date.now();
    let loginBtnSeenCount = 0;
    let lastSessionCheckTime = 0;
    while (Date.now() - start < 30_000) {
      if (page.isClosed()) return false;

      // Fail-fast nếu đã bị chuyển hướng sang trang đăng nhập (auth0, login, etc.)
      const currentUrl = typeof page.url === "function" ? page.url() : "";
      if (currentUrl && allowedAuthUrl(currentUrl)) {
        clearSessionVerified(false);
        return false;
      }

      const isLoginBtnVisible = await page
        .locator(SELECTORS.loginButton)
        .first()
        .isVisible()
        .catch(() => false);

      if (isLoginBtnVisible) {
        loginBtnSeenCount++;
        // Fail-fast: Nếu nút đăng nhập hiển thị liên tiếp >= 4 lần (~2.5s)
        if (loginBtnSeenCount >= 4) {
          const cookies = await page
            .context()
            .cookies(["https://chatgpt.com", "https://auth0.openai.com", "https://auth.openai.com", "https://openai.com"])
            .catch(() => []);
          const hasValidCookie = hasValidSessionToken(cookies);
          if (!hasValidCookie) {
            clearSessionVerified(false);
            return false;
          }
          // Cookie có trên client nhưng nút Login vẫn hiện -> kiểm tra server session xem đã bị revoke chưa
          const hasActiveSession = await checkSessionEndpoint(page);
          if (!hasActiveSession) {
            clearSessionVerified(false);
            return false;
          }
          return true;
        }
      } else {
        loginBtnSeenCount = 0;

        // 1. DOM ground truth: Nút profile / avatar tài khoản người dùng đang hiển thị
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

        // 2. Server session endpoint (throttle 2000ms để tránh bão request khi trang đang tải)
        if (Date.now() - lastSessionCheckTime >= 2000) {
          lastSessionCheckTime = Date.now();
          const hasActiveSession = await checkSessionEndpoint(page);
          if (hasActiveSession) {
            return true;
          }
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

const DISALLOWED_STORAGE_KEYS =
  /(conversationDrafts|conversation-history|snorlax-history|pinned-items|integrityStateReconciliation|lastPageLoadDate|statsig\.session_id|^draft|^composer)/i;

export function sanitizeBrowserLoginStorageState(state: any): any {
  return {
    cookies: (state?.cookies || [])
      .filter(
        (cookie: any) =>
          !Object.prototype.hasOwnProperty.call(cookie, "partitionKey") &&
          allowedLoginStorageHost((cookie?.domain || "").replace(/^\.+/, ""))
      )
      .map((cookie: any) => ({ ...cookie })),
    origins: (state?.origins || [])
      .filter((origin: any) => origin?.origin === "https://chatgpt.com")
      .map((origin: any) => ({
        origin: origin.origin,
        localStorage: (origin?.localStorage || [])
          .filter((item: any) => !DISALLOWED_STORAGE_KEYS.test(item?.name || ""))
          .map((item: any) => ({ ...item })),
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
      const isDefaultTarget =
        process.platform === "win32"
          ? resolve(targetPath).toLowerCase() === resolve(STORAGE_STATE_PATH).toLowerCase()
          : resolve(targetPath) === resolve(STORAGE_STATE_PATH);
      if (isDefaultTarget) {
        markSessionVerified();
      }
      return true;
    }
  } catch {}
  return false;
}

let activeLoginContinuation: (() => void) | null = null;

export function notifyLoginContinuation(): boolean {
  if (activeLoginContinuation) {
    const notify = activeLoginContinuation;
    activeLoginContinuation = null;
    notify();
    return true;
  }
  return false;
}

export function cleanupOrphanLoginProfiles(): void {
  try {
    const loginProfilesBase = join(dirname(USER_DATA_DIR), "login-profiles");
    if (!existsSync(loginProfilesBase)) return;
    const entries = readdirSync(loginProfilesBase);
    for (const entry of entries) {
      if (entry.startsWith("login-")) {
        const dir = join(loginProfilesBase, entry);
        try {
          if (!isBrowserProfileLockedByFs(dir)) {
            rmSync(dir, { recursive: true, force: true });
          }
        } catch {}
      }
    }
  } catch {}
}

export interface LoginResult {
  ok: boolean;
  actualBrowser: "chrome" | "edge";
  selectedBrowser: "chrome" | "edge";
  fallbackUsed: boolean;
  message?: string;
}

export async function handleLogin(
  timeoutMs: number = 300_000,
  preferredBrowser?: "chrome" | "edge" | string
): Promise<LoginResult> {
  const { primary, fallback, selectedBrowser, actualBrowser, fallbackUsed } = findBrowserCandidates(preferredBrowser);
  const executablePath = primary[0] || fallback[0];
  if (!executablePath) {
    throw new Error(
      preferredBrowser
        ? `Không tìm thấy trình duyệt ${preferredBrowser.toUpperCase()} (và cả trình duyệt dự phòng) trên hệ thống. Vui lòng cài đặt Google Chrome hoặc Microsoft Edge.`
        : "Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy. Vui lòng cài đặt ít nhất một trình duyệt."
    );
  }

  const browserDisplayName = actualBrowser === "edge" ? "Microsoft Edge" : "Google Chrome";

  if (fallbackUsed) {
    console.warn(
      `⚠️ [Browser Fallback] Trình duyệt '${selectedBrowser.toUpperCase()}' không tìm thấy trên hệ thống! Tự động chuyển sang '${actualBrowser.toUpperCase()}' (${executablePath}).`
    );
  }

  const candidatesToTry: { path: string; browser: "edge" | "chrome"; isFallback: boolean }[] = [];
  if (fallbackUsed) {
    if (fallback[0]) {
      candidatesToTry.push({
        path: fallback[0],
        browser: actualBrowser,
        isFallback: true,
      });
    }
  } else {
    if (primary[0]) {
      candidatesToTry.push({
        path: primary[0],
        browser: selectedBrowser,
        isFallback: false,
      });
    }
    if (fallback[0] && fallback[0] !== primary[0]) {
      const fallbackTarget = (actualBrowser === selectedBrowser
        ? (selectedBrowser === "edge" ? "chrome" : "edge")
        : actualBrowser) as "edge" | "chrome";
      candidatesToTry.push({
        path: fallback[0],
        browser: fallbackTarget,
        isFallback: true,
      });
    }
  }

  // Khởi tạo profile tạm trong thư mục data của repo thay vì C:\Users\...\AppData\Local\Temp
  // Điều này tránh hoàn toàn các lỗi Chromium khi đường dẫn username chứa dấu cách (spaces).
  const loginProfilesBase = join(dirname(USER_DATA_DIR), "login-profiles");
  mkdirSync(loginProfilesBase, { recursive: true, mode: 0o700 });
  cleanupOrphanLoginProfiles();
  const tempProfileDir = mkdtempSync(join(loginProfilesBase, "login-"));
  const safeProfileDir = getSafeShortPath(tempProfileDir);
  try {
    chmodSync(tempProfileDir, 0o700);
    if (safeProfileDir !== tempProfileDir) {
      chmodSync(safeProfileDir, 0o700);
    }
  } catch {}

  let loginBrowser: any = null;
  let activeBrowserPid: number | null = null;
  const offlineTrackedPids = new Set<number>();
  let isOfflineExtractionClosed = false;
  let context: any = null;
  let continuationRequested = false;
  let activeCandidate = candidatesToTry[0];
  let failedOnEarlyExit = false;

  const continuationPromise = new Promise<void>((resolveContinuation) => {
    activeLoginContinuation = () => {
      continuationRequested = true;
      resolveContinuation();
    };
  });

  const instanceTag = `--chatgpt-bridge-instance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Giữ cookie phiên khi người dùng đóng cửa sổ; chỉ cấu hình profile tạm mới tạo.
    atomicWriteFile(
      join(tempProfileDir, "Default", "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 1 } })
    );

    const overallDeadline = Date.now() + timeoutMs;

    for (let candidateIdx = 0; candidateIdx < candidatesToTry.length; candidateIdx++) {
      const candidate = candidatesToTry[candidateIdx];
      activeCandidate = candidate;
      const currentDisplayName = candidate.browser === "edge" ? "Microsoft Edge" : "Google Chrome";

      if (candidate.isFallback) {
        console.warn(
          `⚠️ [Browser Fallback] Sử dụng '${candidate.browser.toUpperCase()}' (${candidate.path}) để đăng nhập...`
        );
      }

      console.log(`🔑 [Login Mode] Đang mở trình duyệt ${currentDisplayName} nguyên bản để bạn đăng nhập ChatGPT...`);
      console.log(`👉 Đường dẫn đăng nhập: ${CHATGPT_LOGIN_URL}`);
      console.log("👉 Vui lòng đăng nhập tài khoản ChatGPT của bạn trên cửa sổ này.");
      console.log("💡 Sau khi đăng nhập xong và thấy giao diện ChatGPT, hãy ĐÓNG CỬA SỔ TRÌNH DUYỆT hoặc bấm [Hoàn tất đăng nhập] trên WebUI.");

      const candidateTag = `${instanceTag}-c${candidateIdx}`;

      // 1. Mở Chrome/Edge THUẦN CHỦNG (100% người thật, KHÔNG cờ automation, KHÔNG cổng debug)
      const browserArgs = [
        candidateTag,
        instanceTag,
        "--chatgpt-bridge-instance",
        `--user-data-dir=${safeProfileDir}`,
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-sync",
        "--restore-last-session",
        "--disable-features=AutoDeElevate,ProfilePickerOnStartup",
        "--do-not-de-elevate",
        "--start-maximized",
        CHATGPT_LOGIN_URL,
      ];

      const startTime = Date.now();
      const candidateTimeout = Math.max(overallDeadline - Date.now(), 15_000);
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        loginBrowser = spawn(candidate.path, browserArgs, {
          stdio: "ignore",
          windowsHide: false,
        });

        if (loginBrowser?.pid) {
          activeBrowserPid = loginBrowser.pid;
          registerActiveBrowserPid(loginBrowser.pid);
        }

        await Promise.race([
          continuationPromise,
          new Promise<void>((resolveExit, rejectExit) => {
            timer = setTimeout(() => {
              try {
                if (activeBrowserPid) {
                  killProcessTree(activeBrowserPid);
                }
              } catch {}
              rejectExit(new Error("Quá thời gian chờ đăng nhập ChatGPT (5 phút). Đã tự động đóng trình duyệt."));
            }, candidateTimeout);

            loginBrowser.once("error", (err: any) => {
              if (timer) clearTimeout(timer);
              rejectExit(err);
            });

            loginBrowser.once("exit", (code: any, signal: any) => {
              if (timer) clearTimeout(timer);
              if (activeBrowserPid) {
                unregisterActiveBrowserPid(activeBrowserPid);
                activeBrowserPid = null;
              }
              if (continuationRequested) {
                resolveExit();
                return;
              }
              if (signal) {
                rejectExit(new Error(`Trình duyệt đăng nhập bị tắt bởi tín hiệu: ${signal}`));
                return;
              }
              resolveExit();
            });
          }),
        ]);
      } catch (launchErr: any) {
        if (candidateIdx < candidatesToTry.length - 1) {
          const nextCandidate = candidatesToTry[candidateIdx + 1];
          console.warn(
            `⚠️ [Browser Launch Error] Không thể khởi chạy '${currentDisplayName}' (${candidate.path}): ${launchErr?.message || launchErr}. Tự động thử lại với '${nextCandidate.browser === "edge" ? "Microsoft Edge" : "Google Chrome"}' (${nextCandidate.path})...`
          );
          if (activeBrowserPid) {
            try {
              killProcessTree(activeBrowserPid);
            } catch {}
            unregisterActiveBrowserPid(activeBrowserPid);
            activeBrowserPid = null;
          }
          await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
          cleanupStaleLocks(safeProfileDir);
          try {
            removeTemporaryChromeTabSessions(safeProfileDir);
            if (safeProfileDir !== tempProfileDir) {
              removeTemporaryChromeTabSessions(tempProfileDir);
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw launchErr;
      } finally {
        if (timer) clearTimeout(timer);
      }

      failedOnEarlyExit = false;
      if (!continuationRequested) {
        let inUse = false;
        const isEarlyExit = Date.now() - startTime < 4000;
        const maxAttempts = isEarlyExit ? 15 : 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (await isBrowserProfileInUseAsync(safeProfileDir, tempProfileDir)) {
            inUse = true;
            break;
          }
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        if (!inUse && isEarlyExit) {
          failedOnEarlyExit = true;
          if (candidateIdx < candidatesToTry.length - 1) {
            const nextCandidate = candidatesToTry[candidateIdx + 1];
            console.warn(
              `⚠️ [Browser Login Fallback] Trình duyệt '${currentDisplayName}' bị đóng ngay khi vừa bật (hoặc bị chặn bởi tiến trình nền). Tự động thử lại với '${nextCandidate.browser === "edge" ? "Microsoft Edge" : "Google Chrome"}' (${nextCandidate.path})...`
            );
            if (activeBrowserPid) {
              try { killProcessTree(activeBrowserPid); } catch {}
              unregisterActiveBrowserPid(activeBrowserPid);
              activeBrowserPid = null;
            }
            await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
            cleanupStaleLocks(safeProfileDir);
            try {
              removeTemporaryChromeTabSessions(safeProfileDir);
              if (safeProfileDir !== tempProfileDir) {
                removeTemporaryChromeTabSessions(tempProfileDir);
              }
            } catch {}
            try {
              const defaultDir = join(safeProfileDir, "Default");
              mkdirSync(defaultDir, { recursive: true });
              writeFileSync(join(defaultDir, "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
            } catch {}
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
        }
        if (inUse) {
          if (instanceTag) {
            try {
              const delegatedPids = await findBrowserPidsByTagAsync(instanceTag);
              for (const pid of delegatedPids) {
                if (!isOfflineExtractionClosed) {
                  offlineTrackedPids.add(pid);
                  registerActiveBrowserPid(pid);
                }
              }
              if (delegatedPids.length > 0 && !activeBrowserPid) {
                activeBrowserPid = delegatedPids[0];
              }
            } catch {}
          }
          console.log("ℹ️ Cửa sổ trình duyệt đang mở. Đang chờ bạn đăng nhập hoặc bấm [Hoàn tất đăng nhập]...");
          let delegatedAttempts = 0;
          const pollDeadline = Math.min(startTime + candidateTimeout, overallDeadline);
          while (Date.now() < pollDeadline && !continuationRequested) {
            await Promise.race([
              continuationPromise,
              new Promise((r) => setTimeout(r, 1500)),
            ]);
            if (continuationRequested) break;
            if (instanceTag && !activeBrowserPid && delegatedAttempts < 3) {
              delegatedAttempts++;
              try {
                const delegatedPids = await findBrowserPidsByTagAsync(instanceTag);
                for (const pid of delegatedPids) {
                  if (!isOfflineExtractionClosed) {
                    offlineTrackedPids.add(pid);
                    registerActiveBrowserPid(pid);
                  }
                }
                if (delegatedPids.length > 0) {
                  activeBrowserPid = delegatedPids[0];
                }
              } catch {}
            }
            if (!(await isBrowserProfileInUseAsync(safeProfileDir, tempProfileDir))) {
              // Kiểm tra xác nhận lần 2 sau 800ms để tránh false-negative khi trang đang chuyển hướng
              await new Promise((r) => setTimeout(r, 800));
              if (!(await isBrowserProfileInUseAsync(safeProfileDir, tempProfileDir))) {
                // Người dùng đã thực sự đóng cửa sổ trình duyệt con
                break;
              }
            }
          }
        }
      }

      break;
    }

    if (failedOnEarlyExit) {
      if (activeBrowserPid) {
        try {
          killProcessTree(activeBrowserPid);
        } catch {}
        unregisterActiveBrowserPid(activeBrowserPid);
        activeBrowserPid = null;
      }
      await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
      cleanupStaleLocks(safeProfileDir);
      if (safeProfileDir !== tempProfileDir && existsSync(tempProfileDir)) {
        cleanupStaleLocks(tempProfileDir);
      }
      const currentDisplayName = activeCandidate.browser === "edge" ? "Microsoft Edge" : "Google Chrome";
      const available = findBrowserCandidates().availableBrowsers;
      const otherBrowser = activeCandidate.browser === "edge" ? "chrome" : "edge";
      const hasOther = available[otherBrowser];
      const suggestedBrowser = otherBrowser === "chrome" ? "Google Chrome" : "Microsoft Edge";
      const allCandidatesTried = candidatesToTry.length > 1;
      const suggestion = allCandidatesTried
        ? "Cả Microsoft Edge và Google Chrome đều bị đóng ngay khi vừa bật (hoặc bị chặn bởi tiến trình nền). Hãy tắt tính năng 'Tiếp tục chạy các ứng dụng nền' (Startup Boost / Background apps) trong Cài đặt của trình duyệt."
        : hasOther
        ? `Cửa sổ ${currentDisplayName} đã bị đóng ngay khi vừa bật (hoặc bị chặn bởi tiến trình nền). Hãy thử chuyển Trình duyệt sang '${suggestedBrowser}' trên WebUI hoặc tắt tính năng 'Tiếp tục chạy các ứng dụng nền' trong Cài đặt của trình duyệt.`
        : `Cửa sổ ${currentDisplayName} đã bị đóng ngay khi vừa bật (hoặc bị chặn bởi tiến trình nền). Hãy tắt tính năng 'Tiếp tục chạy các ứng dụng nền' (Startup Boost / Background apps) trong Cài đặt của ${currentDisplayName}, hoặc cài đặt thêm trình duyệt ${suggestedBrowser}.`;
      throw new Error(suggestion);
    }

    console.log("⏳ Đang đồng bộ và lưu phiên đăng nhập...");
    closeBrowserGracefully([safeProfileDir, tempProfileDir], activeBrowserPid ?? undefined);

    // Chờ Chromium tự đóng êm đẹp và nhả file lock (tối đa 5.0s nếu continuationRequested, 4.0s nếu timeout/exit)
    const gracefulDeadline = Date.now() + (continuationRequested ? 5000 : 4000);
    while (Date.now() < gracefulDeadline) {
      if (!(await isBrowserProfileInUseAsync(safeProfileDir, tempProfileDir))) {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 2. Cưỡng chế dọn dẹp các tiến trình còn sót lại
    if (activeBrowserPid) {
      try {
        killProcessTree(activeBrowserPid, true);
      } catch {}
      unregisterActiveBrowserPid(activeBrowserPid);
      activeBrowserPid = null;
    }
    await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
    await new Promise((r) => setTimeout(r, 400));

    // Chờ các file SQLite WAL và locks nhả hoàn toàn trước khi trích xuất
    for (let w = 0; w < 10; w++) {
      if (!isBrowserProfileLockedByFs(safeProfileDir) && (!tempProfileDir || !isBrowserProfileLockedByFs(tempProfileDir))) {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    cleanupStaleLocks(safeProfileDir);
    removeTemporaryChromeTabSessions(safeProfileDir);
    if (safeProfileDir !== tempProfileDir && existsSync(tempProfileDir)) {
      cleanupStaleLocks(tempProfileDir);
      removeTemporaryChromeTabSessions(tempProfileDir);
    }

    // 3. Trình duyệt đã tắt, mọi cookie đã được flush sạch vào safeProfileDir.
    // Trích xuất storageState trong chế độ hoàn toàn OFFLINE.
    // Ưu tiên 1: Kết nối loopback CDP (DevToolsActivePort) để né sạch 100% bug anonymous pipe của Bun trên Windows.
    // Ưu tiên 2: Fallback qua chromium.launchPersistentContext nếu môi trường không cho phép mở cổng DevTools.
    let extractedStorageState: any = null;
    let lastExtractionError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      lastExtractionError = null;
      const attemptTag = `${instanceTag}-off-${attempt}`;
      const attemptPids = new Set<number>();
      let cdpSuccess = false;

      try {
        // --- PHƯƠNG ÁN 1: DevTools CDP Port loopback (Miễn nhiễm bug anonymous pipe của Bun trên Windows) ---
        let cdpChild: ReturnType<typeof spawn> | null = null;
        try {
          const portFile = join(safeProfileDir, "DevToolsActivePort");
          try {
            rmSync(portFile, { force: true });
          } catch {}

          const cdpArgs = [
            "--headless=new",
            `--user-data-dir=${safeProfileDir}`,
            "--remote-debugging-port=0",
            "--remote-allow-origins=*",
            "--disable-background-mode",
            "--disable-background-networking",
            "--no-first-run",
            "--no-default-browser-check",
            "--restore-last-session",
            "--disable-features=AutoDeElevate,ProfilePickerOnStartup",
            "--do-not-de-elevate",
            attemptTag,
            "--chatgpt-bridge-instance",
            "about:blank",
          ];

          cdpChild = spawn(activeCandidate.path, cdpArgs, {
            stdio: "ignore",
            windowsHide: true,
          });
          cdpChild.on("error", (err) => {
            lastExtractionError = err;
          });

          if (cdpChild.pid) {
            attemptPids.add(cdpChild.pid);
            offlineTrackedPids.add(cdpChild.pid);
            registerActiveBrowserPid(cdpChild.pid);
          }

          let cdpEndpoint: string | null = null;
          const portDeadline = Date.now() + 8000;
          while (Date.now() < portDeadline) {
            if (lastExtractionError) throw lastExtractionError;
            if (cdpChild.exitCode !== null || cdpChild.signalCode !== null) {
              throw new Error(`CDP browser process exited prematurely with code ${cdpChild.exitCode}`);
            }
            if (existsSync(portFile)) {
              try {
                const raw = readFileSync(portFile, "utf-8");
                const allowHttp = Date.now() > portDeadline - 1500;
                const endpoint = parseDevToolsActivePort(raw, allowHttp);
                if (endpoint) {
                  cdpEndpoint = endpoint;
                  break;
                }
              } catch {}
            }
            await new Promise((r) => setTimeout(r, 100));
          }

          if (!cdpEndpoint && !lastExtractionError) {
            lastExtractionError = new Error("CDP port file (DevToolsActivePort) timed out and was not created within deadline");
          }

          if (cdpEndpoint) {
            const cdpBrowser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 8000 });
            try {
              let cdpContext = cdpBrowser.contexts()[0];
              if (!cdpContext) {
                console.warn("⚠️ [CDP Extraction] Default persistent context not found on CDP connection; creating new context.");
                cdpContext = await cdpBrowser.newContext();
              }
              await cdpContext.setOffline(true);
              await cdpContext.route("**/*", (route: any) =>
                route.fulfill({
                  status: 200,
                  contentType: "text/html",
                  body: '<!doctype html><meta charset="utf-8"><title>Login State Extraction</title>',
                })
              );
              const page = cdpContext.pages()[0] ?? (await cdpContext.newPage());
              await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
                waitUntil: "domcontentloaded",
                timeout: 8000,
              });
              const rawState = await cdpContext.storageState();
              const state = sanitizeBrowserLoginStorageState(rawState);
              if (hasValidSessionToken(state.cookies || [])) {
                extractedStorageState = state;
                cdpSuccess = true;
              }
            } finally {
              let closeTimer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                cdpBrowser.close().catch(() => {}),
                new Promise((r) => { closeTimer = setTimeout(r, 3000); }),
              ]);
              if (closeTimer) clearTimeout(closeTimer);
            }
          }
        } catch (cdpErr) {
          lastExtractionError = cdpErr;
        }

        // --- PHƯƠNG ÁN 2: Fallback sang launchPersistentContext nếu CDP chưa lấy được ---
        if (!cdpSuccess && !extractedStorageState) {
          // Dọn dẹp dứt điểm tiến trình CDP cũ trước khi chuyển sang Phase 2 để tránh đụng độ profile lock
          if (cdpChild?.pid) {
            try {
              killProcessTree(cdpChild.pid, true);
            } catch {}
            unregisterActiveBrowserPid(cdpChild.pid);
            offlineTrackedPids.delete(cdpChild.pid);
            attemptPids.delete(cdpChild.pid);
          }
          await killOrphanBrowsersByTagAsync(attemptTag).catch(() => {});
          for (let w = 0; w < 5; w++) {
            if (!isBrowserProfileLockedByFs(safeProfileDir)) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          cleanupStaleLocks(safeProfileDir);

          let isPolling = false;
          let isPollingDisposed = false;
          const pidPollTimer = setInterval(() => {
            if (isPolling || isPollingDisposed) return;
            isPolling = true;
            findBrowserPidsByTagAsync(attemptTag)
              .then((pids) => {
                if (isPollingDisposed) return;
                for (const pid of pids) {
                  attemptPids.add(pid);
                  offlineTrackedPids.add(pid);
                  registerActiveBrowserPid(pid);
                }
              })
              .catch(() => {})
              .finally(() => {
                isPolling = false;
              });
          }, 1000);

          try {
            context = await chromium.launchPersistentContext(safeProfileDir, {
              executablePath: activeCandidate.path,
              headless: true,
              chromiumSandbox: true,
              serviceWorkers: "block",
              offline: true,
              ignoreDefaultArgs: [
                "--no-sandbox",
                "--password-store=basic",
                "--use-mock-keychain",
              ],
              args: [
                attemptTag,
                "--chatgpt-bridge-instance",
                "--disable-background-mode",
                "--disable-background-networking",
                "--no-first-run",
                "--no-default-browser-check",
                "--restore-last-session",
                "--disable-features=AutoDeElevate,ProfilePickerOnStartup",
                "--do-not-de-elevate",
              ],
              timeout: 10_000,
            });

            await context.setOffline(true);
            await context.route("**/*", (route: any) =>
              route.fulfill({
                status: 200,
                contentType: "text/html",
                body: '<!doctype html><meta charset="utf-8"><title>Login State Extraction</title>',
              })
            );

            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
              waitUntil: "domcontentloaded",
              timeout: 8000,
            });

            const rawState = await context.storageState();
            const state = sanitizeBrowserLoginStorageState(rawState);
            if (hasValidSessionToken(state.cookies || [])) {
              extractedStorageState = state;
            }
          } finally {
            isPollingDisposed = true;
            clearInterval(pidPollTimer);
          }
        }
      } catch (e) {
        lastExtractionError = e;
      } finally {
        if (context) {
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            context.close().catch(() => {}),
            new Promise((r) => { closeTimer = setTimeout(r, 3000); }),
          ]);
          if (closeTimer) clearTimeout(closeTimer);
          context = null;
        }
        for (const pid of attemptPids) {
          try {
            killProcessTree(pid, true);
          } catch {}
          unregisterActiveBrowserPid(pid);
          offlineTrackedPids.delete(pid);
        }
        attemptPids.clear();
        // Cưỡng chế quét và diệt sạch mọi zombie theo tag dù PID có lấy được hay không (nếu thất bại)!
        if (!cdpSuccess) {
          await killOrphanBrowsersByTagAsync(attemptTag).catch(() => {});
        }
      }

      if (extractedStorageState) {
        break;
      }

      await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
      removeTemporaryChromeTabSessions(safeProfileDir);
      if (safeProfileDir !== tempProfileDir && existsSync(tempProfileDir)) {
        removeTemporaryChromeTabSessions(tempProfileDir);
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    if (!extractedStorageState || !hasValidSessionToken(extractedStorageState.cookies || [])) {
      if (lastExtractionError) {
        console.warn(
          `⚠️ [Extraction Warning] Lần trích xuất phiên cuối cùng gặp lỗi: ${(lastExtractionError as any)?.message || lastExtractionError}`
        );
      }
      const isTimeout = /(timeout|timed out|deadline)/i.test(String(lastExtractionError || ""));
      const errorMsg = isTimeout
        ? "Quá trình mở trình duyệt để trích xuất phiên đăng nhập bị treo (Timeout). Có thể tiến trình nền của trình duyệt chưa nhả file lock. Vui lòng đóng hết các cửa sổ trình duyệt và thử lại."
        : "Chưa phát hiện phiên đăng nhập hợp lệ. Vui lòng thử đăng nhập lại và đợi trang ChatGPT tải xong trước khi đóng trình duyệt.";
      throw new Error(errorMsg);
    }

    atomicWriteFile(STORAGE_STATE_PATH, JSON.stringify(extractedStorageState, null, 2));
    markSessionVerified();

    console.log("\n🎉 Đăng nhập thành công! Phiên đăng nhập đã được lưu vĩnh viễn vào storage-state.json.");
    console.log("Bây giờ bạn có thể tạo ảnh bình thường qua WebUI hoặc CLI!");

    return {
      ok: true,
      actualBrowser: activeCandidate.browser,
      selectedBrowser,
      fallbackUsed: activeCandidate.isFallback,
      message: activeCandidate.isFallback
        ? `Đăng nhập thành công với ${activeCandidate.browser.toUpperCase()} (tự động chuyển từ ${selectedBrowser.toUpperCase()})!`
        : "Đăng nhập thành công!",
    };
  } finally {
    isOfflineExtractionClosed = true;
    activeLoginContinuation = null;
    if (activeBrowserPid) {
      try {
        killProcessTree(activeBrowserPid);
      } catch {}
      unregisterActiveBrowserPid(activeBrowserPid);
      activeBrowserPid = null;
    }
    if (context) {
      let outerTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => { outerTimer = setTimeout(r, 5000); }),
      ]);
      if (outerTimer) clearTimeout(outerTimer);
      context = null;
    }
    for (const pid of offlineTrackedPids) {
      try {
        killProcessTree(pid);
      } catch {}
      unregisterActiveBrowserPid(pid);
    }
    offlineTrackedPids.clear();
    await killOrphanBrowsersByTagAsync(instanceTag);
    if (isBrowserProfileLockedByFs(safeProfileDir) || (safeProfileDir !== tempProfileDir && existsSync(tempProfileDir) && isBrowserProfileLockedByFs(tempProfileDir))) {
      await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
    }
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(tempProfileDir, { recursive: true, force: true });
        break;
      } catch {
        if (i >= 2) {
          await killOrphanBrowsersAsync([safeProfileDir, tempProfileDir], true);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
