import { existsSync, rmSync } from "node:fs";
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
  inputImages?: string[];
  expectedCount?: number;
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

export function resolveDeleteChatOption(deleteChatAfterGen?: boolean): boolean {
  return deleteChatAfterGen ?? (process.env.CHATGPT_DELETE_CHAT !== "false");
}

export function resolveInputImages(input?: unknown): string[] {
  if (!input) return [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(input)) {
    return input
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return [];
}

export async function attachImagesToChatGPT(
  page: any,
  imagePaths: string[],
  options: { timeoutMs?: number; settleMs?: number } = {}
): Promise<void> {
  const paths = resolveInputImages(imagePaths);
  if (paths.length === 0) return;

  const timeout = options.timeoutMs ?? 15_000;
  const settleMs = options.settleMs ?? 1_500;

  let uploaded = false;

  // 1. Thử tìm thẻ input[type="file"] có sẵn trong DOM
  try {
    const fileInput = page.locator(SELECTORS.fileInput).first();
    const inputCount = await fileInput.count().catch(() => 0);

    if (inputCount > 0) {
      const isMultiple = typeof fileInput.getAttribute === "function"
        ? await fileInput.getAttribute("multiple").then((val: any) => val !== null).catch(() => false)
        : false;
      const filesToUpload = isMultiple || paths.length === 1 ? paths : paths.slice(0, 1);
      await fileInput.setInputFiles(filesToUpload, { timeout });
      uploaded = true;
    }
  } catch {}

  // 2. Fallback nếu thẻ input chưa có trong DOM hoặc setInputFiles gặp lỗi
  if (!uploaded) {
    try {
      const attachBtn = page.locator(SELECTORS.attachButton).first();
      const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => null);
      const clickPromise = attachBtn.click({ timeout: 5000 }).catch(() => {});
      const [fileChooser] = await Promise.all([fileChooserPromise, clickPromise]);
      if (fileChooser) {
        await fileChooser.setFiles(paths);
        uploaded = true;
      }
    } catch {}
  }

  if (!uploaded) {
    throw new Error("Không thể nạp ảnh tham chiếu vào giao diện ChatGPT (không tìm thấy input file hoặc nút đính kèm).");
  }

  // 3. Đợi thumbnail xuất hiện
  const thumbnail = page.locator(SELECTORS.attachmentThumbnail).first();
  const hasThumb = await thumbnail.waitFor({ state: "attached", timeout: 20_000 }).then(() => true).catch(() => false);
  if (!hasThumb) {
    throw new Error("Giao diện ChatGPT không hiển thị thumbnail ảnh đính kèm sau khi nạp file.");
  }

  // 4. Chờ indicator uploading biến mất (nếu đang tải ảnh lên)
  const uploading = page.locator(SELECTORS.attachmentUploading).first();
  await uploading.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});

  await page.waitForTimeout(settleMs);
}


export function sizeToAspectRatio(sizeOrRatio?: string | null): string | null {
  if (!sizeOrRatio || typeof sizeOrRatio !== "string") return null;
  const s = sizeOrRatio.trim().toLowerCase();

  // Bỏ qua nếu là None / off / null / auto
  if (s === "none" || s === "off" || s === "null" || s === "undefined" || s === "auto") {
    return null;
  }

  // Đã là dạng tỷ lệ X:Y nguyên dương (ví dụ "16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9")
  if (/^[1-9][0-9]*:[1-9][0-9]*$/.test(s)) {
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
    if (Math.abs(ratio - 9 / 16) < 0.03) return "9:16";
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

export interface ChatGPTPageState {
  isActivelyLoading: boolean;
  hasImageWidget: boolean;
  text: string;
  isOnline: boolean;
  errorMessage: string | null;
  hasRegenerateBtn: boolean;
}

export function inspectChatGPTPageState(
  doc?: any,
  nav?: any
): ChatGPTPageState {
  const d = doc || (typeof document !== "undefined" ? document : null);
  const n = nav || (typeof navigator !== "undefined" ? navigator : null);
  if (!d) {
    return {
      isActivelyLoading: false,
      hasImageWidget: false,
      text: "",
      isOnline: true,
      errorMessage: null,
      hasRegenerateBtn: false,
    };
  }

  const isOnline = n && typeof n.onLine === "boolean" ? n.onLine : true;

  // Chỉ truy vấn đúng vai trò của assistant, loại bỏ .markdown tự do để tránh tóm nhầm tin nhắn của user
  const nodes = Array.from(
    d.querySelectorAll('[data-message-author-role="assistant"]')
  );
  const last: any = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const text = (last?.textContent || "").trim();

  // Scope lên đúng cấp turn: article hoặc conversation-turn bọc tin nhắn cuối
  const lastTurn: any = last?.closest?.('article, [data-testid^="conversation-turn-"]') || last;

  const mainChat: any = d.querySelector?.('main, [role="presentation"]') || d;

  // 1. Kiểm tra xem có spinner hoặc hiệu ứng loading đang xoay trong lượt chat cuối hoặc form chính hay không (tránh quét shimmer ở sidebar)
  const isActivelyLoading =
    (lastTurn !== null &&
      ((lastTurn.textContent || "").includes("Creating image") ||
       (lastTurn.textContent || "").includes("Generating image") ||
       lastTurn.querySelector?.(
         'svg.animate-spin, [class*="animate-spin"], [class*="shimmer"], [class*="spin"], [class*="loader"], [role="progressbar"], [aria-label*="Generating"], [aria-label*="Creating"]'
       ) !== null)) ||
    mainChat.querySelector?.(
      'form [aria-label*="Stop"], form [data-testid="stop-button"], main [aria-label*="Generating"], main [aria-label*="Creating"]'
    ) !== null;

  // 2. Kiểm tra xem lượt chat cuối có widget / container ảnh hay không (đồng bộ đầy đủ với CDN và định dạng ảnh của ChatGPT)
  const hasImageWidget = lastTurn
    ? lastTurn.querySelector?.(
        'div[data-testid*="image"], div[data-testid*="dalle"], div[class*="image-generation"], img[src*="estuary"], img[src*="files.oaiusercontent.com"], img[alt*="Generated image"], img[src*="oaidalleapiprodscus"], canvas'
      ) !== null
    : false;

  // 3. Tìm banner / thông báo lỗi đỏ từ ChatGPT
  const errorNodes = Array.from(
    d.querySelectorAll('[role="alert"], [class*="error"], [class*="danger"], .text-red-500')
  );
  let errorMessage: string | null = null;
  for (const el of errorNodes) {
    const t = ((el as any).textContent || "").trim();
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

  // 4. Kiểm tra nút Regenerate xuất hiện ở lượt tin nhắn cuối (bao gồm cả icon button dùng aria-label)
  const hasRegenerateBtn = lastTurn
    ? lastTurn.querySelector?.(
        'button[data-testid*="regenerate"], button[data-testid*="refresh"], button[data-testid*="retry"], button[aria-label*="Regenerate" i], button[aria-label*="Try again" i], button[aria-label*="Retry" i]'
      ) !== null ||
      Array.from(lastTurn.querySelectorAll?.("button") || []).some((b: any) => {
        const txt = (b.textContent || "").trim().toLowerCase();
        const aria = (b.getAttribute?.("aria-label") || "").toLowerCase();
        return (
          txt.includes("regenerate") ||
          txt.includes("retry") ||
          aria.includes("regenerate") ||
          aria.includes("try again") ||
          aria.includes("retry")
        );
      })
    : false;

  return { isActivelyLoading, hasImageWidget, text, isOnline, errorMessage, hasRegenerateBtn };
}

export async function generateImage(prompt: string, options: GenerateOptions = {}): Promise<DownloadResult[]> {
  const inputImages = resolveInputImages(options.inputImages);
  for (const imgPath of inputImages) {
    if (!existsSync(imgPath)) {
      throw new Error(`Không tìm thấy file ảnh tham chiếu: ${imgPath}`);
    }
  }

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

    const inputImages = resolveInputImages(options.inputImages);
    if (inputImages.length > 0) {
      // Đợi 2s cho React hydrate xong và cắm event listener vào thẻ input file
      await page.waitForTimeout(2_000);
      console.log(`[2.5/5] Đang nạp ${inputImages.length} ảnh tham chiếu vào DOM...`);
      await attachImagesToChatGPT(page, inputImages);
    }

    // Lưu danh sách URL ảnh cũ trước khi gửi prompt (loại trừ user message và form để không dính ảnh tham chiếu)
    const initialUrls = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
        .filter((img) => !img.closest('[data-message-author-role="user"]') && !img.closest("form"))
        .map((img) => img.src || img.getAttribute("src") || "")
        .filter((src) => src.length > 0);
    }, SELECTORS.generatedImage);

    console.log(`[3/5] Đang nhập prompt: "${prompt}"...`);
    await composer.click();
    await composer.fill(prompt);

    // Gửi prompt: Playwright click tự động chờ nút enabled (actionability wait)
    await page.waitForTimeout(400);
    const sendBtn = page.locator(SELECTORS.sendButton).first();
    try {
      await sendBtn.click({ timeout: 20_000 });
    } catch {
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
    const expectedCount = Math.max(1, options.expectedCount ?? 1);
    let previousImageCount = initialUrls.length;
    let previousTextLength = 0;
    let success = false;
    const knownSet = new Set(initialUrls);

    while (Date.now() - startTime < maxTimeoutMs) {
      const currentImages = await page.evaluate((selector) => {
        return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
          .filter((img) => !img.closest('[data-message-author-role="user"]') && !img.closest("form"))
          .map((img) => img.src || img.getAttribute("src") || "")
          .filter((src) => src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:"));
      }, SELECTORS.generatedImage);

      const newImages = currentImages.filter((src) => !knownSet.has(src));
      const hasNewImages = newImages.length > 0;
      const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);

      const pageState = await page.evaluate(inspectChatGPTPageState);

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
      if (
        isGenerating ||
        pageState.isActivelyLoading ||
        currentImages.length > previousImageCount ||
        pageState.text.length > previousTextLength
      ) {
        lastActivityTime = Date.now();
      }
      if (currentImages.length > previousImageCount) {
        previousImageCount = currentImages.length;
      }
      if (pageState.text.length > previousTextLength) {
        previousTextLength = pageState.text.length;
      }

      // Điều kiện hoàn tất: Đã đủ số lượng ảnh mong đợi HOẶC ChatGPT đã thực sự dừng sinh hoàn toàn
      const isCompleteBatch = newImages.length >= expectedCount;
      const isAssistantTurnFinished = !isGenerating && !pageState.isActivelyLoading && pageState.hasRegenerateBtn;

      if (hasNewImages && (isCompleteBatch || isAssistantTurnFinished)) {
        success = true;
        // Đợi 1000ms cho các thẻ DOM render hoàn tất
        await page.waitForTimeout(1000);
        break;
      }

      // Fail-fast: Nút Stop đã tắt, không có spinner đang tải, không có widget ảnh ở turn cuối, có nút Regenerate nhưng không có ảnh mới
      if (
        !isGenerating &&
        !pageState.isActivelyLoading &&
        !pageState.hasImageWidget &&
        pageState.hasRegenerateBtn &&
        !hasNewImages &&
        Date.now() - startTime > 5000
      ) {
        if (pageState.text) {
          const preview = pageState.text.length > 120 ? pageState.text.slice(0, 120) + "..." : pageState.text;
          throw new Error(`ChatGPT không tạo ảnh mà trả lời bằng văn bản: "${preview}"`);
        }
        throw new Error("ChatGPT đã dừng quá trình tạo và hiển thị nút Regenerate nhưng không sinh ra ảnh mới nào.");
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
    const shouldDeleteChat = resolveDeleteChatOption(options.deleteChatAfterGen);

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
    } else {
      console.log("ℹ️ Giữ lại đoạn chat trên ChatGPT Web theo tùy chọn của người dùng.");
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
