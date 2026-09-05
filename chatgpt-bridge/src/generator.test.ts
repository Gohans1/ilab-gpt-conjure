import { describe, expect, it } from "bun:test";
import { deleteChatGPTConversation, resolveTimeoutOptions, sizeToAspectRatio } from "./generator.js";

describe("resolveTimeoutOptions", () => {
  it("dùng giá trị mặc định khi không truyền options (idle: 60s, max: 600s)", () => {
    const config = resolveTimeoutOptions();
    expect(config.idleTimeoutMs).toBe(60_000);
    expect(config.maxTimeoutMs).toBe(600_000);
  });

  it("ưu tiên giá trị truyền trực tiếp qua options", () => {
    const config = resolveTimeoutOptions({
      idleTimeoutMs: 45_000,
      maxTimeoutMs: 300_000,
    });
    expect(config.idleTimeoutMs).toBe(45_000);
    expect(config.maxTimeoutMs).toBe(300_000);
  });

  it("tương thích ngược với timeoutMs cũ thành maxTimeoutMs", () => {
    const config = resolveTimeoutOptions({
      timeoutMs: 180_000,
    });
    expect(config.idleTimeoutMs).toBe(60_000);
    expect(config.maxTimeoutMs).toBe(180_000);
  });

  it("nhận cấu hình qua biến môi trường khi không có options", () => {
    const prevIdle = process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS;
    const prevMax = process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS;
    try {
      process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS = "90000";
      process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS = "900000";
      const config = resolveTimeoutOptions();
      expect(config.idleTimeoutMs).toBe(90_000);
      expect(config.maxTimeoutMs).toBe(900_000);
    } finally {
      if (prevIdle !== undefined) process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS = prevIdle;
      else delete process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS;

      if (prevMax !== undefined) process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS = prevMax;
      else delete process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS;
    }
  });

  it("bỏ qua giá trị âm hoặc không hợp lệ và fallback về mặc định", () => {
    const config = resolveTimeoutOptions({
      idleTimeoutMs: -100,
      maxTimeoutMs: 0,
    });
    expect(config.idleTimeoutMs).toBe(60_000);
    expect(config.maxTimeoutMs).toBe(600_000);
  });
});

describe("deleteChatGPTConversation", () => {
  it("xóa chat thành công khi có authHeader", async () => {
    const mockPage: any = {
      evaluate: async (fn: any, args: any) => {
        expect(args.id).toBe("test-conv-123");
        expect(args.auth).toBe("Bearer test-token");
        return { success: true, status: 200 };
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "test-conv-123", "Bearer test-token");
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it("trả về lỗi an toàn khi server trả status không ok", async () => {
    const mockPage: any = {
      evaluate: async () => {
        return { success: false, status: 404 };
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "non-existent-conv", null);
    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
  });

  it("bắt lỗi ngoại lệ và không làm sập tiến trình khi page.evaluate bị throw", async () => {
    const mockPage: any = {
      evaluate: async () => {
        throw new Error("Page context destroyed");
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "test-conv", null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Page context destroyed");
  });
});

describe("sizeToAspectRatio", () => {
  it("giữ nguyên khi đầu vào đã là dạng tỷ lệ chuẩn X:Y", () => {
    expect(sizeToAspectRatio("16:9")).toBe("16:9");
    expect(sizeToAspectRatio("1:1")).toBe("1:1");
    expect(sizeToAspectRatio("9:16")).toBe("9:16");
    expect(sizeToAspectRatio("4:3")).toBe("4:3");
    expect(sizeToAspectRatio("3:4")).toBe("3:4");
    expect(sizeToAspectRatio("21:9")).toBe("21:9");
  });

  it("chuyển đổi kích thước pixel OpenAI/DALL-E sang dạng tỷ lệ chuẩn gọn gàng", () => {
    // 1:1 Square
    expect(sizeToAspectRatio("1024x1024")).toBe("1:1");
    expect(sizeToAspectRatio("512x512")).toBe("1:1");

    // 16:9 Landscape
    expect(sizeToAspectRatio("1792x1024")).toBe("16:9");

    // 9:16 Portrait
    expect(sizeToAspectRatio("1024x1792")).toBe("9:16");

    // 4:3 và 3:2
    expect(sizeToAspectRatio("1200x900")).toBe("4:3");
    expect(sizeToAspectRatio("1536x1024")).toBe("3:2");
  });

  it("trả về null khi đầu vào rỗng hoặc không hợp lệ", () => {
    expect(sizeToAspectRatio(null)).toBeNull();
    expect(sizeToAspectRatio(undefined)).toBeNull();
    expect(sizeToAspectRatio("")).toBeNull();
    expect(sizeToAspectRatio("invalid")).toBeNull();
    expect(sizeToAspectRatio("0x0")).toBeNull();
  });
});
