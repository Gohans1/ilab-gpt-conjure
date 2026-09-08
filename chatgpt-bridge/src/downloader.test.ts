import { describe, expect, test } from "bun:test";
import { isAllowedImageUrl, rewriteEstuaryUrl, resolveOutputFilePath } from "./downloader.js";

describe("downloader helpers", () => {
  describe("isAllowedImageUrl", () => {
    test("chấp nhận blob: và data: URLs ảnh hợp lệ", () => {
      expect(isAllowedImageUrl("blob:https://chatgpt.com/12345")).toBe(true);
      expect(isAllowedImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
      expect(isAllowedImageUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
      expect(isAllowedImageUrl("data:image/webp;base64,UklGRg==")).toBe(true);
    });

    test("từ chối data: URLs không phải định dạng ảnh an toàn", () => {
      expect(isAllowedImageUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe(false);
      expect(isAllowedImageUrl("data:application/javascript;base64,YWxlcnQoMSk=")).toBe(false);
      expect(isAllowedImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    });

    test("chấp nhận các domain chính thức của ChatGPT và OpenAI", () => {
      expect(isAllowedImageUrl("https://chatgpt.com/backend-api/estuary?id=abc")).toBe(true);
      expect(isAllowedImageUrl("https://cdn.oaistatic.chatgpt.com/image.png")).toBe(true);
      expect(isAllowedImageUrl("https://openai.com/image.png")).toBe(true);
      expect(isAllowedImageUrl("https://files.oaiusercontent.com/file-123")).toBe(true);
      expect(isAllowedImageUrl("https://images.oaiusercontent.com/file-456")).toBe(true);
    });

    test("chấp nhận Azure blob storage của DALL-E với các region khác nhau", () => {
      expect(isAllowedImageUrl("https://oaidalleapiprodscus.blob.core.windows.net/images/123.png")).toBe(true);
      expect(isAllowedImageUrl("https://oaidalleaprodsus.blob.core.windows.net/images/123.png")).toBe(true);
      expect(isAllowedImageUrl("https://oaidalleapiprodeus.blob.core.windows.net/images/123.png")).toBe(true);
      expect(isAllowedImageUrl("https://oaidalleapiprodweu.blob.core.windows.net/images/123.png")).toBe(true);
    });

    test("từ chối URL không an toàn (HTTP hoặc domain lạ)", () => {
      expect(isAllowedImageUrl("http://chatgpt.com/image.png")).toBe(false);
      expect(isAllowedImageUrl("https://evil-site.com/image.png")).toBe(false);
      expect(isAllowedImageUrl("https://fakechatgpt.com/image.png")).toBe(false);
      expect(isAllowedImageUrl("https://attacker.blob.core.windows.net/image.png")).toBe(false);
      expect(isAllowedImageUrl("invalid-url-format")).toBe(false);
    });
  });

  describe("rewriteEstuaryUrl", () => {
    test("thêm tham số p=fs vào URL estuary", () => {
      const original = "https://chatgpt.com/backend-api/estuary?id=img123&w=256";
      const rewritten = rewriteEstuaryUrl(original);
      const url = new URL(rewritten);
      expect(url.searchParams.get("p")).toBe("fs");
      expect(url.searchParams.get("id")).toBe("img123");
    });

    test("giữ nguyên URL nếu không phải estuary", () => {
      const original = "https://files.oaiusercontent.com/file-123.png";
      expect(rewriteEstuaryUrl(original)).toBe(original);
    });
  });

  describe("resolveOutputFilePath", () => {
    test("tự động bổ sung extension .png cho ảnh đơn nếu outputPath không có đuôi", () => {
      const out = resolveOutputFilePath("./output/cat", 1, 1);
      expect(out.endsWith("cat.png")).toBe(true);
    });

    test("giữ nguyên extension có sẵn của ảnh đơn", () => {
      const out = resolveOutputFilePath("./output/cat.jpg", 1, 1);
      expect(out.endsWith("cat.jpg")).toBe(true);
    });

    test("đánh số tuần tự cho nhiều ảnh", () => {
      const out1 = resolveOutputFilePath("./output/cat.png", 1, 3);
      const out2 = resolveOutputFilePath("./output/cat.png", 2, 3);
      const out3 = resolveOutputFilePath("./output/cat", 3, 3);

      expect(out1.endsWith("cat_1.png")).toBe(true);
      expect(out2.endsWith("cat_2.png")).toBe(true);
      expect(out3.endsWith("cat_3.png")).toBe(true);
    });
  });
});
