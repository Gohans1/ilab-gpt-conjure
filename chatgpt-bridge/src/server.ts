import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import crypto from "node:crypto";
import { generateImage, sizeToAspectRatio } from "./generator.js";
import { handleLogin, notifyLoginContinuation } from "./auth-helper.js";
import { clearSessionVerified, isSessionCached } from "./check-session.js";
import { cleanupActiveBrowsers } from "./browser.js";
import { detectImageExtension, findBrowserCandidates, getAvailableBrowsers, normalizeBrowserChoice } from "./config.js";
export { detectImageExtension, normalizeBrowserChoice };

export interface ParsedImageRequest {
  prompt: string;
  n: number;
  aspectRatioOrSize?: string;
  deleteChatAfterGen?: boolean;
  headless?: boolean;
  browser?: "chrome" | "edge" | string;
  customTimeout?: number;
  idleTimeout?: number;
  tempFilesToClean: string[];
  inputImages: string[];
}

export function cleanupTempFiles(files: string[]): void {
  for (const file of files) {
    try {
      rmSync(file, { recursive: true, force: true });
    } catch {}
  }
}

const VALID_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function isValidLocalImage(filePath: string): boolean {
  try {
    if (!filePath || typeof filePath !== "string") return false;
    // Chặn tuyệt đối UNC paths và network protocols để chống leak NetNTLM hash và SSRF (SEC-02)
    if (filePath.startsWith("\\\\") || filePath.startsWith("//") || filePath.includes("://")) {
      return false;
    }
    // Giới hạn trong thư mục làm việc hiện tại để chống đọc trộm file nhạy cảm hệ điều hành
    const resolved = resolve(filePath);
    const cwd = resolve(process.cwd());
    const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) return false;

    if (!existsSync(resolved)) return false;
    const stat = statSync(resolved);
    if (!stat.isFile()) return false;
    const lower = resolved.toLowerCase();
    const dotIdx = lower.lastIndexOf(".");
    if (dotIdx === -1) return false;
    return VALID_IMAGE_EXTENSIONS.has(lower.slice(dotIdx));
  } catch {
    return false;
  }
}


export async function parseImageRequest(req: Request): Promise<ParsedImageRequest> {
  const contentType = req.headers.get("content-type") || "";
  const tempFilesToClean: string[] = [];
  const inputImages: string[] = [];

  let prompt = "";
  let n = 1;
  let aspectRatioOrSize: string | undefined;
  let deleteChatRaw: any;
  let headlessRaw: any;
  let visibleBrowserRaw: any;
  let browserRaw: any;
  let customTimeout: number | undefined;
  let idleTimeout: number | undefined;

  let tempDir: string | null = null;
  const getTempDir = (): string => {
    if (!tempDir) {
      tempDir = mkdtempSync(join(tmpdir(), "chatgpt-bridge-"));
      tempFilesToClean.push(tempDir);
    }
    return tempDir;
  };

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      prompt = String(formData.get("prompt") || "");
      const nRaw = formData.get("n");
      if (nRaw) n = Number(nRaw) || 1;

      aspectRatioOrSize = (formData.get("aspect_ratio") || formData.get("ratio") || formData.get("size")) as string | undefined;
      deleteChatRaw = formData.get("delete_chat_after_gen") ?? formData.get("deleteChatAfterGen");
      headlessRaw = formData.get("headless");
      visibleBrowserRaw = formData.get("visible_browser") ?? formData.get("visibleBrowser");
      browserRaw = formData.get("browser") ?? formData.get("browser_type");

      const timeoutRaw = formData.get("timeout") ?? formData.get("max_timeout") ?? formData.get("timeout_ms");
      if (timeoutRaw) {
        const parsedTimeout = Number(timeoutRaw);
        if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) customTimeout = parsedTimeout;
      }
      const idleTimeoutRaw = formData.get("idle_timeout") ?? formData.get("idleTimeout");
      if (idleTimeoutRaw) {
        const parsedIdle = Number(idleTimeoutRaw);
        if (Number.isFinite(parsedIdle) && parsedIdle > 0) idleTimeout = parsedIdle;
      }

      const fileEntries: File[] = [];
      for (const field of ["image", "images", "file"]) {
        const entries = formData.getAll(field);
        for (const entry of entries) {
          if (entry instanceof File && entry.size > 0) {
            fileEntries.push(entry);
          }
        }
      }

      if (fileEntries.length > 0) {
        // Giới hạn tối đa 5 file ảnh đính kèm
        const filesToProcess = fileEntries.slice(0, 5);
        let fileIdx = 0;
        for (const file of filesToProcess) {
          fileIdx++;
          const arrayBuffer = await file.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          // SEC-01 & REQ-05 Fix: Dùng magic bytes để phát hiện extension thực sự, TUYỆT ĐỐI KHÔNG dùng file.name
          const ext = detectImageExtension(buf);
          if (!ext) {
            throw new Error(`Unsupported or invalid image format in uploaded file "${file.name || `file-${fileIdx}`}". Only PNG, JPEG, GIF, and WebP are allowed.`);
          }
          const tempPath = join(getTempDir(), `input-${fileIdx}${ext}`);
          writeFileSync(tempPath, buf);
          tempFilesToClean.push(tempPath);
          inputImages.push(tempPath);
        }
      }
    } else {
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      prompt = String(body.prompt || "");
      if (typeof body.n === "number" && body.n > 1) n = body.n;
      aspectRatioOrSize = body.aspect_ratio || body.ratio || body.size;
      deleteChatRaw = body.delete_chat_after_gen ?? body.deleteChatAfterGen;
      headlessRaw = body.headless;
      visibleBrowserRaw = body.visible_browser ?? body.visibleBrowser;
      browserRaw = body.browser ?? body.browser_type;

      customTimeout =
        typeof body.max_timeout === "number"
          ? body.max_timeout * 1000
          : typeof body.max_timeout_ms === "number"
          ? body.max_timeout_ms
          : typeof body.timeout === "number"
          ? body.timeout * 1000
          : typeof body.timeout_ms === "number"
          ? body.timeout_ms
          : undefined;
      idleTimeout =
        typeof body.idle_timeout === "number"
          ? body.idle_timeout * 1000
          : typeof body.idle_timeout_ms === "number"
          ? body.idle_timeout_ms
          : undefined;

      const rawImages: any[] = [];
      if (Array.isArray(body.image)) rawImages.push(...body.image);
      else if (body.image) rawImages.push(body.image);
      if (Array.isArray(body.images)) rawImages.push(...body.images);
      if (Array.isArray(body.input_images)) rawImages.push(...body.input_images);
      if (Array.isArray(body.reference_images)) rawImages.push(...body.reference_images);

      if (rawImages.length > 0) {
        const imagesToProcess = rawImages.slice(0, 5);
        let fileIdx = 0;
        for (const item of imagesToProcess) {
          fileIdx++;
          let strVal: string | null = null;
          if (typeof item === "string") {
            strVal = item.trim();
          } else if (typeof item === "object" && item !== null) {
            const candidate =
              item.b64_json ||
              item.url ||
              (typeof item.image_url === "string" ? item.image_url : item.image_url?.url);
            if (typeof candidate === "string") {
              strVal = candidate.trim();
            }
          }

          if (!strVal) continue;

          if (strVal.startsWith("http://") || strVal.startsWith("https://")) {
            throw new Error("Remote HTTP(S) image URLs are not supported. Please provide Base64 data URLs, raw Base64, or multipart file uploads.");
          }

          const match = strVal.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s);
          if (match) {
            const buf = Buffer.from(match[2], "base64");
            const detectedExt = detectImageExtension(buf);
            if (!detectedExt) {
              throw new Error("Invalid or unsupported base64 image format (expected JPEG, PNG, WebP, GIF)");
            }
            const tempPath = join(getTempDir(), `input-${fileIdx}${detectedExt}`);
            writeFileSync(tempPath, buf);
            tempFilesToClean.push(tempPath);
            inputImages.push(tempPath);
          } else if (isValidLocalImage(strVal)) {
            inputImages.push(resolve(strVal));
          } else {
            // Thử giải mã raw base64 an toàn không dùng regex ReDoS (RES-02)
            try {
              const trimmed = strVal.trim();
              if (trimmed.length >= 20 && trimmed.length <= 50 * 1024 * 1024) {
                const buf = Buffer.from(trimmed, "base64");
                if (buf.length >= 4) {
                  const ext = detectImageExtension(buf);
                  if (ext) {
                    const tempPath = join(getTempDir(), `input-${fileIdx}${ext}`);
                    writeFileSync(tempPath, buf);
                    tempFilesToClean.push(tempPath);
                    inputImages.push(tempPath);
                  }
                }
              }
            } catch {}
          }
        }
      }
    }

    const deleteChatAfterGen =
      typeof deleteChatRaw === "boolean"
        ? deleteChatRaw
        : typeof deleteChatRaw === "string"
        ? !["false", "0", "no", "off"].includes(deleteChatRaw.trim().toLowerCase())
        : undefined;

    let headless: boolean | undefined = undefined;
    if (headlessRaw !== undefined && headlessRaw !== null) {
      headless =
        typeof headlessRaw === "boolean"
          ? headlessRaw
          : typeof headlessRaw === "string"
          ? !["false", "0", "no", "off"].includes(headlessRaw.trim().toLowerCase())
          : undefined;
    } else if (visibleBrowserRaw !== undefined && visibleBrowserRaw !== null) {
      const isVisible =
        typeof visibleBrowserRaw === "boolean"
          ? visibleBrowserRaw
          : typeof visibleBrowserRaw === "string"
          ? !["false", "0", "no", "off"].includes(visibleBrowserRaw.trim().toLowerCase())
          : undefined;
      if (isVisible !== undefined) {
        headless = !isVisible;
      }
    }

    const browser = normalizeBrowserChoice(typeof browserRaw === "string" ? browserRaw : undefined);

    return {
      prompt,
      n,
      aspectRatioOrSize,
      deleteChatAfterGen,
      headless,
      browser,
      customTimeout,
      idleTimeout,
      tempFilesToClean,
      inputImages,
    };
  } catch (err) {
    // RES-01: Dọn dẹp sạch sẽ temp folder và files nếu quá trình parse bị throw
    cleanupTempFiles(tempFilesToClean);
    throw err;
  }
}


const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = "127.0.0.1";
const REQUIRED_API_KEY = process.env.API_KEY || "sk-local";

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : "http://127.0.0.1";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, User-Agent",
    "Vary": "Origin",
  };
}

function formatOpenAIError(message: string, type: string = "invalid_request_error", code: string | null = null) {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

// Hàng đợi tuần tự (FIFO Queue) để chống xung đột SingletonLock của Chromium
let taskQueue: Promise<unknown> = Promise.resolve();
let isLoginQueued = false;
let isLoggingIn = false;

export function enqueueTask<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Yêu cầu đã bị hủy bởi client trước khi thực thi (Client aborted request)"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Yêu cầu đã bị hủy bởi client trước khi thực thi (Client aborted request)"));
      }
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    taskQueue = taskQueue
      .then(async () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (settled || signal?.aborted) return;
        try {
          const result = await task();
          settled = true;
          resolve(result);
        } catch (err) {
          settled = true;
          reject(err);
        } finally {
          // Settle delay giữa các lượt liên tiếp để Windows OS dọn sạch tiến trình browser cũ và ChatGPT backend ổn định phiên
          await new Promise((r) => setTimeout(r, 500));
        }
      })
      .catch(() => {});
  });
}

// Cấu trúc regex nhận diện và bóc sạch câu ratio theo 14 ngôn ngữ và các cờ shorthand phổ biến (--ar, --aspect-ratio, v.v.)
const RATIO_LANGUAGE_PREFIXES_PATTERN =
  "Set the aspect ratio to|Đặt tỷ lệ khung hình thành|将宽高比设为|將寬高比設為|アスペクト比を|화면 비율을|Establece la relación de aspecto en|Defina a proporção da imagem como|Réglez le rapport largeur\\/hauteur sur|Stelle das Seitenverhältnis auf|Установите соотношение сторон|Imposta le proporzioni su|पक्षानुपात को";

const RATIO_SHORTHAND_PATTERN =
  "--ar|-ar|(?:--|-)?aspect[_\\s-]*ratio(?:[:=]|\\s+to)?";

const RATIO_NUMBER_PATTERN =
  "[0-9]+(?:\\.[0-9]+)?\\s*:\\s*[0-9]+(?:\\.[0-9]+)?";

export const ratioRegex = new RegExp(
  `(?:(?:${RATIO_LANGUAGE_PREFIXES_PATTERN})\\s*${RATIO_NUMBER_PATTERN}(?:\\s*に設定してください|\\s*로 설정하세요|\\s*ein|\\s*पर सेट करें)?[.\\u3002\\u0964]?)|(?:(?:${RATIO_SHORTHAND_PATTERN})\\s*${RATIO_NUMBER_PATTERN}[.\\u3002\\u0964]?)`,
  "gi"
);

const EXTRACT_RATIO_REGEX = new RegExp(
  `(?:(?:${RATIO_LANGUAGE_PREFIXES_PATTERN})|(?:${RATIO_SHORTHAND_PATTERN}))\\s*(${RATIO_NUMBER_PATTERN})`,
  "i"
);

export function extractRatioFromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(EXTRACT_RATIO_REGEX);
  return match?.[1] ? match[1].replace(/\s+/g, "") : null;
}

const ORIGINAL_PROMPT_MARKERS = [
  "Original user prompt:",
  "用户原始提示词：",
  "使用者原始提示詞：",
  "ユーザーの元のプロンプト：",
  "사용자의 원본 프롬프트:",
  "Prompt original del usuario:",
  "Prompt original do usuário:",
  "Prompt original de l’utilisateur :",
  "Prompt original de l'utilisateur :",
  "Ursprünglicher Benutzer-Prompt:",
  "Исходный промпт пользователя:",
  "Prompt originale dell'utente:",
  "उपयोगकर्ता का मूल प्रॉम्प्ट:",
  "Prompt gốc của người dùng:",
];

export function cleanAndUnwrapPrompt(rawPrompt: string): string {
  let prompt = rawPrompt.trim();
  for (const marker of ORIGINAL_PROMPT_MARKERS) {
    if (prompt.includes(marker)) {
      const afterMarker = prompt.slice(prompt.indexOf(marker) + marker.length).trim();
      if (afterMarker) {
        prompt = afterMarker;
        break;
      }
    }
  }

  // Bóc sạch bất kỳ câu ratio tự động và câu chống grid nào
  prompt = prompt
    .replace(ratioRegex, "")
    .replace(
      /\s*Do not combine (?:the \d+ (?:images|variations)|them) into a single grid or collage(?:;\s*output each as a separate image)?[.!?]?/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .trim();

  // Bóc sạch vỏ variations wrapper nếu prompt đã từng bị wrap
  const varMatch = prompt.match(
    /^generate exactly \d+ (?:distinct|separate individual) (?:creative )?variations of the attached image(?::\s*(.*)|[.!?\u3002\u0964\uFF01\uFF1F]?)$/i
  );
  if (varMatch) {
    return (varMatch[1] || "").trim();
  }

  // Bóc sạch vỏ text-to-image wrapper nếu prompt đã từng bị wrap
  const imgMatch = prompt.match(
    /^generate (?:an image of|exactly \d+ (?:distinct|separate individual) images of):\s*(.*)$/i
  );
  if (imgMatch) {
    return (imgMatch[1] || "").trim();
  }

  if (
    /^generate (?:a creative variation of the attached image|exactly \d+ (?:distinct|separate individual) (?:creative )?images)[.!?\u3002\u0964\uFF01\uFF1F]?$/i.test(
      prompt
    )
  ) {
    return "";
  }

  return prompt;
}

export function buildGenerationPrompt(options: {
  prompt: string;
  aspectRatioOrSize?: string | null;
  hasInputImages: boolean;
  n: number;
}): string {
  const cleanPrompt = cleanAndUnwrapPrompt(options.prompt);
  const separator = cleanPrompt ? (/[.!?\u3002\u0964\uFF01\uFF1F]$/.test(cleanPrompt) ? "" : ".") : "";

  if (options.hasInputImages) {
    if (options.n > 1) {
      const antiGridSuffix = ` Do not combine the ${options.n} variations into a single grid or collage; output each as a separate image.`;
      if (!cleanPrompt) {
        return `Generate exactly ${options.n} separate individual creative variations of the attached image.${antiGridSuffix}`;
      }
      return `Generate exactly ${options.n} separate individual variations of the attached image: ${cleanPrompt}${separator}${antiGridSuffix}`;
    }
    return cleanPrompt || "Generate a creative variation of the attached image.";
  }

  // Text-to-image (vẽ mới)
  const rawAspect = options.aspectRatioOrSize;
  const rawRatioStr = String(rawAspect || "").trim().toLowerCase();
  const isExplicitNoneRatio =
    rawRatioStr === "none" ||
    rawRatioStr === "off" ||
    rawRatioStr === "null" ||
    rawRatioStr === "auto" ||
    rawRatioStr === "undefined";

  let ratioInstruction = "";
  if (!isExplicitNoneRatio) {
    const detectedRatio = sizeToAspectRatio(rawAspect);
    if (detectedRatio) {
      ratioInstruction = ` Set the aspect ratio to ${detectedRatio}.`;
    } else {
      const promptRatio = extractRatioFromText(options.prompt);
      if (promptRatio) {
        ratioInstruction = ` Set the aspect ratio to ${promptRatio}.`;
      }
    }
  }

  if (!cleanPrompt) {
    if (options.n > 1) {
      return `Generate exactly ${options.n} separate individual creative images. Do not combine the ${options.n} images into a single grid or collage; output each as a separate image.${ratioInstruction}`;
    }
    return `Generate a creative image.${ratioInstruction}`;
  }

  if (options.n > 1) {
    return `Generate exactly ${options.n} separate individual images of: ${cleanPrompt}${separator} Do not combine the ${options.n} images into a single grid or collage; output each as a separate image.${ratioInstruction}`;
  }
  return `Generate an image of: ${cleanPrompt}${separator}${ratioInstruction}`;
}

export async function handleRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/$/, "");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Health check endpoint
  if (pathname === "/health" || pathname === "/api/health") {
    return Response.json(
      { status: "ok", service: "chatgpt-image-bridge", timestamp: Date.now() },
      { headers: corsHeaders }
    );
  }

  // Auth status endpoint
  if (pathname === "/auth/status" || pathname === "/api/auth/status") {
    const loggedIn = isSessionCached();
    return Response.json(
      {
        status: "ok",
        logged_in: loggedIn,
        is_logging_in: isLoggingIn || isLoginQueued,
        available_browsers: getAvailableBrowsers(),
      },
      { headers: corsHeaders }
    );
  }

  // Trigger login endpoint (chống CSRF từ web bên ngoài kích hoạt popup Chromium)
  if (pathname === "/auth/login" || pathname === "/api/auth/login") {
    const origin = req.headers.get("origin");
    const secFetchSite = req.headers.get("sec-fetch-site");
    if ((origin && !isAllowedOrigin(origin)) || origin === "null" || secFetchSite === "cross-site") {
      return Response.json(
        { error: "Forbidden: Cross-site or sandboxed request rejected" },
        { status: 403, headers: corsHeaders }
      );
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }
    if (isLoginQueued || isLoggingIn) {
      return Response.json(
        { ok: false, message: "Trình duyệt đăng nhập đang được mở sẵn hoặc đã nằm trong hàng đợi." },
        { headers: corsHeaders }
      );
    }

    let preferredBrowser: "chrome" | "edge" | undefined;
    try {
      const url = new URL(req.url);
      let browserParam = url.searchParams.get("browser") || "";
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = (await req.json().catch(() => ({}))) as any;
        const rawBrowser = body?.browser ?? body?.browser_type;
        if (typeof rawBrowser === "string") {
          browserParam = rawBrowser;
        }
      }
      if (browserParam) {
        preferredBrowser = normalizeBrowserChoice(browserParam);
      }
    } catch {}

    isLoginQueued = true;
    try {
      let loginResult: any = null;
      await enqueueTask(async () => {
        isLoggingIn = true;
        try {
          console.log(`🔑 [Bridge] Nhận yêu cầu mở trình duyệt ${preferredBrowser || "mặc định"} đăng nhập từ WebUI...`);
          loginResult = await handleLogin(300_000, preferredBrowser);
        } finally {
          isLoggingIn = false;
        }
      });
      return Response.json(
        {
          ok: true,
          message: loginResult?.message || "Đăng nhập thành công!",
          actual_browser: loginResult?.actualBrowser,
          selected_browser: loginResult?.selectedBrowser,
          fallback_used: Boolean(loginResult?.fallbackUsed),
        },
        { headers: corsHeaders }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("❌ [Bridge] Lỗi khi đăng nhập:", msg);
      return Response.json(
        { ok: false, error: msg },
        { status: 500, headers: corsHeaders }
      );
    } finally {
      isLoginQueued = false;
    }
  }

  // Continuation trigger endpoint: /auth/login-done
  if (pathname === "/auth/login-done" || pathname === "/api/auth/login-done") {
    const origin = req.headers.get("origin");
    const secFetchSite = req.headers.get("sec-fetch-site");
    if ((origin && !isAllowedOrigin(origin)) || origin === "null" || secFetchSite === "cross-site") {
      return Response.json(
        { error: "Forbidden: Cross-site or sandboxed request rejected" },
        { status: 403, headers: corsHeaders }
      );
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }
    const notified = notifyLoginContinuation();
    return Response.json(
      {
        ok: true,
        notified,
        message: notified ? "Đã gửi tín hiệu hoàn tất đăng nhập." : "Không có phiên đăng nhập nào đang chờ.",
      },
      { headers: corsHeaders }
    );
  }

  // OpenAI Models list
  if (pathname === "/v1/models" || pathname === "/models") {
    return Response.json(
      {
        object: "list",
        data: [
          { id: "gpt-image-2", object: "model", owned_by: "chatgpt-web" },
          { id: "gpt-image", object: "model", owned_by: "chatgpt-web" },
        ],
      },
      { headers: corsHeaders }
    );
  }

  // OpenAI Images Generations & Edits & Variations endpoint
  const isImagesEndpoint =
    pathname === "/v1/images/generations" ||
    pathname === "/images/generations" ||
    pathname === "/v1/images/edits" ||
    pathname === "/images/edits" ||
    pathname === "/v1/images/variations" ||
    pathname === "/images/variations";

  if (isImagesEndpoint) {
    if (req.method !== "POST") {
      return Response.json(
        formatOpenAIError("Only POST method is accepted for this endpoint.", "invalid_request_error", "method_not_allowed"),
        { status: 405, headers: { ...corsHeaders, Allow: "POST, OPTIONS" } }
      );
    }
    if (isLoggingIn || isLoginQueued) {
      return Response.json(
        formatOpenAIError(
          "ChatGPT Bridge is currently in login mode. Please complete the login process in the browser first.",
          "server_error",
          "bridge_logging_in"
        ),
        { status: 423, headers: corsHeaders }
      );
    }
    // 1. Kiểm tra xác thực Bearer Token
    const authHeader = req.headers.get("Authorization") || "";
    const authMatch = authHeader.match(/^bearer\s+(.+)$/i);
    const token = authMatch ? authMatch[1].trim() : "";

    if (REQUIRED_API_KEY) {
      const keyBuffer = Buffer.from(REQUIRED_API_KEY);
      const tokenBuffer = Buffer.from(token);
      const isKeyValid =
        keyBuffer.length === tokenBuffer.length &&
        crypto.timingSafeEqual(keyBuffer, tokenBuffer);
      if (!isKeyValid) {
        return Response.json(
          formatOpenAIError(
            "Incorrect API key provided. You must provide a valid API key (default: Bearer sk-local).",
            "invalid_request_error",
            "invalid_api_key"
          ),
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // 2. Parse request (hỗ trợ cả application/json lẫn multipart/form-data)
    let parsed: ParsedImageRequest;
    try {
      parsed = await parseImageRequest(req);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return Response.json(
        formatOpenAIError(`Failed to parse request: ${msg}`, "invalid_request_error"),
        { status: 400, headers: corsHeaders }
      );
    }

    const hasInputImages = parsed.inputImages.length > 0;

    if ((pathname.includes("edits") || pathname.includes("variations")) && !hasInputImages) {
      cleanupTempFiles(parsed.tempFilesToClean);
      return Response.json(
        formatOpenAIError("image is required for image edits/variations", "invalid_request_error", "missing_image"),
        { status: 400, headers: corsHeaders }
      );
    }

    let prompt = parsed.prompt;
    if (!prompt && pathname.includes("variations")) {
      prompt = "Generate a creative variation of the attached image";
    }

    if (!prompt || typeof prompt !== "string") {
      cleanupTempFiles(parsed.tempFilesToClean);
      return Response.json(
        formatOpenAIError("Prompt is required and must be a string", "invalid_request_error", "missing_prompt"),
        { status: 400, headers: corsHeaders }
      );
    }

    const generationPrompt = buildGenerationPrompt({
      prompt,
      aspectRatioOrSize: parsed.aspectRatioOrSize,
      hasInputImages,
      n: parsed.n,
    });

    // 2.5 Kiểm tra phiên đăng nhập sớm (Fail-fast trong 1ms thay vì tốn 30s mở browser)
    if (!isSessionCached()) {
      cleanupTempFiles(parsed.tempFilesToClean);
      return Response.json(
        formatOpenAIError(
          "Chưa phát hiện phiên đăng nhập ChatGPT hợp lệ trên hệ thống. Vui lòng bấm [🔑 Đăng nhập ChatGPT] trên WebUI hoặc chạy 'bun login' trên terminal để đăng nhập trước khi tạo ảnh.",
          "authentication_error",
          "unauthorized"
        ),
        { status: 401, headers: corsHeaders }
      );
    }

    console.log(
      `\n📥 [Bridge] Nhận request (${pathname}) từ client (Số lượng yêu cầu: ${parsed.n}, Ảnh tham chiếu: ${parsed.inputImages.length}, Xoá chat sau khi tạo: ${parsed.deleteChatAfterGen ?? "mặc định"})!`
    );
    console.log(`📝 Prompt gửi đi: "${generationPrompt}"`);

    try {
      // 3. Xếp hàng tạo ảnh tuần tự để tránh xung đột SingletonLock của Chrome
      const headless =
        parsed.headless !== undefined
          ? parsed.headless
          : process.env.HEADLESS === "true";

      const results = await enqueueTask(
        () =>
          generateImage(generationPrompt, {
            headless,
            browser: parsed.browser,
            timeoutMs: parsed.customTimeout,
            idleTimeoutMs: parsed.idleTimeout,
            deleteChatAfterGen: parsed.deleteChatAfterGen,
            inputImages: parsed.inputImages,
            expectedCount: parsed.n,
            skipDiskWrite: true,
            signal: req.signal,
          }),
        req.signal
      );

      console.log(`✅ [Bridge] Đã tạo thành công ${results.length} ảnh. Trả dữ liệu Base64 về cho client...`);

      // 4. Trả về đúng chuẩn OpenAI schema (b64_json, url, revised_prompt) trực tiếp từ RAM
      // Trường url luôn dùng Data URL an toàn để mọi client bên ngoài không bị dính 403 Forbidden từ Estuary CDN
      const dataItems = results.map((item) => {
        let mime = "image/png";
        try {
          const head = Buffer.from(item.base64.slice(0, 32), "base64");
          const ext = detectImageExtension(head);
          if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
          else if (ext === ".webp") mime = "image/webp";
          else if (ext === ".gif") mime = "image/gif";
        } catch {}
        return {
          b64_json: item.base64,
          url: `data:${mime};base64,${item.base64}`,
          revised_prompt: prompt,
        };
      });

      return Response.json(
        {
          created: Math.floor(Date.now() / 1000),
          data: dataItems,
        },
        { headers: corsHeaders }
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("❌ [Bridge] Lỗi khi tạo ảnh:", errorMsg);

      const isTextRefusal = errorMsg.startsWith("ChatGPT không tạo ảnh mà trả lời bằng văn bản:");
      const isAuthError =
        !isTextRefusal &&
        (errorMsg.includes("Phiên đăng nhập") ||
          /session has expired|Your session has expired|log in again|chưa có hoặc đã hết hạn/i.test(errorMsg));
      const status = isAuthError ? 401 : 500;
      if (status === 401) {
        clearSessionVerified(false);
      }
      const errorType = status === 401 ? "authentication_error" : "server_error";

      return Response.json(
        formatOpenAIError(errorMsg, errorType),
        { status, headers: corsHeaders }
      );
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
    }
  }

  return Response.json(
    formatOpenAIError(`Endpoint ${pathname} not found`, "invalid_request_error", "not_found"),
    { status: 404, headers: corsHeaders }
  );
}

export function startServer(port: number = PORT, hostname: string = HOSTNAME) {
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    fetch: handleRequest,
  });

  console.log("=================================================");
  console.log(`🚀 ChatGPT Image Local Bridge Server đã sẵn sàng!`);
  console.log(`📡 URL lắng nghe: http://${hostname}:${port}`);
  const maskedKey =
    REQUIRED_API_KEY === "sk-local"
      ? REQUIRED_API_KEY
      : `${REQUIRED_API_KEY.slice(0, 5)}...${REQUIRED_API_KEY.slice(-4)}`;
  console.log(`🔑 Yêu cầu Token: Bearer ${maskedKey}`);
  console.log(`🔌 OpenAI Base URL cho iLab CONJURE: http://${hostname}:${port}/v1`);
  console.log(`📌 Endpoints:`);
  console.log(`   - Generations: http://${hostname}:${port}/v1/images/generations`);
  console.log(`   - Edits:       http://${hostname}:${port}/v1/images/edits`);
  console.log("=================================================");
  return server;
}

if (import.meta.main) {
  let isCleaned = false;
  const cleanup = () => {
    if (isCleaned) return;
    isCleaned = true;
    try {
      cleanupActiveBrowsers();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    if (!isCleaned) {
      isCleaned = true;
      try {
        cleanupActiveBrowsers();
      } catch {}
    }
  });

  startServer();
}
