import { rmSync } from "node:fs";
import { join } from "node:path";
import { CHATGPT_URL, SELECTORS, USER_DATA_DIR } from "./config.js";
import { getBrowserSession, type BrowserOptions, type BrowserSession } from "./browser.js";
import { extractAndSaveImages, type DownloadResult } from "./downloader.js";

import type { Page } from "playwright-core";

export interface GenerateOptions extends BrowserOptions {
  outputPath?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxTimeoutMs?: number;
  skipDiskWrite?: boolean;
  deleteChatAfterGen?: boolean;
}

export function resolveTimeoutOptions(options: GenerateOptions = {}): {
  idleTimeoutMs: number;
  maxTimeoutMs: number;
} {
  const envIdle = process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS;
  const envMax = process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS;

  const idleTimeoutMs = options.idleTimeoutMs ?? (envIdle ? Number(envIdle) : 60_000);
  const maxTimeoutMs = options.maxTimeoutMs ?? options.timeoutMs ?? (envMax ? Number(envMax) : 600_000);

  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : 60_000,
    maxTimeoutMs: Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0 ? maxTimeoutMs : 600_000,
  };
}

export function sizeToAspectRatio(sizeOrRatio?: string | null): string | null {
  if (!sizeOrRatio || typeof sizeOrRatio !== "string") return null;
  const s = sizeOrRatio.trim().toLowerCase();

  // Đã là dạng tỷ lệ X:Y (ví dụ "16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9")
  if (/^[0-9]+:[0-9]+$/.test(s)) {
    return s;
  }

  // Dạng kích thước pixel WxH (ví dụ "1792x1024", "1024x1024", "1024x1792")
  const match = s.match(/^([0-9]+)\s*[xX×]\s*([0-9]+)$/);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w <= 0 || h <= 0) return null;

    const ratio = w / h;
    if (Math.abs(ratio - 1) < 0.05) return "1:1";
    if (Math.abs(ratio - 16 / 9) < 0.08) return "16:9";
    if (Math.abs(ratio - 9 / 16) < 0.08) return "9:16";
    if (Math.abs(ratio - 4 / 3) < 0.06) return "4:3";
    if (Math.abs(ratio - 3 / 4) < 0.06) return "3:4";
    if (Math.abs(ratio - 3 / 2) < 0.06) return "3:2";
    if (Math.abs(ratio - 2 / 3) < 0.06) return "2:3";
    if (Math.abs(ratio - 21 / 9) < 0.1) return "21:9";

    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
  }

  return null;
}

export async function generateImage(prompt: string, options: GenerateOptions = {}): Promise<DownloadResult[]> {
  const session: BrowserSession = await getBrowserSession({
    headless: options.headless,
  });

  try {
    const page = session.page;
    let capturedAuthHeader: string | null = null;
    let detectedConversationId: string | null = null;

    const requestListener = (req: any) => {
      try {
        const url = req.url();
        if (url.includes("/backend-api/")) {
          const auth = req.headers()["authorization"];
          if (auth && !capturedAuthHeader) {
            capturedAuthHeader = auth;
          }
          const match = url.match(/\/backend-api\/conversation\/([0-9a-fA-F-]{36})/);
          if (match && !detectedConversationId) {
            detectedConversationId = match[1];
          }
        }
      } catch {}
    };

    page.on("request", requestListener);

    console.log(`[1/5] Đang mở ChatGPT Web (${CHATGPT_URL})...`);
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Kiểm tra trạng thái đăng nhập
    const isLoginVisible = await page
      .locator(SELECTORS.loginButton)
      .first()
      .isVisible({ timeout: 4000 })
      .catch(() => false);

    if (isLoginVisible) {
      try {
        rmSync(join(USER_DATA_DIR, ".session-verified"), { force: true });
      } catch {}
      if (options.headless) {
        throw new Error(
          "Phiên đăng nhập ChatGPT chưa có hoặc đã hết hạn. Vui lòng bấm [🔑 Đăng nhập ChatGPT] trên WebUI!"
        );
      }
      console.warn("\n⚠️ [CHÚ Ý] Bạn chưa đăng nhập ChatGPT!");
      console.log("👉 Vui lòng đăng nhập tài khoản của bạn trên cửa sổ trình duyệt vừa mở...");
      console.log("⏳ Đang chờ đăng nhập thành công...\n");
      await page.locator(SELECTORS.composer).first().waitFor({ state: "visible", timeout: 180_000 });
      console.log("✅ Đã phát hiện phiên đăng nhập thành công!\n");
    }

    // Đợi ô nhập liệu hiển thị
    console.log("[2/5] Đang đợi ô soạn thảo prompt sẵn sàng...");
    const composer = page.locator(SELECTORS.composer).first();
    await composer.waitFor({ state: "visible", timeout: 30_000 });

    // Lưu danh sách URL ảnh cũ trước khi gửi prompt
    const initialUrls = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
        .map((img) => img.src || img.getAttribute("src") || "")
        .filter((src) => src.length > 0);
    }, SELECTORS.generatedImage);

    console.log(`[3/5] Đang nhập prompt: "${prompt}"...`);
    await composer.click();
    await composer.fill(prompt);

    // Gửi prompt
    await page.waitForTimeout(400);
    const sendBtn = page.locator(SELECTORS.sendButton).first();
    const canClickSend = await sendBtn.isEnabled({ timeout: 2000 }).catch(() => false);
    if (canClickSend) {
      await sendBtn.click();
    } else {
      await composer.press("Enter");
    }

    console.log("[4/5] Prompt đã gửi! Đang chờ ChatGPT Images sinh ảnh (theo dõi trạng thái hoạt động)...");

    // Chờ nút Stop button xuất hiện
    await page.locator(SELECTORS.stopButton).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

    // Vòng lặp chờ ảnh mới xuất hiện theo trạng thái hoạt động (Inactivity Timeout)
    const startTime = Date.now();
    let lastActivityTime = Date.now();
    let lastLoggedTime = Date.now();
    const { idleTimeoutMs, maxTimeoutMs } = resolveTimeoutOptions(options);
    let previousImageCount = initialUrls.length;
    let previousTextLength = 0;
    let success = false;
    const knownSet = new Set(initialUrls);

    while (Date.now() - startTime < maxTimeoutMs) {
      const currentImages = await page.evaluate((selector) => {
        return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
          .map((img) => img.src || img.getAttribute("src") || "")
          .filter((src) => src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:"));
      }, SELECTORS.generatedImage);

      const hasNewImages = currentImages.some((src) => !knownSet.has(src));
      const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);

      const pageState = await page.evaluate(() => {
        const hasWidget =
          document.querySelector('div[data-testid*="image"], div[class*="image-generation"], img[src*="estuary"]') !== null;
        const nodes = Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"], .markdown')
        );
        const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
        const text = (last?.textContent || "").trim();

        // 1. Kiểm tra trạng thái mạng của trình duyệt
        const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

        // 2. Tìm banner / thông báo lỗi đỏ từ ChatGPT
        const errorNodes = Array.from(
          document.querySelectorAll('[role="alert"], [class*="error"], [class*="danger"], .text-red-500')
        );
        let errorMessage: string | null = null;
        for (const el of errorNodes) {
          const t = (el.textContent || "").trim();
          if (
            t.includes("Something went wrong") ||
            t.includes("Network error") ||
            t.includes("error generating") ||
            t.includes("There was an error") ||
            t.includes("Unable to load") ||
            t.includes("Failed to load") ||
            t.includes("Rate limit")
          ) {
            errorMessage = t;
            break;
          }
        }

        // 3. Kiểm tra nút Regenerate xuất hiện
        const hasRegenerateBtn =
          document.querySelector('button[data-testid*="regenerate"], button:has([data-testid*="refresh"])') !== null ||
          Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").trim() === "Regenerate");

        return { hasWidget, text, isOnline, errorMessage, hasRegenerateBtn };
      });

      // Fail-fast mạng: Trình duyệt mất kết nối Internet
      if (!pageState.isOnline) {
        throw new Error("Trình duyệt mất kết nối Internet (navigator.onLine = false).");
      }

      // Fail-fast lỗi giao diện: ChatGPT hiển thị banner / thông báo lỗi
      if (pageState.errorMessage && !hasNewImages) {
        const cleanErr = pageState.errorMessage.length > 150 ? pageState.errorMessage.slice(0, 150) + "..." : pageState.errorMessage;
        throw new Error(`ChatGPT báo lỗi: "${cleanErr}"`);
      }

      // Reset Inactivity Timer khi có bất kỳ tín hiệu đang tạo ảnh nào từ ChatGPT
      if (isGenerating || currentImages.length > previousImageCount || pageState.text.length > previousTextLength) {
        lastActivityTime = Date.now();
      }
      if (currentImages.length > previousImageCount) {
        previousImageCount = currentImages.length;
      }
      if (pageState.text.length > previousTextLength) {
        previousTextLength = pageState.text.length;
      }

      // Điều kiện hoàn tất: Có ảnh mới và ChatGPT đã dừng sinh
      if (hasNewImages && !isGenerating) {
        success = true;
        // Đợi 500ms cho các thẻ DOM render hoàn tất
        await page.waitForTimeout(500);
        break;
      }

      // Fail-fast: Nút Stop đã tắt, đã qua ít nhất 5s, có nút Regenerate nhưng không có ảnh mới
      if (!isGenerating && pageState.hasRegenerateBtn && !hasNewImages && Date.now() - startTime > 5000) {
        throw new Error("ChatGPT đã dừng quá trình tạo và hiển thị nút Regenerate nhưng không sinh ra ảnh mới nào.");
      }

      // Fail-fast: Chỉ kiểm tra khi nút Stop đã tắt (sinh xong), đã qua ít nhất 8s, và không có image widget nào đang tải
      if (!isGenerating && Date.now() - startTime > 8000) {
        if (!pageState.hasWidget && pageState.text && !hasNewImages) {
          const preview = pageState.text.length > 120 ? pageState.text.slice(0, 120) + "..." : pageState.text;
          throw new Error(`ChatGPT không tạo ảnh mà trả lời bằng văn bản: "${preview}"`);
        }
      }

      // In nhật ký nhịp tim (Heartbeat log) mỗi 15s nếu tác vụ đang chạy lâu
      if (Date.now() - lastLoggedTime >= 15_000) {
        lastLoggedTime = Date.now();
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const idleSec = Math.round((Date.now() - lastActivityTime) / 1000);
        const newCount = currentImages.filter((src) => !knownSet.has(src)).length;
        console.log(
          `⏳ [Bridge] Đang sinh ảnh... (Đã chạy: ${elapsedSec}s | Hoạt động gần nhất: ${idleSec}s trước | Đã tìm thấy: ${newCount} ảnh mới)`
        );
      }

      // Kiểm tra Inactivity Timeout (ChatGPT đơ/bất động không có hoạt động mới)
      if (Date.now() - lastActivityTime > idleTimeoutMs) {
        throw new Error(
          `Quá thời gian chờ bất động (${idleTimeoutMs / 1000}s) do không phát hiện hoạt động mới từ ChatGPT. (Tổng thời gian đã chờ: ${Math.round((Date.now() - startTime) / 1000)}s)`
        );
      }

      await page.waitForTimeout(400);
    }

    if (!success) {
      throw new Error(`Quá thời gian chờ tối đa (${maxTimeoutMs / 1000}s) nhưng không thấy ảnh mới được sinh ra.`);
    }

    // Tải và lưu toàn bộ ảnh về đĩa
    const defaultOut = `./output/image_${Date.now()}.png`;
    const targetOut = options.outputPath || defaultOut;
    console.log(`[5/5] Đã phát hiện ảnh mới! Đang trích xuất ảnh...`);

    const results = await extractAndSaveImages(page, SELECTORS.generatedImage, targetOut, {
      knownUrls: initialUrls,
      skipDiskWrite: options.skipDiskWrite,
    });

    // Tự động dọn dẹp (xóa) phiên chat vừa tạo trên ChatGPT nếu được bật (mặc định bật)
    const shouldDeleteChat =
      options.deleteChatAfterGen ?? (process.env.CHATGPT_DELETE_CHAT !== "false");

    if (shouldDeleteChat) {
      try {
        const urlMatch = page.url().match(/\/c\/([0-9a-fA-F-]{36})/);
        const targetConvId = urlMatch?.[1] || detectedConversationId;

        if (targetConvId) {
          console.log(`🧹 Đang dọn dẹp (xóa) phiên chat vừa tạo trên ChatGPT (ID: ${targetConvId})...`);
          const deleteResult = await deleteChatGPTConversation(page, targetConvId, capturedAuthHeader);
          if (deleteResult.success) {
            console.log(`✅ Đã xóa chat ${targetConvId} thành công khỏi ChatGPT!`);
          } else {
            console.warn(
              `⚠️ Không thể xóa chat ${targetConvId} (HTTP ${deleteResult.status ?? "unknown"}${
                deleteResult.error ? `: ${deleteResult.error}` : ""
              })`
            );
          }
        } else {
          console.log("ℹ️ Không tìm thấy ID đoạn chat trên URL để xóa.");
        }
      } catch (delErr) {
        console.warn("⚠️ Gặp lỗi khi dọn dẹp chat:", delErr instanceof Error ? delErr.message : delErr);
      }
    }

    return results;
  } finally {
    await session.close();
  }
}

export async function deleteChatGPTConversation(
  page: Page,
  conversationId: string,
  authHeader?: string | null
): Promise<{ success: boolean; status?: number; error?: string }> {
  try {
    const result = await page.evaluate(
      async ({ id, auth }: { id: string; auth: string | null }) => {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (auth) {
            headers["Authorization"] = auth;
          } else {
            try {
              const sessionRes = await fetch("/api/auth/session");
              if (sessionRes.ok) {
                const sessionData = (await sessionRes.json()) as { accessToken?: string };
                if (sessionData?.accessToken) {
                  headers["Authorization"] = `Bearer ${sessionData.accessToken}`;
                }
              }
            } catch {}
          }

          const res = await fetch(`/backend-api/conversation/${id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ is_visible: false }),
          });

          return { success: res.ok, status: res.status };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
      { id: conversationId, auth: authHeader || null }
    );
    return result;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
