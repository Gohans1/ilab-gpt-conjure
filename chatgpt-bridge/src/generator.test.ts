import { describe, expect, it } from "bun:test";
import { deleteChatGPTConversation } from "./generator.js";

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
