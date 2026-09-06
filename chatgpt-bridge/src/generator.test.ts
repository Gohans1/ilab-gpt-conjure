import { describe, expect, it } from "bun:test";
import {
  attachImagesToChatGPT,
  deleteChatGPTConversation,
  inspectChatGPTPageState,
  resolveDeleteChatOption,
  resolveInputImages,
  resolveTimeoutOptions,
  sizeToAspectRatio,
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




