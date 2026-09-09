import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { cleanupActiveBrowsers } from "./browser.js";
import { handleRequest } from "./server.js";

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const DEFAULT_HOSTNAME = "127.0.0.1";

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export function toFetchRequest(
  request: IncomingMessage,
  hostname: string,
  port: number,
  signal: AbortSignal
): Request {
  const method = request.method || "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(request),
    signal,
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(new URL(request.url || "/", `http://${hostname}:${port}`), init);
}

async function writeFetchResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  if (response.statusText) target.statusMessage = response.statusText;

  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie?.call(response.headers) || [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);
  });
  if (setCookies.length > 0) target.setHeader("set-cookie", setCookies);

  if (!response.body) {
    target.end();
    return;
  }

  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    target
  );
}

function logServerReady(server: Server, hostname: string): void {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
  const requiredApiKey = process.env.API_KEY || "sk-local";
  const maskedKey = requiredApiKey === "sk-local"
    ? requiredApiKey
    : `${requiredApiKey.slice(0, 5)}...${requiredApiKey.slice(-4)}`;

  console.log("=================================================");
  console.log("🚀 ChatGPT Image Local Bridge Server đã sẵn sàng!");
  console.log(`📡 URL lắng nghe: http://${hostname}:${port}`);
  console.log(`🔑 Yêu cầu Token: Bearer ${maskedKey}`);
  console.log(`🔌 OpenAI Base URL cho iLab CONJURE: http://${hostname}:${port}/v1`);
  console.log("📌 Endpoints:");
  console.log(`   - Generations: http://${hostname}:${port}/v1/images/generations`);
  console.log(`   - Edits:       http://${hostname}:${port}/v1/images/edits`);
  console.log("=================================================");
}

export function startServer(port: number = DEFAULT_PORT, hostname: string = DEFAULT_HOSTNAME): Server {
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    request.once("aborted", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortRequest();
    });

    try {
      const fetchRequest = toFetchRequest(request, hostname, port, controller.signal);
      const fetchResponse = await handleRequest(fetchRequest);
      await writeFetchResponse(fetchResponse, response);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("❌ [Bridge] Lỗi khi xử lý yêu cầu:", error instanceof Error ? error.message : String(error));
      }
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: { message: "Internal Server Error", type: "server_error" } }));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    } finally {
      request.off("aborted", abortRequest);
    }
  });

  server.requestTimeout = 0;
  server.timeout = 0;
  server.once("listening", () => logServerReady(server, hostname));
  server.listen(port, hostname);
  return server;
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath && resolve(entryPath) === resolve(fileURLToPath(import.meta.url)));
}

if (isMainModule()) {
  const server = startServer();
  let isCleaned = false;
  const cleanup = () => {
    if (isCleaned) return;
    isCleaned = true;
    try {
      cleanupActiveBrowsers();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    if (isCleaned) return;
    isCleaned = true;
    try {
      cleanupActiveBrowsers();
    } catch {}
  });
}
