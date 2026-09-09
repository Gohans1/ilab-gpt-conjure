#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateImage } from "./generator.js";
import { cleanupActiveBrowsers } from "./browser.js";
import { handleLogin } from "./auth-helper.js";
import { isSessionCached } from "./check-session.js";

function printHelp(): void {
  console.log(`
🎨 ChatGPT Image CLI (ChatGPT Images 2.0 / GPT Image) 🎨

Cách sử dụng:
  bun run src/cli.ts "Nội dung prompt tạo ảnh" [options]
  node src/cli.js "Nội dung prompt tạo ảnh" [options]

Options:
  -o, --out <path>     Đường dẫn file ảnh đầu ra (Mặc định: ./output/image_<timestamp>.png)
  -i, --image <path>   Đường dẫn file ảnh tham chiếu (có thể truyền nhiều lần)
  --headless           Chạy trình duyệt ẩn (không mở cửa sổ giao diện)
  --headed             Ép mở cửa sổ trình duyệt (mặc định)
  --keep-chat          Giữ lại đoạn chat trên ChatGPT (mặc định sẽ tự động xóa)
  --login              Mở trình duyệt để bạn đăng nhập tài khoản ChatGPT
  -h, --help           Hiện trợ giúp này

Ví dụ:
  bun run src/cli.ts "Vẽ một chú mèo phi hành gia phong cách cyberpunk, tỉ lệ 16:9" -o ./cat.png
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--login")) {
    const loginIdx = args.indexOf("--login");
    const nextArg = args[loginIdx + 1];
    const preferredBrowser = nextArg && !nextArg.startsWith("-") ? nextArg : undefined;
    await handleLogin(300_000, preferredBrowser);
    process.exit(0);
  }

  const promptParts: string[] = [];
  let outputPath = "";
  let headless = false;
  let keepChat = false;
  const inputImages: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--out") {
      outputPath = args[++i] || "";
    } else if (arg === "-i" || arg === "--image" || arg === "--images") {
      const imgPath = args[++i] || "";
      if (imgPath) {
        const resolved = resolve(process.cwd(), imgPath);
        if (!existsSync(resolved)) {
          console.error(`❌ Lỗi: Không tìm thấy file ảnh tham chiếu: ${imgPath}`);
          process.exit(1);
        }
        inputImages.push(resolved);
      }
    } else if (arg === "--headless") {
      headless = true;
    } else if (arg === "--headed") {
      headless = false;
    } else if (arg === "--keep-chat" || arg === "--no-delete") {
      keepChat = true;
    } else if (!arg.startsWith("-")) {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    console.error("❌ Lỗi: Bạn chưa nhập prompt tạo ảnh!");
    printHelp();
    process.exit(1);
  }

  // Fail-fast: Kiểm tra sớm session cache trong 1ms trước khi khởi chạy Chrome
  if (!isSessionCached()) {
    console.error("❌ Lỗi: Chưa phát hiện phiên đăng nhập ChatGPT hợp lệ trên hệ thống!");
    console.error("👉 Vui lòng chạy lệnh sau để đăng nhập trước khi tạo ảnh:");
    console.error("   bun run src/cli.ts --login\n");
    process.exit(1);
  }

  const resolvedOut = outputPath ? resolve(process.cwd(), outputPath) : undefined;

  console.log("=================================================");
  console.log("🚀 Bắt đầu tạo ảnh với ChatGPT Web Images...");
  console.log(`📝 Prompt: "${prompt}"`);
  if (inputImages.length > 0) {
    console.log(`🖼️ Ảnh tham chiếu (${inputImages.length}): ${inputImages.join(", ")}`);
  }
  if (resolvedOut) console.log(`💾 File đích: ${resolvedOut}`);
  console.log("=================================================\n");

  try {
    const startTime = Date.now();
    const results = await generateImage(prompt, {
      outputPath: resolvedOut,
      headless,
      deleteChatAfterGen: !keepChat,
      inputImages,
    });
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n=================================================");
    console.log(`🎉 TẠO ẢNH THÀNH CÔNG RỰC RỠ! (Tổng cộng: ${results.length} ảnh)`);
    results.forEach((res, index) => {
      console.log(`  [Ảnh #${index + 1}] 📁 ${res.filePath} (${(res.sizeBytes / 1024).toFixed(1)} KB)`);
    });
    console.log(`⏱️ Thời gian thực hiện: ${durationSec}s`);
    console.log("=================================================");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ ĐÃ XẢY RA LỖI:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  const cleanup = () => {
    try {
      cleanupActiveBrowsers();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  void main();
}
