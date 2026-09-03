import { existsSync, mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { CHROME_EXECUTABLE_PATH, USER_DATA_DIR } from "./config.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface BrowserOptions {
  headless?: boolean;
}

export async function getBrowserSession(options: BrowserOptions = {}): Promise<BrowserSession> {
  if (!existsSync(USER_DATA_DIR)) {
    mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const headless = options.headless ?? false;
  console.log(`[Browser] Khởi chạy Chrome (headless: ${headless}) tại: ${USER_DATA_DIR}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: existsSync(CHROME_EXECUTABLE_PATH) ? CHROME_EXECUTABLE_PATH : undefined,
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Ẩn navigator.webdriver để tránh Cloudflare chặn
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const page = context.pages()[0] || (await context.newPage());

  return {
    context,
    page,
    close: async () => {
      try {
        await context.close();
      } catch (err) {
        console.warn("⚠️ Không thể đóng browser context hoàn tất:", err);
      }
    },
  };
}
