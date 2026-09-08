import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { Page } from "playwright-core";

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  url: string;
  base64: string;
}

export interface ExtractOptions {
  knownUrls?: string[];
  skipDiskWrite?: boolean;
}

export function isAllowedImageUrl(url: string): boolean {
  if (url.startsWith("blob:")) return true;
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return (
      u.hostname === "chatgpt.com" ||
      u.hostname.endsWith(".chatgpt.com") ||
      u.hostname === "openai.com" ||
      u.hostname.endsWith(".openai.com") ||
      u.hostname === "oaiusercontent.com" ||
      u.hostname.endsWith(".oaiusercontent.com") ||
      u.hostname === "oaidalleapiprodscus.blob.core.windows.net" ||
      /^oaidallea(pi)?prod[a-z0-9]+\.blob\.core\.windows\.net$/.test(u.hostname)
    );
  } catch {
    return false;
  }
}

export function rewriteEstuaryUrl(src: string): string {
  try {
    const u = new URL(src);
    if (u.pathname.includes("backend-api/estuary")) {
      u.searchParams.set("p", "fs");
      return u.toString();
    }
  } catch {}
  return src;
}

export function resolveOutputFilePath(baseOutputPath: string, index: number, totalCount: number): string {
  const parsed = parse(baseOutputPath);
  const defaultExt = parsed.ext || ".png";
  const parentDir = dirname(baseOutputPath);
  return totalCount === 1
    ? (parsed.ext ? baseOutputPath : `${baseOutputPath}${defaultExt}`)
    : join(parentDir, `${parsed.name}_${index}${defaultExt}`);
}

export async function extractAndSaveImages(
  page: Page,
  imageSelector: string,
  baseOutputPath: string,
  options: ExtractOptions = {}
): Promise<DownloadResult[]> {
  const knownUrls = options.knownUrls || [];
  const skipDiskWrite = options.skipDiskWrite ?? false;

  const extractedList = await page.evaluate(async ({ selector, existingUrls }) => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(selector));
    const validImages = images
      .filter((img) => !img.closest('[data-message-author-role="user"]') && !img.closest("form"))
      .filter((img) => {
        const src = img.src || img.getAttribute("src") || "";
        return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("blob:");
      });

    const knownSet = new Set(existingUrls);
    const knownKeys = new Set(existingUrls.map((u) => {
      const match = u.match(/[?&]id=([^&]+)/);
      return match ? match[1] : u;
    }));
    const fileMap = new Map<string, string>();

    for (const img of validImages) {
      const src = img.src || img.getAttribute("src") || "";
      const match = src.match(/[?&]id=([^&]+)/);
      const fileKey = match ? match[1] : src;

      if (knownSet.has(src) || knownKeys.has(fileKey)) continue;

      if (!fileMap.has(fileKey)) {
        let fullSizeUrl = src;
        try {
          const u = new URL(src);
          if (u.pathname.includes("backend-api/estuary")) {
            u.searchParams.set("p", "fs");
            fullSizeUrl = u.toString();
          }
        } catch {}
        fileMap.set(fileKey, fullSizeUrl);
      }
    }

    if (fileMap.size === 0) {
      return [];
    }

    const results = await Promise.all(
      Array.from(fileMap.values()).map(async (url) => {
        try {
          if (url.startsWith("data:")) {
            if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) {
              return { error: `Disallowed data URI format: only raster images are accepted`, url };
            }
            const commaIndex = url.indexOf(",");
            const base64 = commaIndex !== -1 ? url.slice(commaIndex + 1) : "";
            return { base64, url: "data-uri" };
          }

          if (!url.startsWith("blob:")) {
            try {
              const u = new URL(url);
              if (u.protocol !== "https:") {
                throw new Error(`Insecure image protocol: ${u.protocol}`);
              }
              const isAllowed =
                u.hostname === "chatgpt.com" ||
                u.hostname.endsWith(".chatgpt.com") ||
                u.hostname === "openai.com" ||
                u.hostname.endsWith(".openai.com") ||
                u.hostname === "oaiusercontent.com" ||
                u.hostname.endsWith(".oaiusercontent.com") ||
                u.hostname === "oaidalleapiprodscus.blob.core.windows.net" ||
                /^oaidallea(pi)?prod[a-z0-9]+\.blob\.core\.windows\.net$/.test(u.hostname);
              if (!isAllowed) {
                throw new Error(`Untrusted image CDN host: ${u.hostname}`);
              }
            } catch (e: any) {
              throw new Error(e?.message || `Invalid image URL: ${url}`);
            }
          }

          const isBlob = url.startsWith("blob:");
          let isSameOrigin = false;
          try {
            isSameOrigin = !isBlob && new URL(url, location.origin).origin === location.origin;
          } catch {}
          const fetchOptions: RequestInit = isBlob
            ? { signal: AbortSignal.timeout(15_000) }
            : {
                mode: "cors",
                credentials: isSameOrigin ? "include" : "same-origin",
                signal: AbortSignal.timeout(15_000),
              };
          const response = await fetch(url, fetchOptions);
          if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`);
          }
          const blob = await response.blob();

          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const res = reader.result as string;
              resolve(res.includes(",") ? res.split(",")[1] : res);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          return { base64, url };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err), url };
        }
      })
    );

    return results;
  }, { selector: imageSelector, existingUrls: knownUrls });

  if (extractedList.length === 0) {
    throw new Error("Không tìm thấy bất kỳ ảnh nào trên trang phù hợp với selector.");
  }

  const parentDir = dirname(baseOutputPath);
  if (!skipDiskWrite) {
    mkdirSync(parentDir, { recursive: true });
  }

  const downloadedResults: DownloadResult[] = [];
  const validItems = extractedList.filter((item) => !item.error && !!item.base64);

  for (const item of extractedList) {
    if (item.error || !item.base64) {
      console.warn(`⚠️ Bỏ qua 1 ảnh do lỗi tải: ${item.error || "Rỗng"} (${item.url})`);
    }
  }

  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const buffer = Buffer.from(item.base64!, "base64");
    const filePath = resolveOutputFilePath(baseOutputPath, i + 1, validItems.length);

    if (!skipDiskWrite) {
      writeFileSync(filePath, buffer);
    }

    downloadedResults.push({
      filePath,
      sizeBytes: buffer.length,
      url: item.url,
      base64: item.base64!,
    });
  }

  if (downloadedResults.length === 0) {
    throw new Error("Không thể tải thành công bất kỳ ảnh nào trong lượt này.");
  }

  return downloadedResults;
}
