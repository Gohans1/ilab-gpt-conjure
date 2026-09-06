import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, sizeToAspectRatio } from "./generator.js";
import { handleLogin } from "./cli.js";
import { isSessionCached } from "./check-session.js";

export interface ParsedImageRequest {
  prompt: string;
  n: number;
  aspectRatioOrSize?: string;
  deleteChatAfterGen?: boolean;
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
    if (!existsSync(filePath)) return false;
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    const lower = filePath.toLowerCase();
    const dotIdx = lower.lastIndexOf(".");
    if (dotIdx === -1) return false;
    return VALID_IMAGE_EXTENSIONS.has(lower.slice(dotIdx));
  } catch {
    return false;
  }
}

function detectImageExtension(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return ".png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return ".jpg";
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return ".gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return ".png";
}

export async function parseImageRequest(req: Request): Promise<ParsedImageRequest> {
  const contentType = req.headers.get("content-type") || "";
  const tempFilesToClean: string[] = [];
  const inputImages: string[] = [];

  let prompt = "";
  let n = 1;
  let aspectRatioOrSize: string | undefined;
  let deleteChatRaw: any;
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

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    prompt = String(formData.get("prompt") || "");
    const nRaw = formData.get("n");
    if (nRaw) n = Number(nRaw) || 1;

    aspectRatioOrSize = (formData.get("aspect_ratio") || formData.get("ratio") || formData.get("size")) as string | undefined;
    deleteChatRaw = formData.get("delete_chat_after_gen") ?? formData.get("deleteChatAfterGen");

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
      let fileIdx = 0;
      for (const file of fileEntries) {
        fileIdx++;
        const ext = file.name?.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : ".png";
        const tempPath = join(getTempDir(), `input-${fileIdx}${ext}`);
        const arrayBuffer = await file.arrayBuffer();
        writeFileSync(tempPath, Buffer.from(arrayBuffer));
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
    if (body.image) rawImages.push(body.image);
    if (Array.isArray(body.images)) rawImages.push(...body.images);
    if (Array.isArray(body.input_images)) rawImages.push(...body.input_images);
    if (Array.isArray(body.reference_images)) rawImages.push(...body.reference_images);

    if (rawImages.length > 0) {
      let fileIdx = 0;
      for (const item of rawImages) {
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

        const match = strVal.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s);
        if (match) {
          const ext = `.${match[1] === "jpeg" ? "jpg" : match[1]}`;
          const tempPath = join(getTempDir(), `input-${fileIdx}${ext}`);
          writeFileSync(tempPath, Buffer.from(match[2], "base64"));
          tempFilesToClean.push(tempPath);
          inputImages.push(tempPath);
        } else if (isValidLocalImage(strVal)) {
          inputImages.push(strVal);
        } else {
          // Thử giải mã raw base64 (ví dụ b64_json không có data:image prefix)
          try {
            const cleanB64 = strVal.replace(/\s+/g, "");
            if (cleanB64.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(cleanB64)) {
              const buf = Buffer.from(cleanB64, "base64");
              if (buf.length > 0) {
                const ext = detectImageExtension(buf);
                const tempPath = join(getTempDir(), `input-${fileIdx}${ext}`);
                writeFileSync(tempPath, buf);
                tempFilesToClean.push(tempPath);
                inputImages.push(tempPath);
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

  return {
    prompt,
    n,
    aspectRatioOrSize,
    deleteChatAfterGen,
    customTimeout,
    idleTimeout,
    tempFilesToClean,
    inputImages,
  };
}

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = "127.0.0.1";
const REQUIRED_API_KEY = process.env.API_KEY || "sk-local";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, User-Agent",
};

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
let isLoggingIn = false;

function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    taskQueue = taskQueue.then(() => task().then(resolve, reject)).catch(() => {});
  });
}

export async function handleRequest(req: Request): Promise<Response> {
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
      { status: "ok", logged_in: loggedIn, is_logging_in: isLoggingIn },
      { headers: corsHeaders }
    );
  }

  // Trigger login endpoint
  if (pathname === "/auth/login" || pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }
    if (isLoggingIn) {
      return Response.json(
        { ok: false, message: "Trình duyệt đăng nhập đang được mở sẵn." },
        { headers: corsHeaders }
      );
    }
    isLoggingIn = true;
    try {
      console.log("🔑 [Bridge] Nhận yêu cầu mở trình duyệt đăng nhập từ WebUI...");
      await enqueueTask(() => handleLogin());
      return Response.json({ ok: true, message: "Đăng nhập thành công!" }, { headers: corsHeaders });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("❌ [Bridge] Lỗi khi đăng nhập:", msg);
      return Response.json(
        { ok: false, error: msg },
        { status: 500, headers: corsHeaders }
      );
    } finally {
      isLoggingIn = false;
    }
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

  if (isImagesEndpoint && req.method === "POST") {
    if (isLoggingIn) {
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
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (REQUIRED_API_KEY && token !== REQUIRED_API_KEY) {
      return Response.json(
        formatOpenAIError(
          "Incorrect API key provided. You must provide a valid API key (default: Bearer sk-local).",
          "invalid_request_error",
          "invalid_api_key"
        ),
        { status: 401, headers: corsHeaders }
      );
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

    if ((pathname.includes("edits") || pathname.includes("variations")) && parsed.inputImages.length === 0) {
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

    // 2.1 Bóc tách prompt sạch (loại bỏ rác Prompt fidelity guidance nếu có)
    let cleanPrompt = prompt.trim();
    const marker = "Original user prompt:";
    if (cleanPrompt.includes(marker)) {
      const afterMarker = cleanPrompt.slice(cleanPrompt.indexOf(marker) + marker.length).trim();
      if (afterMarker) {
        cleanPrompt = afterMarker;
      }
    }

    // Giữ lại câu aspect ratio nếu có trong prompt hoặc trích xuất từ body
    let ratioInstruction = "";
    const ratioMatch = cleanPrompt.match(/(?:Set the aspect ratio to|Đặt tỷ lệ khung hình thành)\s+[0-9]+:[0-9]+\.?/i);
    if (ratioMatch) {
      ratioInstruction = ` ${ratioMatch[0].trim()}`;
      cleanPrompt = cleanPrompt.replace(ratioMatch[0], "").trim();
    } else {
      const detectedRatio = sizeToAspectRatio(parsed.aspectRatioOrSize);
      if (detectedRatio) {
        ratioInstruction = ` Set the aspect ratio to ${detectedRatio}.`;
      }
    }

    // 2.2 Bọc mệnh lệnh vẽ và số lượng n
    let generationPrompt: string;
    const separator = /[.!?]$/.test(cleanPrompt) ? "" : ".";
    const hasInputImages = parsed.inputImages.length > 0;
    const prefix = hasInputImages ? "Based on the attached reference image(s), " : "";

    if (parsed.n > 1) {
      generationPrompt = `${prefix}Generate exactly ${parsed.n} distinct images of: ${cleanPrompt}${separator}${ratioInstruction}`;
    } else {
      generationPrompt = `${prefix}Generate an image of: ${cleanPrompt}${separator}${ratioInstruction}`;
    }

    console.log(
      `\n📥 [Bridge] Nhận request (${pathname}) từ client (Số lượng yêu cầu: ${parsed.n}, Ảnh tham chiếu: ${parsed.inputImages.length}, Xoá chat sau khi tạo: ${parsed.deleteChatAfterGen ?? "mặc định"})!`
    );
    console.log(`📝 Prompt gửi đi: "${generationPrompt}"`);

    try {
      // 3. Xếp hàng tạo ảnh tuần tự để tránh xung đột SingletonLock của Chrome
      const headless = process.env.HEADLESS === "true";

      const results = await enqueueTask(() =>
        generateImage(generationPrompt, {
          headless,
          timeoutMs: parsed.customTimeout,
          idleTimeoutMs: parsed.idleTimeout,
          deleteChatAfterGen: parsed.deleteChatAfterGen,
          inputImages: parsed.inputImages,
        })
      );

      console.log(`✅ [Bridge] Đã tạo thành công ${results.length} ảnh. Trả dữ liệu Base64 về cho client...`);

      // 4. Trả về đúng chuẩn OpenAI schema (b64_json, revised_prompt) trực tiếp từ RAM, không đọc lại từ đĩa
      const dataItems = results.map((item) => ({
        b64_json: item.base64,
        revised_prompt: prompt,
      }));

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

      const status = errorMsg.includes("Phiên đăng nhập") ? 401 : 500;
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
  console.log(`🔑 Yêu cầu Token: Bearer ${REQUIRED_API_KEY}`);
  console.log(`🔌 OpenAI Base URL cho iLab CONJURE: http://${hostname}:${port}/v1`);
  console.log(`📌 Endpoints:`);
  console.log(`   - Generations: http://${hostname}:${port}/v1/images/generations`);
  console.log(`   - Edits:       http://${hostname}:${port}/v1/images/edits`);
  console.log("=================================================");
  return server;
}

if (import.meta.main) {
  startServer();
}
