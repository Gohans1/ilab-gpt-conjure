import { generateImage } from "./generator.js";

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

function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    taskQueue = taskQueue.then(() => task().then(resolve, reject)).catch(() => {});
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
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

    // OpenAI Images Generations endpoint
    if (
      (pathname === "/v1/images/generations" || pathname === "/images/generations") &&
      req.method === "POST"
    ) {
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

      // 2. Parse body
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      const prompt = body.prompt;
      const n = typeof body.n === "number" && body.n > 1 ? body.n : 1;

      if (!prompt || typeof prompt !== "string") {
        return Response.json(
          formatOpenAIError("Prompt is required and must be a string", "invalid_request_error", "missing_prompt"),
          { status: 400, headers: corsHeaders }
        );
      }

      let generationPrompt = prompt;
      if (n > 1 && !new RegExp(`\\b${n}\\s*(ảnh|images?|pictures?|photos?)\\b`, "i").test(prompt)) {
        generationPrompt = `${prompt} (Tạo chính xác ${n} bức ảnh / Generate exactly ${n} images)`;
      }

      console.log(`\n📥 [Bridge] Nhận request tạo ảnh từ iLab CONJURE (Số lượng yêu cầu: ${n})!`);
      console.log(`📝 Prompt gửi đi: "${generationPrompt}"`);

      try {
        // 3. Xếp hàng tạo ảnh tuần tự để tránh xung đột SingletonLock của Chrome
        const headless = process.env.HEADLESS === "true";
        const results = await enqueueTask(() => generateImage(generationPrompt, { headless }));

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
      }
    }

    return Response.json(
      formatOpenAIError(`Endpoint ${pathname} not found`, "invalid_request_error", "not_found"),
      { status: 404, headers: corsHeaders }
    );
  },
});

console.log("=================================================");
console.log(`🚀 ChatGPT Image Local Bridge Server đã sẵn sàng!`);
console.log(`📡 URL lắng nghe: http://${HOSTNAME}:${PORT}`);
console.log(`🔑 Yêu cầu Token: Bearer ${REQUIRED_API_KEY}`);
console.log(`🔌 OpenAI Base URL cho iLab CONJURE: http://${HOSTNAME}:${PORT}/v1`);
console.log(`📌 Endpoint: http://${HOSTNAME}:${PORT}/v1/images/generations`);
console.log("=================================================");
