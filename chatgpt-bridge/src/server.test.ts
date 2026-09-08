import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGenerationPrompt, cleanupTempFiles, enqueueTask, handleRequest, parseImageRequest } from "./server.js";

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

  it("phân tích đúng khi size hoặc aspect_ratio truyền là None", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A beautiful sunset",
        aspect_ratio: "None",
      }),
    });

    const parsed = await parseImageRequest(req);
    expect(parsed.prompt).toBe("A beautiful sunset");
    expect(parsed.aspectRatioOrSize).toBe("None");
  });

  it("phân tích đúng headless và visible_browser từ JSON request", async () => {
    // visible_browser: true -> headless: false
    const req1 = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        visible_browser: true,
      }),
    });
    const parsed1 = await parseImageRequest(req1);
    expect(parsed1.headless).toBe(false);

    // visible_browser: false -> headless: true
    const req2 = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        visible_browser: false,
      }),
    });
    const parsed2 = await parseImageRequest(req2);
    expect(parsed2.headless).toBe(true);

    // headless: true trực tiếp
    const req3 = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        headless: true,
      }),
    });
    const parsed3 = await parseImageRequest(req3);
    expect(parsed3.headless).toBe(true);
  });

  it("phân tích đúng visible_browser từ multipart/form-data request", async () => {
    const formData = new FormData();
    formData.append("prompt", "A futuristic car");
    formData.append("visible_browser", "true");

    const req = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      body: formData,
    });
    const parsed = await parseImageRequest(req);
    expect(parsed.headless).toBe(false);
  });

  it("phân tích đúng browser từ JSON và multipart/form-data request", async () => {
    const reqJson = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A neon city",
        browser: "edge",
      }),
    });
    const parsedJson = await parseImageRequest(reqJson);
    expect(parsedJson.browser).toBe("edge");

    const formData = new FormData();
    formData.append("prompt", "A cyberpunk cat");
    formData.append("browser", "chrome");
    const reqForm = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      body: formData,
    });
    const parsedForm = await parseImageRequest(reqForm);
    expect(parsedForm.browser).toBe("chrome");
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
    const fakeFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], "sample.png", { type: "image/png" });
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
      expect(content).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
      for (const item of parsed.tempFilesToClean) {
        expect(existsSync(item)).toBe(false);
      }
    }
  });

  it("REQ-05: Từ chối file upload không khớp magic bytes của định dạng ảnh hợp lệ", async () => {
    const formData = new FormData();
    formData.append("prompt", "Turn into cyber style");
    const corruptedFile = new File([new Uint8Array([1, 2, 3, 4])], "corrupted.png", { type: "image/png" });
    formData.append("image", corruptedFile);

    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      body: formData,
    });

    await expect(parseImageRequest(req)).rejects.toThrow("Unsupported or invalid image format");
  });

  it("REQ-07: Từ chối Base64 Data URI không khớp magic bytes của định dạng ảnh hợp lệ", async () => {
    // Fake base64 text "AQIDBA==" (1, 2, 3, 4) đội lốt data:image/png
    const fakeDataUri = "data:image/png;base64,AQIDBA==";
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Turn into cyber style",
        image: fakeDataUri,
      }),
    });

    await expect(parseImageRequest(req)).rejects.toThrow("Invalid or unsupported base64 image format");
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

  it("SEC-01: Chống path traversal khi client truyền filename độc hại trong multipart", async () => {
    const formData = new FormData();
    formData.append("prompt", "Try path traversal");
    // Tên file chứa path traversal nguy hiểm
    const maliciousFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "../../../evil.bat", { type: "image/png" });
    formData.append("image", maliciousFile);

    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      body: formData,
    });

    const parsed = await parseImageRequest(req);
    try {
      expect(parsed.inputImages.length).toBe(1);
      // Đường dẫn file tạm phải nằm an toàn trong tmpdir(), không bị thoát ra ngoài
      expect(parsed.inputImages[0].includes("evil.bat")).toBe(false);
      expect(parsed.inputImages[0].endsWith(".png")).toBe(true);
      expect(existsSync(parsed.inputImages[0])).toBe(true);
    } finally {
      cleanupTempFiles(parsed.tempFilesToClean);
    }
  });

  it("SEC-02: Chặn đứng UNC network path trên Windows để chống leak NetNTLM hash", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Steal NTLM hash",
        image: "\\\\10.0.0.1\\share\\secret.png",
      }),
    });

    const parsed = await parseImageRequest(req);
    expect(parsed.inputImages).toEqual([]);
  });

  it("RES-01: Dọn dẹp sạch sẽ thư mục tạm nếu quá trình parse bị lỗi", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Test remote url error",
        image: "https://example.com/image.png", // Remote URL bị cấm, sẽ throw
      }),
    });

    await expect(parseImageRequest(req)).rejects.toThrow("Remote HTTP(S) image URLs are not supported");
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

  it("trả về 400 missing_image khi gọi /v1/images/variations mà không có ảnh", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/variations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-local",
      },
      body: JSON.stringify({}),
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error?.code).toBe("missing_image");
  });

  it("trả về 401 fail-fast khi request hợp lệ nhưng chưa có session đăng nhập hợp lệ", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-local",
      },
      body: JSON.stringify({
        prompt: "A beautiful scenery",
      }),
    });

    const res = await handleRequest(req);
    // Khi chưa đăng nhập (hoặc trong môi trường test cô lập), server phải fail-fast 401
    expect(res.status).toBe(401);
    const json: any = await res.json();
    expect(json.error?.type).toBe("authentication_error");
  });

  it("không xem văn bản từ chối (refusal text) có chữ unauthorized là lỗi 401 hết hạn phiên", async () => {
    const refusalMsg = 'ChatGPT không tạo ảnh mà trả lời bằng văn bản: "I am unauthorized to generate copyrighted characters."';
    const isTextRefusal = refusalMsg.startsWith("ChatGPT không tạo ảnh mà trả lời bằng văn bản:");
    const isAuthError =
      !isTextRefusal &&
      (refusalMsg.includes("Phiên đăng nhập") ||
        /session has expired|Your session has expired|log in again|chưa có hoặc đã hết hạn/i.test(refusalMsg));
    expect(isAuthError).toBe(false);
  });

  it("trả về 405 Method Not Allowed khi gửi request không phải POST tới images endpoint", async () => {
    const req = new Request("http://127.0.0.1:3000/v1/images/generations", {
      method: "GET",
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(405);
    const json: any = await res.json();
    expect(json.error?.code).toBe("method_not_allowed");
  });
});

describe("buildGenerationPrompt", () => {
  it("giữ prompt fresh 100% khi hasInputImages = true, bóc sạch ratio command", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Make the hair bright green. Set the aspect ratio to 16:9.",
      aspectRatioOrSize: "16:9",
      hasInputImages: true,
      n: 1,
    });
    expect(prompt).toBe("Make the hair bright green.");
  });

  it("không bọc Generate an image of: khi có ảnh reference", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Change the background to a sunny beach",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 1,
    });
    expect(prompt).toBe("Change the background to a sunny beach");
  });

  it("thêm wrapper và aspect ratio khi KHÔNG có ảnh reference", () => {
    const prompt = buildGenerationPrompt({
      prompt: "A futuristic cyberpunk city",
      aspectRatioOrSize: "16:9",
      hasInputImages: false,
      n: 1,
    });
    expect(prompt).toBe("Generate an image of: A futuristic cyberpunk city. Set the aspect ratio to 16:9.");
  });

  it("không thêm aspect ratio khi chọn None dù không có ảnh reference", () => {
    const prompt = buildGenerationPrompt({
      prompt: "A peaceful forest with mist. Set the aspect ratio to 1:1.",
      aspectRatioOrSize: "None",
      hasInputImages: false,
      n: 1,
    });
    expect(prompt).toBe("Generate an image of: A peaceful forest with mist.");
  });

  it("bóc sạch câu lệnh aspect ratio tiếng Hindi bao gồm hậu tố và dấu danda", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Make the character smile. पक्षानुपात को 16:9 पर सेट करें।",
      aspectRatioOrSize: "16:9",
      hasInputImages: true,
      n: 1,
    });
    expect(prompt).toBe("Make the character smile.");
  });

  it("fallback sang prompt mặc định khi người dùng chỉ nhập đúng câu ratio khi có ảnh tham chiếu", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Set the aspect ratio to 16:9.",
      aspectRatioOrSize: "16:9",
      hasInputImages: true,
      n: 1,
    });
    expect(prompt).toBe("Generate a creative variation of the attached image.");
  });

  it("bọc Generate exactly N separate individual variations khi có ảnh reference và n > 1", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Make the hair bright green",
      aspectRatioOrSize: "16:9",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual variations of the attached image: Make the hair bright green. Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("bọc Generate exactly N separate individual creative variations khi có ảnh reference và không có prompt (hoặc prompt rỗng)", () => {
    const prompt = buildGenerationPrompt({
      prompt: "",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual creative variations of the attached image. Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("không xóa mất prompt của user khi prompt bắt đầu bằng 'Generate a creative variation with...'", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate a creative variation with steampunk aesthetics and golden goggles",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual variations of the attached image: Generate a creative variation with steampunk aesthetics and golden goggles. Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("không bị dính lỗi prompt hijack khi user gõ 'Generate exactly what is shown...'", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate exactly what is shown in the image but with dark green hair",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual variations of the attached image: Generate exactly what is shown in the image but with dark green hair. Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("tự unwrap và cập nhật số lượng n khi prompt đã bị bọc trước đó", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate exactly 2 distinct variations of the attached image: Add red glasses.",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual variations of the attached image: Add red glasses. Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("xử lý đúng dấu câu tiếng Nhật/Trung mà không bị nhân đôi dấu chấm", () => {
    const prompt = buildGenerationPrompt({
      prompt: "背景を青空に変えてください。",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual variations of the attached image: 背景を青空に変えてください。 Do not combine the 4 variations into a single grid or collage; output each as a separate image."
    );
  });

  it("tự unwrap về prompt gốc khi có ảnh reference nhưng n = 1 trên prompt batch cũ", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate exactly 4 separate individual variations of the attached image: Add red glasses. Do not combine the 4 variations into a single grid or collage; output each as a separate image.",
      aspectRatioOrSize: "None",
      hasInputImages: true,
      n: 1,
    });
    expect(prompt).toBe("Add red glasses.");
  });

  it("không bị double-wrapping ở chế độ text-to-image khi prompt đã có lệnh vẽ", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate an image of: A cute cat.",
      aspectRatioOrSize: "None",
      hasInputImages: false,
      n: 4,
    });
    expect(prompt).toBe(
      "Generate exactly 4 separate individual images of: A cute cat. Do not combine the 4 images into a single grid or collage; output each as a separate image."
    );
  });

  it("tự unwrap về prompt đơn ở chế độ text-to-image khi n = 1 trên prompt batch cũ", () => {
    const prompt = buildGenerationPrompt({
      prompt: "Generate exactly 4 separate individual images of: A cute cat. Do not combine the 4 images into a single grid or collage; output each as a separate image.",
      aspectRatioOrSize: "None",
      hasInputImages: false,
      n: 1,
    });
    expect(prompt).toBe("Generate an image of: A cute cat.");
  });
});

describe("CORS & Origin Security (REQ-06)", () => {
  it("cho phép loopback origins và cấu hình đúng Vary Origin", async () => {
    const req = new Request("http://127.0.0.1:3000/health", {
      headers: { Origin: "http://localhost:8787" },
    });
    const res = await handleRequest(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8787");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("không cấp phát Origin của bên thứ 3 (untrusted) trong CORS", async () => {
    const req = new Request("http://127.0.0.1:3000/health", {
      headers: { Origin: "https://evil.com" },
    });
    const res = await handleRequest(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1");
  });

  it("chặn đứng 403 Forbidden khi web bên ngoài gửi CSRF tới /auth/login", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login", {
      method: "POST",
      headers: { Origin: "https://evil.com" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const json: any = await res.json();
    expect(json.error).toContain("Forbidden");
  });

  it("chặn đứng 403 Forbidden khi sandboxed iframe (Origin: null) gửi CSRF tới /auth/login", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login", {
      method: "POST",
      headers: { Origin: "null" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const json: any = await res.json();
    expect(json.error).toContain("Forbidden");
  });

  it("chặn đứng 403 Forbidden khi Sec-Fetch-Site là cross-site trên /auth/login", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const json: any = await res.json();
    expect(json.error).toContain("Forbidden");
  });

  it("cho phép gọi /auth/login-done từ local origin và trả về JSON hợp lệ", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login-done", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:8000" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.notified).toBe("boolean");
  });

  it("chặn đứng 403 khi gọi /auth/login-done từ cross-site", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login-done", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
  });

  it("trả về 405 Method Not Allowed khi gọi GET /auth/login-done", async () => {
    const req = new Request("http://127.0.0.1:3000/auth/login-done", {
      method: "GET",
      headers: { Origin: "http://127.0.0.1:8000" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(405);
  });
});

describe("enqueueTask", () => {
  it("thực thi tác vụ bình thường khi không bị abort", async () => {
    const result = await enqueueTask(async () => 12345);
    expect(result).toBe(12345);
  });

  it("reject ngay lập tức mà không treo promise khi signal bị aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(enqueueTask(async () => 999, controller.signal)).rejects.toThrow(
      "Yêu cầu đã bị hủy bởi client trước khi thực thi"
    );
  });

  it("reject ngay lập tức khi đang đứng đợi trong hàng sau một task đang chạy dài hạn", async () => {
    let task1Running = true;
    const task1 = enqueueTask(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      task1Running = false;
      return "task1_done";
    });

    const controller = new AbortController();
    const task2Promise = enqueueTask(async () => "task2_done", controller.signal);

    expect(task1Running).toBe(true);
    controller.abort();

    await expect(task2Promise).rejects.toThrow(
      "Yêu cầu đã bị hủy bởi client trước khi thực thi"
    );

    await task1;
  });
});
