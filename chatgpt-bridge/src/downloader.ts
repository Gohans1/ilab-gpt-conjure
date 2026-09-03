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
    const validImages = images.filter((img) => {
      const src = img.src || img.getAttribute("src") || "";
      return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:");
    });

    const knownSet = new Set(existingUrls);
    const fileMap = new Map<string, string>();

    for (const img of validImages) {
      const src = img.src || img.getAttribute("src") || "";
      if (knownSet.has(src)) continue;

      const match = src.match(/[?&]id=([^&]+)/);
      const fileKey = match ? match[1] : src;

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
      if (validImages.length > 0) {
        const lastSrc = validImages[validImages.length - 1].src;
        fileMap.set("last", lastSrc);
      } else {
        return [];
      }
    }

    const results: Array<{ base64?: string; error?: string; url: string }> = [];

    for (const [_, url] of fileMap.entries()) {
      try {
        if (url.startsWith("data:")) {
          const parts = url.split(",");
          results.push({ base64: parts[1], url: "data-uri" });
          continue;
        }

        const response = await fetch(url, { mode: "cors", credentials: "include" });
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

        results.push({ base64, url });
      } catch (err) {
        results.push({ error: err instanceof Error ? err.message : String(err), url });
      }
    }

    return results;
  }, { selector: imageSelector, existingUrls: knownUrls });

  if (extractedList.length === 0) {
    throw new Error("Không tìm thấy bất kỳ ảnh nào trên trang phù hợp với selector.");
  }

  const parentDir = dirname(baseOutputPath);
  if (!skipDiskWrite) {
    mkdirSync(parentDir, { recursive: true });
  }

  const parsed = parse(baseOutputPath);
  const downloadedResults: DownloadResult[] = [];

  for (let i = 0; i < extractedList.length; i++) {
    const item = extractedList[i];
    if (item.error || !item.base64) {
      console.warn(`⚠️ Bỏ qua 1 ảnh do lỗi tải: ${item.error || "Rỗng"} (${item.url})`);
      continue;
    }

    const buffer = Buffer.from(item.base64, "base64");
    const filePath = extractedList.length === 1
      ? baseOutputPath
      : join(parentDir, `${parsed.name}_${i + 1}${parsed.ext || ".png"}`);

    if (!skipDiskWrite) {
      writeFileSync(filePath, buffer);
    }

    downloadedResults.push({
      filePath,
      sizeBytes: buffer.length,
      url: item.url,
      base64: item.base64,
    });
  }

  if (downloadedResults.length === 0) {
    throw new Error("Không thể tải thành công bất kỳ ảnh nào trong lượt này.");
  }

  return downloadedResults;
}
