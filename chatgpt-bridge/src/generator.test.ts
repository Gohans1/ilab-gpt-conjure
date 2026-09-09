import { describe, expect, it } from "bun:test";
import {
  attachImagesToChatGPT,
  captureDiagnosticSnapshot,
  deleteChatGPTConversation,
  evaluateTurnCompletion,
  inspectChatGPTPageState,
  isValidConversationId,
  raceWithAbort,
  resolveDeleteChatOption,
  resolveInputImages,
  resolveTimeoutOptions,
  shouldSkipConversationDeletion,
  sizeToAspectRatio,
  validateInputImage,
} from "./generator.js";

describe("resolveDeleteChatOption", () => {
  it("mặc định là true khi không truyền options", () => {
    const prevEnv = process.env.CHATGPT_DELETE_CHAT;
    try {
      delete process.env.CHATGPT_DELETE_CHAT;
      expect(resolveDeleteChatOption()).toBe(true);
    } finally {
      if (prevEnv !== undefined) process.env.CHATGPT_DELETE_CHAT = prevEnv;
    }
  });

  it("trả về false khi được truyền trực tiếp là false", () => {
    expect(resolveDeleteChatOption(false)).toBe(false);
  });

  it("trả về true khi được truyền trực tiếp là true", () => {
    expect(resolveDeleteChatOption(true)).toBe(true);
  });

  it("ưu tiên options truyền vào hơn biến môi trường", () => {
    const prevEnv = process.env.CHATGPT_DELETE_CHAT;
    try {
      process.env.CHATGPT_DELETE_CHAT = "false";
      expect(resolveDeleteChatOption(true)).toBe(true);
      process.env.CHATGPT_DELETE_CHAT = "true";
      expect(resolveDeleteChatOption(false)).toBe(false);
    } finally {
      if (prevEnv !== undefined) process.env.CHATGPT_DELETE_CHAT = prevEnv;
    }
  });

  it("tôn trọng CHATGPT_DELETE_CHAT='false' khi options undefined", () => {
    const prevEnv = process.env.CHATGPT_DELETE_CHAT;
    try {
      process.env.CHATGPT_DELETE_CHAT = "false";
      expect(resolveDeleteChatOption()).toBe(false);
    } finally {
      if (prevEnv !== undefined) process.env.CHATGPT_DELETE_CHAT = prevEnv;
    }
  });
});

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
        expect(args.id).toBe("00000000-0000-0000-0000-000000000001");
        expect(args.auth).toBe("Bearer test-token");
        return { success: true, status: 200 };
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "00000000-0000-0000-0000-000000000001", "Bearer test-token");
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it("tự động trim khoảng trắng thừa ở đầu/cuối của conversationId hợp lệ", async () => {
    const mockPage: any = {
      evaluate: async (fn: any, args: any) => {
        expect(args.id).toBe("00000000-0000-0000-0000-000000000001");
        expect(args.auth).toBe("Bearer test-token");
        return { success: true, status: 200 };
      },
    };

    const result = await deleteChatGPTConversation(
      mockPage,
      "   00000000-0000-0000-0000-000000000001   ",
      "Bearer test-token"
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
  });

  it("gửi kèm chatgpt-account-id header khi có accountId", async () => {
    const mockPage: any = {
      evaluate: async (fn: any, args: any) => {
        expect(args.id).toBe("00000000-0000-0000-0000-000000000001");
        expect(args.auth).toBe("Bearer test-token");
        expect(args.accountId).toBe("acc-xyz-999");
        return { success: true, status: 200 };
      },
    };

    const result = await deleteChatGPTConversation(
      mockPage,
      "00000000-0000-0000-0000-000000000001",
      "Bearer test-token",
      "acc-xyz-999"
    );
    expect(result.success).toBe(true);
  });

  it("trả về lỗi an toàn khi server trả status không ok", async () => {
    const mockPage: any = {
      evaluate: async () => {
        return { success: false, status: 404 };
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "ffffffff-ffff-ffff-ffff-ffffffffffff", null);
    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
  });

  it("bắt lỗi ngoại lệ và không làm sập tiến trình khi page.evaluate bị throw", async () => {
    const mockPage: any = {
      evaluate: async () => {
        throw new Error("Page context destroyed");
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "00000000-0000-0000-0000-000000000002", null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Page context destroyed");
  });

  it("từ chối ID đoạn chat không hợp lệ (chống injection/traversal)", async () => {
    const mockPage: any = {};
    const result = await deleteChatGPTConversation(mockPage, "../../bad-id", null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ID đoạn chat không hợp lệ");
  });

  it("từ chối các slug nội bộ của ChatGPT Web như 'web', 'WEB', 'gen_title', 'feedback'", async () => {
    const mockPage: any = {};
    for (const slug of ["web", "WEB", "gen_title", "feedback", "interpreter", "metadata"]) {
      const res = await deleteChatGPTConversation(mockPage, slug, null);
      expect(res.success).toBe(false);
      expect(res.error).toContain("ID đoạn chat không hợp lệ");
    }
  });

  it("bắt và trả về chi tiết lỗi khi máy chủ trả về lỗi", async () => {
    const mockPage: any = {
      evaluate: async () => {
        return { success: false, status: 400, error: "Conversation not found" };
      },
    };

    const result = await deleteChatGPTConversation(mockPage, "68a1f802-1234-4567-8901-abcdef123456", null);
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toBe("Conversation not found");
  });
});

describe("isValidConversationId", () => {
  it("trả về false với giá trị null, undefined, rỗng hoặc quá ngắn", () => {
    expect(isValidConversationId(null)).toBe(false);
    expect(isValidConversationId(undefined)).toBe(false);
    expect(isValidConversationId("")).toBe(false);
    expect(isValidConversationId("abc")).toBe(false);
    expect(isValidConversationId("1234567")).toBe(false);
  });

  it("từ chối khoảng trắng ở bất kỳ vị trí nào (chống bypass)", () => {
    expect(isValidConversationId("  68a1f802-1234-4567-8901-abcdef123456  ")).toBe(false);
    expect(isValidConversationId("68a1f802 1234-4567-8901-abcdef123456")).toBe(false);
    expect(isValidConversationId(" 68a1f802-1234-4567-8901-abcdef123456")).toBe(false);
  });

  it("trả về false với các slug định tuyến nội bộ hoặc từ ngữ thông thường", () => {
    expect(isValidConversationId("web")).toBe(false);
    expect(isValidConversationId("WEB")).toBe(false);
    expect(isValidConversationId("init")).toBe(false);
    expect(isValidConversationId("prepare")).toBe(false);
    expect(isValidConversationId("share")).toBe(false);
    expect(isValidConversationId("models")).toBe(false);
    expect(isValidConversationId("conversation")).toBe(false);
    expect(isValidConversationId("conversations")).toBe(false);
    expect(isValidConversationId("gen_title")).toBe(false);
    expect(isValidConversationId("feedback")).toBe(false);
    expect(isValidConversationId("interpreter")).toBe(false);
    expect(isValidConversationId("metadata")).toBe(false);
    expect(isValidConversationId("temporary")).toBe(false);
    expect(isValidConversationId("test-conv-123")).toBe(false);
  });

  it("trả về false với ký tự không an toàn hoặc injection", () => {
    expect(isValidConversationId("../../bad-id")).toBe(false);
    expect(isValidConversationId("conv?query=1")).toBe(false);
    expect(isValidConversationId("id with space")).toBe(false);
  });

  it("trả về true với UUID chuẩn", () => {
    expect(isValidConversationId("68a1f802-1234-4567-8901-abcdef123456")).toBe(true);
    expect(isValidConversationId("68A1F802-1234-4567-8901-ABCDEF123456")).toBe(true);
    expect(isValidConversationId("00000000-0000-0000-0000-000000000001")).toBe(true);
  });
});

describe("sizeToAspectRatio", () => {
  it("giữ nguyên khi đầu vào đã là dạng tỷ lệ chuẩn X:Y (kể cả số thập phân)", () => {
    expect(sizeToAspectRatio("16:9")).toBe("16:9");
    expect(sizeToAspectRatio("1:1")).toBe("1:1");
    expect(sizeToAspectRatio("9:16")).toBe("9:16");
    expect(sizeToAspectRatio("4:3")).toBe("4:3");
    expect(sizeToAspectRatio("3:4")).toBe("3:4");
    expect(sizeToAspectRatio("21:9")).toBe("21:9");
    expect(sizeToAspectRatio("9:21")).toBe("9:21");
    expect(sizeToAspectRatio("9:19.5")).toBe("9:19.5");
    expect(sizeToAspectRatio("19.5:9")).toBe("19.5:9");
    expect(sizeToAspectRatio(" 16 : 9 ")).toBe("16:9");
  });

  it("nhận diện chuẩn xác các tỷ lệ mở rộng 9:21, 21:9, 4:5, 5:4 từ pixel resolution presets", () => {
    expect(sizeToAspectRatio("672x1568")).toBe("9:21");
    expect(sizeToAspectRatio("1568x672")).toBe("21:9");
    expect(sizeToAspectRatio("1152x2688")).toBe("9:21");
    expect(sizeToAspectRatio("2688x1152")).toBe("21:9");
    expect(sizeToAspectRatio("1632x3808")).toBe("9:21");
    expect(sizeToAspectRatio("3808x1632")).toBe("21:9");
    expect(sizeToAspectRatio("1024x1280")).toBe("4:5");
    expect(sizeToAspectRatio("1280x1024")).toBe("5:4");
    // Nhận diện chuẩn xác 9:19.5 từ màn hình 1080x2340 mà không bị nuốt nhầm thành 9:21
    expect(sizeToAspectRatio("1080x2340")).toBe("9:19.5");
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

    // 2:3 Portrait
    expect(sizeToAspectRatio("1024x1536")).toBe("2:3");

    // Hỗ trợ ký tự Unicode nhân và khoảng trắng
    expect(sizeToAspectRatio("1024×1024")).toBe("1:1");
    expect(sizeToAspectRatio("1792 x 1024")).toBe("16:9");

    // Rút gọn GCD cho tỷ lệ tùy chỉnh
    expect(sizeToAspectRatio("800x480")).toBe("5:3");
  });

  it("trả về null khi đầu vào rỗng hoặc không hợp lệ", () => {
    expect(sizeToAspectRatio(null)).toBeNull();
    expect(sizeToAspectRatio(undefined)).toBeNull();
    expect(sizeToAspectRatio("")).toBeNull();
    expect(sizeToAspectRatio("none")).toBeNull();
    expect(sizeToAspectRatio("None")).toBeNull();
    expect(sizeToAspectRatio("off")).toBeNull();
    expect(sizeToAspectRatio("auto")).toBeNull();
    expect(sizeToAspectRatio("invalid")).toBeNull();
    expect(sizeToAspectRatio("0x0")).toBeNull();
    expect(sizeToAspectRatio("0:0")).toBeNull();
    expect(sizeToAspectRatio("1:0")).toBeNull();
    expect(sizeToAspectRatio("0:1")).toBeNull();
  });
});

describe("inspectChatGPTPageState", () => {
  it("trả về mặc định khi không có document", () => {
    const state = inspectChatGPTPageState(null);
    expect(state.isActivelyLoading).toBe(false);
    expect(state.hasImageWidget).toBe(false);
    expect(state.hasRegenerateBtn).toBe(false);
    expect(state.errorMessage).toBeNull();
    expect(state.isOnline).toBe(true);
  });

  it("nhận diện đúng khi spinner hoặc loading text đang hoạt động (isActivelyLoading = true)", () => {
    const mockDoc = {
      querySelector: (selector: string) => {
        if (selector.includes("animate-spin")) return {};
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [
            {
              textContent: "Creating image of a cyberpunk city...",
              closest: () => null,
              querySelector: () => null,
              querySelectorAll: () => [],
            },
          ];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.isActivelyLoading).toBe(true);
    expect(state.text).toContain("Creating image");
  });

  it("không nhận nhầm nút Regenerate từ turn cũ nếu turn cuối chưa có nút Regenerate", () => {
    const oldTurn = {
      querySelector: (sel: string) => (sel.includes("regenerate") ? {} : null),
      querySelectorAll: () => [],
    };
    const oldMessage = {
      textContent: "Tin nhắn cũ đã xong",
      closest: (sel: string) => (sel.includes("article") ? oldTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const lastTurn = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const lastMessage = {
      textContent: "Tin nhắn mới đang vẽ ảnh",
      closest: (sel: string) => (sel.includes("article") ? lastTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [oldMessage, lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.hasRegenerateBtn).toBe(false);
  });

  it("nhận diện đúng nút Regenerate / refresh nằm ở cấp article của turn cuối", () => {
    const lastTurn = {
      querySelector: (sel: string) => (sel.includes("regenerate") || sel.includes("refresh") ? {} : null),
      querySelectorAll: () => [],
    };
    const lastMessage = {
      textContent: "Ảnh đã tạo xong hoặc thất bại",
      closest: (sel: string) => (sel.includes("article") ? lastTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.hasRegenerateBtn).toBe(true);
  });

  it("nhận diện đúng completionAction khi xuất hiện copy-turn-action-button ở lượt cuối", () => {
    const lastTurn = {
      querySelector: (sel: string) => (sel.includes("copy-turn-action-button") ? {} : null),
      querySelectorAll: () => [],
    };
    const lastMessage = {
      textContent: "Turn hoàn tất",
      closest: (sel: string) => (sel.includes("article") ? lastTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.hasCompletionAction).toBe(true);
  });

  it("không bị ảnh cũ ở turn trước làm ô nhiễm hasImageWidget ở turn cuối", () => {
    const oldTurn = {
      querySelector: (sel: string) => (sel.includes("image") ? {} : null),
      querySelectorAll: () => [],
    };
    const oldMessage = {
      textContent: "Tin nhắn cũ có ảnh",
      closest: (sel: string) => (sel.includes("article") ? oldTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const lastTurn = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const lastMessage = {
      textContent: "Tôi không thể vẽ ảnh này vì vi phạm chính sách.",
      closest: (sel: string) => (sel.includes("article") ? lastTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockDoc = {
      querySelector: (sel: string) => (sel.includes("image") ? {} : null), // Toàn cục có ảnh cũ
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [oldMessage, lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    // hasImageWidget chỉ check trong lastTurn nên phải là false
    expect(state.hasImageWidget).toBe(false);
    expect(state.text).toContain("Tôi không thể vẽ ảnh");
  });

  it("phát hiện lỗi đỏ hoặc rate limit từ ChatGPT", () => {
    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("error")) {
          return [{ textContent: "Something went wrong. Please try again later." }];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.errorMessage).toContain("Something went wrong");
  });

  it("không bị thông báo lỗi cũ ở turn trước làm ô nhiễm errorMessage của turn cuối", () => {
    const oldTurn = {
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.includes("error") ? [{ textContent: "Something went wrong in old turn" }] : [],
    };
    const oldMessage = {
      textContent: "Tin nhắn cũ bị lỗi",
      closest: (sel: string) => (sel.includes("article") ? oldTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const lastTurn = {
      querySelector: () => null,
      querySelectorAll: () => [], // Turn mới đang sạch sẽ, không có lỗi
    };
    const lastMessage = {
      textContent: "Tôi đang tiến hành tạo ảnh cho bạn...",
      closest: (sel: string) => (sel.includes("article") ? lastTurn : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [oldMessage, lastMessage];
        }
        if (selector.includes("error")) {
          return [{ textContent: "Something went wrong in old turn" }]; // Lỗi cũ vẫn còn trong DOM toàn cục
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    // errorScope là lastTurn nên errorMessage phải là null, không bị abort oan
    expect(state.errorMessage).toBeNull();
  });

  it("bỏ qua dialog/modal đã đóng hoặc có aria-hidden / data-state='closed'", () => {
    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("dialog")) {
          return [
            {
              textContent: "Your session has expired. Please log in again.",
              getAttribute: (attr: string) => (attr === "data-state" ? "closed" : null),
              hasAttribute: (attr: string) => attr === "aria-hidden",
              hidden: true,
              style: { display: "none" },
            },
          ];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.errorMessage).toBeNull();
  });

  it("không bị shimmer hoặc spinner ở sidebar làm ô nhiễm isActivelyLoading", () => {
    const lastTurn = {
      textContent: "Đang chờ tải...",
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const mockDoc = {
      querySelector: (sel: string) => {
        // Giả lập sidebar có shimmer / animate-spin nhưng mainChat thì không có
        if (sel.includes("main")) {
          return { querySelector: () => null };
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [{ textContent: "Đang chờ tải...", closest: () => lastTurn }];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.isActivelyLoading).toBe(false);
  });

  it("nhận diện đúng nút Try again / Retry dạng icon dùng aria-label", () => {
    const retryBtn = {
      textContent: "",
      getAttribute: (attr: string) => (attr === "aria-label" ? "Try again" : null),
    };
    const lastTurn = {
      querySelector: (sel: string) => (sel.includes("Try again") ? retryBtn : null),
      querySelectorAll: (sel: string) => (sel === "button" ? [retryBtn] : []),
    };
    const lastMessage = {
      textContent: "Không tạo được ảnh",
      closest: () => lastTurn,
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.hasRegenerateBtn).toBe(true);
  });

  it("nhận diện đúng widget ảnh từ CDN files.oaiusercontent.com hoặc dalle", () => {
    const lastTurn = {
      querySelector: (sel: string) => (sel.includes("files.oaiusercontent.com") ? {} : null),
      querySelectorAll: () => [],
    };
    const lastMessage = {
      textContent: "",
      closest: () => lastTurn,
    };

    const mockDoc = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("assistant")) {
          return [lastMessage];
        }
        return [];
      },
    };

    const state = inspectChatGPTPageState(mockDoc);
    expect(state.hasImageWidget).toBe(true);
  });
});

describe("resolveInputImages", () => {
  it("trả về mảng rỗng khi input rỗng hoặc undefined", () => {
    expect(resolveInputImages()).toEqual([]);
    expect(resolveInputImages(null)).toEqual([]);
    expect(resolveInputImages("")).toEqual([]);
    expect(resolveInputImages([])).toEqual([]);
  });

  it("chuyển đổi chuỗi đơn thành mảng 1 phần tử", () => {
    expect(resolveInputImages("C:/images/cat.png")).toEqual(["C:/images/cat.png"]);
  });

  it("lọc bỏ các phần tử rỗng hoặc không hợp lệ trong mảng", () => {
    const input = ["C:/images/cat.png", "  ", null as any, "C:/images/dog.jpg"];
    expect(resolveInputImages(input)).toEqual(["C:/images/cat.png", "C:/images/dog.jpg"]);
  });
});

describe("attachImagesToChatGPT", () => {
  it("bỏ qua ngay khi danh sách ảnh rỗng", async () => {
    let called = false;
    const mockPage = {
      locator: () => {
        called = true;
        return { first: () => ({}) };
      },
    };
    await attachImagesToChatGPT(mockPage as any, []);
    expect(called).toBe(false);
  });

  it("gọi setInputFiles khi tìm thấy thẻ input file trong DOM", async () => {
    let capturedFiles: any = null;
    let timeoutUsed = 0;
    const mockLocator = {
      count: async () => 1,
      getAttribute: async (attr: string) => (attr === "multiple" ? "multiple" : null),
      setInputFiles: async (files: any, opts: any) => {
        capturedFiles = files;
        timeoutUsed = opts?.timeout;
      },
      waitFor: async () => {},
    };

    const mockPage = {
      locator: (selector: string) => ({
        first: () => mockLocator,
      }),
      waitForTimeout: async () => {},
    };

    await attachImagesToChatGPT(mockPage as any, ["C:/test.png"]);
    expect(capturedFiles).toEqual(["C:/test.png"]);
    expect(timeoutUsed).toBe(15_000);
  });

  it("chỉ upload 1 file nếu thẻ input không hỗ trợ multiple", async () => {
    let capturedFiles: any = null;
    const mockLocator = {
      count: async () => 1,
      getAttribute: async () => null, // Không có multiple
      setInputFiles: async (files: any) => {
        capturedFiles = files;
      },
      waitFor: async () => {},
    };

    const mockPage = {
      locator: () => ({
        first: () => mockLocator,
      }),
      waitForTimeout: async () => {},
    };

    await attachImagesToChatGPT(mockPage as any, ["C:/img1.png", "C:/img2.png"]);
    expect(capturedFiles).toEqual(["C:/img1.png"]);
  });

  it("AUT-02: Ném ngoại lệ khi không tìm thấy thẻ input và nút đính kèm", async () => {
    const mockLocator = {
      count: async () => 0,
      click: async () => {
        throw new Error("Button not found");
      },
      waitFor: async () => {},
    };

    const mockPage = {
      locator: () => ({
        first: () => mockLocator,
      }),
      waitForEvent: async () => null,
      waitForTimeout: async () => {},
    };

    await expect(attachImagesToChatGPT(mockPage as any, ["C:/test.png"])).rejects.toThrow(
      "không tìm thấy input file hoặc nút đính kèm"
    );
  });

  it("AUT-02: Ném ngoại lệ khi nạp ảnh xong nhưng thumbnail không xuất hiện", async () => {
    const mockFileInput = {
      count: async () => 1,
      getAttribute: async () => "multiple",
      setInputFiles: async () => {},
      waitFor: async () => {},
    };

    const mockThumbnail = {
      waitFor: async () => {
        throw new Error("Timeout waiting for thumbnail");
      },
    };

    const mockPage = {
      locator: (selector: string) => {
        if (selector.includes("attachment") || selector.includes("file-pill")) {
          return { first: () => mockThumbnail };
        }
        return { first: () => mockFileInput };
      },
      waitForTimeout: async () => {},
    };

    await expect(attachImagesToChatGPT(mockPage as any, ["C:/test.png"])).rejects.toThrow(
      "không hiển thị thumbnail"
    );
  });
});

describe("validateInputImage", () => {
  it("chấp nhận file PNG hợp lệ", () => {
    const pngPath = "./src/generator.ts"; // not a png, should fail
    // Create a real temp png file
    const tmpPng = "./temp_test_image.png";
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { writeFileSync, rmSync } = require("node:fs");
    writeFileSync(tmpPng, pngHeader);
    try {
      expect(() => validateInputImage(tmpPng)).not.toThrow();
    } finally {
      rmSync(tmpPng, { force: true });
    }
  });

  it("ném lỗi khi file không tồn tại", () => {
    expect(() => validateInputImage("./non_existent_file.png")).toThrow("Không tìm thấy file ảnh tham chiếu");
  });

  it("ném lỗi khi file không phải ảnh (sai magic bytes)", () => {
    const tmpText = "./temp_test_text.txt";
    const { writeFileSync, rmSync } = require("node:fs");
    writeFileSync(tmpText, "This is not an image file format at all.");
    try {
      expect(() => validateInputImage(tmpText)).toThrow("không đúng định dạng hỗ trợ");
    } finally {
      rmSync(tmpText, { force: true });
    }
  });
});

describe("raceWithAbort", () => {
  it("trả về kết quả bình thường khi không có signal", async () => {
    const res = await raceWithAbort(Promise.resolve("hello"));
    expect(res).toBe("hello");
  });

  it("ném lỗi ngay lập tức khi signal đã bị abort từ trước", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceWithAbort(Promise.resolve("hello"), controller.signal)).rejects.toThrow(
      "Quá trình sinh ảnh đã bị hủy bởi client"
    );
  });

  it("hủy promise khi signal được kích hoạt giữa chừng", async () => {
    const controller = new AbortController();
    const hangingPromise = new Promise((resolve) => setTimeout(() => resolve("late"), 1000));
    setTimeout(() => controller.abort(), 10);
    await expect(raceWithAbort(hangingPromise, controller.signal)).rejects.toThrow(
      "Quá trình sinh ảnh đã bị hủy bởi client"
    );
  });
});

describe("shouldSkipConversationDeletion", () => {
  it("bỏ qua xóa khi lượt sinh bị lỗi và không có ảnh nào được tạo (để user kiểm tra)", () => {
    const res = shouldSkipConversationDeletion("00000000-0000-0000-0000-000000000001", null, true, 0);
    expect(res.shouldSkip).toBe(true);
    expect(res.reason).toBe("error_no_results");
  });

  it("bỏ qua xóa khi targetConvId trùng với initialConvId (chống xóa chat cũ của user)", () => {
    const res = shouldSkipConversationDeletion(
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000001",
      false,
      1
    );
    expect(res.shouldSkip).toBe(true);
    expect(res.reason).toBe("pre_existing_chat");
  });

  it("bỏ qua xóa khi không có targetConvId hợp lệ", () => {
    const res = shouldSkipConversationDeletion(null, null, false, 1);
    expect(res.shouldSkip).toBe(true);
    expect(res.reason).toBe("no_valid_id");
  });

  it("cho phép xóa khi là phiên chat mới được tạo (targetConvId khác initialConvId)", () => {
    const res = shouldSkipConversationDeletion(
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000001",
      false,
      1
    );
    expect(res.shouldSkip).toBe(false);
    expect(res.reason).toBe(null);
  });

  it("cho phép xóa khi initialConvId là null và có targetConvId mới sinh thành công", () => {
    const res = shouldSkipConversationDeletion(
      "00000000-0000-0000-0000-000000000002",
      null,
      false,
      1
    );
    expect(res.shouldSkip).toBe(false);
    expect(res.reason).toBe(null);
  });
});

describe("evaluateTurnCompletion", () => {
  it("hoàn tất ngay khi đã đủ số ảnh kỳ vọng (expectedCount) và không còn đang tải", () => {
    const evalRes = evaluateTurnCompletion({
      newImagesCount: 2,
      expectedCount: 2,
      isGeneratingOrLoading: false,
      hasFinishedSignal: false,
      quietStartTime: 0,
    });
    expect(evalRes.isComplete).toBe(true);
  });

  it("hoàn tất ngay khi có tín hiệu nút Copy / Regenerate dù chỉ mới có 1 ảnh (n=2 nhưng ChatGPT trả 1 ảnh)", () => {
    const evalRes = evaluateTurnCompletion({
      newImagesCount: 1,
      expectedCount: 2,
      isGeneratingOrLoading: false,
      hasFinishedSignal: true,
      quietStartTime: 0,
    });
    expect(evalRes.isComplete).toBe(true);
  });

  it("kích hoạt bộ đếm Settle Grace khi có ảnh và không còn loading", () => {
    const baseTime = 1000000;
    const evalRes = evaluateTurnCompletion({
      newImagesCount: 1,
      expectedCount: 2,
      isGeneratingOrLoading: false,
      hasFinishedSignal: false,
      quietStartTime: 0,
      currentTime: baseTime,
    });
    expect(evalRes.isComplete).toBe(false);
    expect(evalRes.isSettled).toBe(false);
    expect(evalRes.nextQuietStartTime).toBe(baseTime);
  });

  it("hoàn tất sau khi trạng thái yên tĩnh duy trì đủ 2.0s (Settle Grace)", () => {
    const startTime = 1000000;
    const evalRes = evaluateTurnCompletion({
      newImagesCount: 1,
      expectedCount: 2,
      isGeneratingOrLoading: false,
      hasFinishedSignal: false,
      quietStartTime: startTime,
      currentTime: startTime + 2100,
    });
    expect(evalRes.isComplete).toBe(true);
    expect(evalRes.isSettled).toBe(true);
  });

  it("reset bộ đếm Settle Grace khi ChatGPT tiếp tục loading / generating", () => {
    const evalRes = evaluateTurnCompletion({
      newImagesCount: 1,
      expectedCount: 2,
      isGeneratingOrLoading: true,
      hasFinishedSignal: false,
      quietStartTime: 1000000,
      currentTime: 1001000,
    });
    expect(evalRes.isComplete).toBe(false);
    expect(evalRes.isSettled).toBe(false);
    expect(evalRes.nextQuietStartTime).toBe(0);
  });
});

describe("inspectChatGPTPageState baseline turns protection", () => {
  it("bỏ qua đánh giá lastTurn nếu số lượng assistant turn không vượt quá baseline", () => {
    const fakeDoc: any = {
      querySelectorAll: (sel: string) => {
        if (sel.includes('[data-message-author-role="assistant"]')) {
          return [
            {
              textContent: "Đoạn chat cũ của turn trước",
              closest: () => ({
                textContent: "Đoạn chat cũ của turn trước",
                querySelector: (subSel: string) => {
                  if (subSel.includes("copy-turn-action-button")) return {};
                  return null;
                },
                querySelectorAll: () => [],
              }),
            },
          ];
        }
        return [];
      },
      querySelector: () => null,
    };

    // Khi baseline = 1 (trước khi gửi prompt đã có sẵn 1 turn)
    const state = inspectChatGPTPageState(fakeDoc, null, undefined, 1);
    expect(state.text).toBe("");
    expect(state.hasCompletionAction).toBe(false);
    expect(state.hasRegenerateBtn).toBe(false);
    expect(state.hasImageWidget).toBe(false);
  });

  it("đánh giá đúng turn mới khi xuất hiện assistant turn vượt quá baseline", () => {
    const fakeDoc: any = {
      querySelectorAll: (sel: string) => {
        if (sel.includes('[data-message-author-role="assistant"]')) {
          return [
            { textContent: "Turn cũ" },
            {
              textContent: "Turn mới vừa sinh",
              closest: () => ({
                textContent: "Turn mới vừa sinh",
                querySelector: (subSel: string) => {
                  if (subSel.includes("copy-turn-action-button")) return {};
                  return null;
                },
                querySelectorAll: () => [],
              }),
            },
          ];
        }
        return [];
      },
      querySelector: () => null,
    };

    // Baseline = 1, hiện tại có 2 turn -> đánh giá turn mới!
    const state = inspectChatGPTPageState(fakeDoc, null, undefined, 1);
    expect(state.text).toBe("Turn mới vừa sinh");
    expect(state.hasCompletionAction).toBe(true);
  });
});

describe("captureDiagnosticSnapshot", () => {
  it("bỏ qua an toàn và không throw khi page là null hoặc đã đóng", async () => {
    await expect(captureDiagnosticSnapshot(null as any)).resolves.toBeUndefined();

    const mockClosedPage: any = {
      isClosed: () => true,
    };
    await expect(captureDiagnosticSnapshot(mockClosedPage)).resolves.toBeUndefined();
  });

  it("không làm sập tiến trình khi screenshot hoặc evaluate bị reject", async () => {
    const mockCrashingPage: any = {
      isClosed: () => false,
      screenshot: async () => {
        throw new Error("Target crashed");
      },
      evaluate: async () => {
        throw new Error("Execution context destroyed");
      },
    };
    await expect(captureDiagnosticSnapshot(mockCrashingPage)).resolves.toBeUndefined();
  });
});
