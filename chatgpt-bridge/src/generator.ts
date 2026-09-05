import { rmSync } from "node:fs";
import { join } from "node:path";
import { CHATGPT_URL, SELECTORS, USER_DATA_DIR } from "./config.js";
import { getBrowserSession, type BrowserOptions, type BrowserSession } from "./browser.js";
import { extractAndSaveImages, type DownloadResult } from "./downloader.js";

import type { Page } from "playwright-core";

export interface GenerateOptions extends BrowserOptions {
  outputPath?: string;
  timeoutMs?: number;
  skipDiskWrite?: boolean;
  deleteChatAfterGen?: boolean;
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

    console.log("[4/5] Prompt đã gửi! Đang chờ ChatGPT Images sinh ảnh (khoảng 15-45s)...");

    // Chờ nút Stop button xuất hiện
    await page.locator(SELECTORS.stopButton).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

    // Vòng lặp chờ ảnh mới xuất hiện và nút Stop biến mất
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 120_000;
    let success = false;
    const knownSet = new Set(initialUrls);

    while (Date.now() - startTime < timeoutMs) {
      const currentImages = await page.evaluate((selector) => {
        return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
          .map((img) => img.src || img.getAttribute("src") || "")
          .filter((src) => src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:"));
      }, SELECTORS.generatedImage);

      const hasNewImages = currentImages.some((src) => !knownSet.has(src));
      const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);

      if (hasNewImages && !isGenerating) {
        success = true;
        // Đợi 500ms cho các thẻ DOM render hoàn tất
        await page.waitForTimeout(500);
        break;
      }

      // Fail-fast: Chỉ kiểm tra khi nút Stop đã tắt (sinh xong), đã qua ít nhất 8s, và không có image widget nào đang tải
      if (!isGenerating && Date.now() - startTime > 8000) {
        const textAnalysis = await page.evaluate(() => {
          const hasImageWidget = document.querySelector('div[data-testid*="image"], div[class*="image-generation"], img[src*="estuary"]') !== null;
          if (hasImageWidget) return null;

          const nodes = Array.from(
            document.querySelectorAll('[data-message-author-role="assistant"], .markdown')
          );
          if (nodes.length === 0) return null;
          const last = nodes[nodes.length - 1];
          const text = (last.textContent || "").trim();
          return { text };
        });

        if (textAnalysis && textAnalysis.text && !hasNewImages) {
          const preview = textAnalysis.text.length > 120 ? textAnalysis.text.slice(0, 120) + "..." : textAnalysis.text;
          throw new Error(`ChatGPT không tạo ảnh mà trả lời bằng văn bản: "${preview}"`);
        }
      }

      await page.waitForTimeout(400);
    }

    if (!success) {
      throw new Error(`Quá thời gian chờ (${timeoutMs / 1000}s) nhưng không thấy ảnh mới được sinh ra.`);
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
