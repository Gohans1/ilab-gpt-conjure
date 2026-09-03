import { CHATGPT_URL, SELECTORS } from "./config.js";
import { getBrowserSession, type BrowserOptions, type BrowserSession } from "./browser.js";
import { extractAndSaveImages, type DownloadResult } from "./downloader.js";

export interface GenerateOptions extends BrowserOptions {
  outputPath?: string;
  timeoutMs?: number;
  skipDiskWrite?: boolean;
}

export async function generateImage(prompt: string, options: GenerateOptions = {}): Promise<DownloadResult[]> {
  const session: BrowserSession = await getBrowserSession({
    headless: options.headless,
  });

  try {
    const page = session.page;
    console.log(`[1/5] Đang mở ChatGPT Web (${CHATGPT_URL})...`);
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Kiểm tra trạng thái đăng nhập
    const isLoginVisible = await page
      .locator(SELECTORS.loginButton)
      .first()
      .isVisible({ timeout: 4000 })
      .catch(() => false);

    if (isLoginVisible) {
      if (options.headless) {
        throw new Error(
          "Phiên đăng nhập ChatGPT chưa có hoặc đã hết hạn. Vui lòng chạy 'Run-Login.bat' hoặc 'bun run login' trước!"
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
          .filter((src) => src.startsWith("http"));
      }, SELECTORS.generatedImage);

      const hasNewImages = currentImages.some((src) => !knownSet.has(src));
      const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);

      if (hasNewImages && !isGenerating) {
        success = true;
        // Đợi 500ms cho các thẻ DOM render hoàn tất
        await page.waitForTimeout(500);
        break;
      }

      // Fail-fast: Nếu nút Stop đã tắt (sinh xong) và đã qua 4s mà không có ảnh mới:
      // Kiểm tra xem ChatGPT có trả lời bằng văn bản chữ không
      if (!isGenerating && Date.now() - startTime > 4000) {
        const assistantText = await page.evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll('[data-message-author-role="assistant"], .markdown')
          );
          if (nodes.length === 0) return null;
          const last = nodes[nodes.length - 1];
          return (last.textContent || "").trim();
        });

        if (assistantText && assistantText.length > 0 && !hasNewImages) {
          const preview = assistantText.length > 120 ? assistantText.slice(0, 120) + "..." : assistantText;
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
    return results;
  } finally {
    await session.close();
  }
}
