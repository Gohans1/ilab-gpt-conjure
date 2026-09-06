import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cleanupTempFiles, parseImageRequest } from "./server.js";

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

  it("phân tích đúng JSON request có base64 image và ghi ra file tạm", async () => {
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
    try {
      expect(parsed.prompt).toBe("Make the cat blue");
      expect(parsed.inputImages.length).toBe(1);
      expect(existsSync(parsed.inputImages[0])).toBe(true);
      expect(parsed.tempFilesToClean.length).toBe(1);
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
      expect(existsSync(parsed.inputImages[0])).toBe(false);
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
      expect(existsSync(parsed.inputImages[0])).toBe(false);
    }
  });
});
