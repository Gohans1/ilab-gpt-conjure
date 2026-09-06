import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempFiles, handleRequest, parseImageRequest } from "./server.js";

describe("parseImageRequest", () => {
  it("phân tích đúng JSON request không có ảnh", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A cute orange cat",
        n: 2,
        size: "1024x1024",
      }),
    });

    const parsed = await parseImageRequest(req);
    expect(parsed.prompt).toBe("A cute orange cat");
    expect(parsed.n).toBe(2);
    expect(parsed.aspectRatioOrSize).toBe("1024x1024");
    expect(parsed.inputImages).toEqual([]);
    expect(parsed.tempFilesToClean).toEqual([]);
  });

  it("phân tích đúng JSON request có base64 image và dọn dẹp sạch cả thư mục tạm", async () => {
    const fakeBase64Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Make the cat blue",
        images: [fakeBase64Png],
      }),
    });

    const parsed = await parseImageRequest(req);
    expect(parsed.prompt).toBe("Make the cat blue");
    expect(parsed.inputImages.length).toBe(1);
    expect(existsSync(parsed.inputImages[0])).toBe(true);
    // tempFilesToClean phải chứa cả file và folder cha
    expect(parsed.tempFilesToClean.length).toBeGreaterThanOrEqual(2);

    cleanupTempFiles(parsed.tempFilesToClean);
    for (const item of parsed.tempFilesToClean) {
      expect(existsSync(item)).toBe(false);
    }
  });

  it("phân tích đúng raw base64 string (chuẩn b64_json không có tiền tố data:image/)", async () => {
    // 1x1 PNG raw base64
    const rawB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Make it cinematic",
        image: rawB64,
      }),
    });

    const parsed = await parseImageRequest(req);
    try {
      expect(parsed.inputImages.length).toBe(1);
      expect(parsed.inputImages[0].endsWith(".png")).toBe(true);
      expect(existsSync(parsed.inputImages[0])).toBe(true);
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
    }
  });

  it("phân tích đúng multipart/form-data request với file upload", async () => {
    const formData = new FormData();
    formData.append("prompt", "Turn into cyber style");
    formData.append("n", "1");
    const fakeFile = new File([new Uint8Array([1, 2, 3, 4])], "sample.png", { type: "image/png" });
    formData.append("image", fakeFile);

    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      body: formData,
    });

    const parsed = await parseImageRequest(req);
    try {
      expect(parsed.prompt).toBe("Turn into cyber style");
      expect(parsed.inputImages.length).toBe(1);
      expect(existsSync(parsed.inputImages[0])).toBe(true);
      const content = readFileSync(parsed.inputImages[0]);
      expect(content).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
      for (const item of parsed.tempFilesToClean) {
        expect(existsSync(item)).toBe(false);
      }
    }
  });

  it("từ chối đường dẫn local file nếu là thư mục hoặc không phải định dạng ảnh", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Attacking path traversal",
        image: tmpdir(), // Là thư mục
      }),
    });

    const parsed = await parseImageRequest(req);
    expect(parsed.inputImages).toEqual([]);
  });
});

describe("cleanupTempFiles", () => {
  it("xóa sạch thư mục tạm chứa file bên trong mà không gây crash", () => {
    const testDir = join(tmpdir(), `test-cleanup-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const subFile = join(testDir, "test.txt");
    writeFileSync(subFile, "hello");

    expect(existsSync(subFile)).toBe(true);
    cleanupTempFiles([testDir]);
    expect(existsSync(testDir)).toBe(false);
  });
});

describe("handleRequest validation", () => {
  it("trả về 400 missing_image khi gọi /v1/images/edits mà không có ảnh", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-local",
      },
      body: JSON.stringify({
        prompt: "Edit this picture without picture",
      }),
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error?.code).toBe("missing_image");
  });
});

