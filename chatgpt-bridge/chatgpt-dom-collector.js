/**
 * ==============================================================================
 * CHATGPT DOM COLLECTOR & SELECTOR AUDITOR (v3.0 - AUDITED ROUND 5)
 * ==============================================================================
 * Mục đích:
 * 1. 100% PURE DOM - Không can thiệp network / fetch / xhr (0% rủi ro Cloudflare WAF).
 * 2. Bắt trọn Transient Elements (Nút Stop, Spinner, Tiến độ upload, Thumbnail blob) qua MutationObserver.
 * 3. Bóc tách chi tiết kịch bản 3 trong 1 (Turn 1: 2 ảnh; Turn 2: Edit kèm upload; Turn 3: 1 ảnh đơn).
 * 4. Kiểm định sức khỏe danh sách SELECTORS từ config.ts (Xử lý an toàn cú pháp :has-text của Playwright).
 * 5. Lá chắn an toàn (Capture Trap) cho flow Xóa chat: Bắt trọn selector xóa mà KHÔNG làm mất chat thật.
 * 6. Chống rò rỉ bộ nhớ, chống crash tab, triệt tiêu hoàn toàn lỗi circular structure JSON.
 * ==============================================================================
 */

(function initChatGPTDOMCollector() {
  if (window.__DOM_COLLECTOR_ACTIVE__) {
    console.warn("⚠️ DOM Collector đã chạy sẵn trên tab này! Gõ window.__DOM_COLLECTOR__.download() để tải dữ liệu.");
    return;
  }
  window.__DOM_COLLECTOR_ACTIVE__ = true;

  console.log("%c🚀 [DOM Collector v3.0] Đang khởi động... Chế độ giám sát DOM thụ động 100%!", "color: #10a37f; font-weight: bold; font-size: 14px;");

  const START_TIME = Date.now();
  const transientTimeline = [];
  const seenSignatures = new Set();
  const capturedDeleteSelectors = {
    threeDotsButton: null,
    menuContainer: null,
    deleteMenuItem: null,
    confirmDialog: null,
    confirmDeleteButton: null,
    cancelButton: null
  };

  // 1. BẢNG SELECTORS TỪ CONFIG.TS & GENERATOR.TS CỦA CODEBASE
  const CODEBASE_SELECTORS = {
    composer: '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"]',
    sendButton: '[data-testid="send-button"]',
    stopButton: 'form [aria-label*="Stop" i], button[aria-label*="Stop" i], form [data-testid="stop-button"], [data-testid="stop-button"]',
    generatedImage: '[data-message-author-role="assistant"] img[src*="backend-api/estuary"], [data-message-author-role="assistant"] img[src*="files.oaiusercontent.com"], [data-message-author-role="assistant"] img[alt*="Generated image"], [data-message-author-role="assistant"] img[src*="oaidallea"], [data-testid*="conversation-turn"] [data-message-author-role="assistant"] img, img[src*="backend-api/estuary"]',
    loginButton: 'button[data-testid="login-button"], a[href*="/auth/login"], button:has-text("Log in"), button:has-text("Đăng nhập")',
    fileInput: 'input#upload-photos[type="file"], input#upload-files[type="file"], input[type="file"]',
    attachButton: 'button[data-testid*="plus"], button[data-testid*="attach"], button[aria-label*="Add files" i], button[aria-label*="Attach" i]',
    attachmentThumbnail: 'form img[src^="blob:"], form button[aria-label*="Remove file" i], button[aria-label*="Remove file" i], form button[aria-label*="Remove" i], [data-testid*="attachment"], [data-testid*="file-pill"], [class*="attachment"], [class*="file-item"]',
    attachmentUploading: 'form [data-testid*="upload-progress"], form [aria-label*="Uploading" i], [data-testid*="attachment"] .animate-spin, form .animate-spin',
    regenerateButton: 'button[data-testid*="regenerate"], button[data-testid*="refresh"], button[data-testid*="retry"], button[aria-label*="Regenerate" i], button[aria-label*="Try again" i]',
    completionAction: 'button[data-testid="copy-turn-action-button"], button[data-testid="good-response"], button[data-testid="bad-response"]',
    assistantTurn: '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"]',
    modalDialog: '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])'
  };

  // 2. SERIALIZER DTO AN TOÀN: LOẠI BỎ TRIỆT ĐỂ LỖI CIRCULAR REFERENCE
  function serializeNodeSafe(el) {
    if (!el || !(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const attrs = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      // Cắt bớt nếu dính chuỗi base64 quá lớn
      attrs[a.name] = a.value.length > 300 ? a.value.slice(0, 300) + "...[TRUNCATED]" : a.value;
    }

    const svgShapes = [];
    el.querySelectorAll("path, rect, circle").forEach((shape) => {
      svgShapes.push({
        type: shape.tagName.toLowerCase(),
        d: shape.getAttribute("d")?.slice(0, 100) || null,
        width: shape.getAttribute("width") || null,
        height: shape.getAttribute("height") || null
      });
    });

    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classList: Array.from(el.classList),
      attributes: attrs,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        isVisible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      },
      computedLayout: {
        display: style.display,
        position: style.position,
        gridTemplateColumns: style.gridTemplateColumns !== "none" ? style.gridTemplateColumns : undefined,
        flexDirection: style.flexDirection !== "row" ? style.flexDirection : undefined,
        gap: style.gap !== "normal" ? style.gap : undefined
      },
      textPreview: (el.textContent || "").trim().slice(0, 120),
      outerSnippet: el.outerHTML ? el.outerHTML.slice(0, 300) : null,
      svgShapes: svgShapes.length > 0 ? svgShapes.slice(0, 5) : undefined
    };
  }

  // 3. MUTATION OBSERVER BẮT PHẦN TỬ THOÁNG QUA (TRANSIENT ELEMENTS)
  let activeStopSnapshot = null;
  let activeUploadSnapshot = null;

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (mut.addedNodes.length > 0) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node;

          // 3.1 Bắt nút Stop
          if (!activeStopSnapshot) {
            const stopBtn = el.matches?.('[data-testid="stop-button"], button[aria-label*="Stop" i]')
              ? el
              : el.querySelector?.('[data-testid="stop-button"], button[aria-label*="Stop" i]');
            if (stopBtn) {
              const sig = "STOP_MOUNT:" + (stopBtn.getAttribute("data-testid") || stopBtn.getAttribute("aria-label") || stopBtn.className);
              if (!seenSignatures.has(sig)) {
                seenSignatures.add(sig);
                activeStopSnapshot = {
                  event: "STOP_BUTTON_MOUNTED",
                  timestamp: new Date().toISOString(),
                  element: serializeNodeSafe(stopBtn)
                };
                transientTimeline.push(activeStopSnapshot);
                console.log("%c🛑 [Transient] Bắt được nút Stop xuất hiện!", "background: #ef4444; color: white; padding: 2px 5px; font-weight: bold;");
              }
            }
          }

          // 3.2 Bắt Spinner hoặc thanh tiến độ upload ảnh
          if (!activeUploadSnapshot) {
            const uploadEl = el.matches?.('[data-testid*="upload-progress"], [aria-label*="Uploading" i], .animate-spin')
              ? el
              : el.querySelector?.('[data-testid*="upload-progress"], [aria-label*="Uploading" i], .animate-spin');
            if (uploadEl) {
              const sig = "UPLOAD_MOUNT:" + (uploadEl.getAttribute("data-testid") || uploadEl.className);
              if (!seenSignatures.has(sig)) {
                seenSignatures.add(sig);
                activeUploadSnapshot = {
                  event: "UPLOAD_PROGRESS_MOUNTED",
                  timestamp: new Date().toISOString(),
                  element: serializeNodeSafe(uploadEl)
                };
                transientTimeline.push(activeUploadSnapshot);
                console.log("%c⏳ [Transient] Bắt được thanh tiến độ upload ảnh!", "background: #f59e0b; color: black; padding: 2px 5px; font-weight: bold;");
              }
            }
          }
        }
      }

      if (mut.removedNodes.length > 0) {
        for (const node of mut.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node;

          if (activeStopSnapshot && (el.matches?.('[data-testid="stop-button"]') || el.querySelector?.('[data-testid="stop-button"]'))) {
            transientTimeline.push({
              event: "STOP_BUTTON_UNMOUNTED",
              timestamp: new Date().toISOString(),
              durationMs: Date.now() - new Date(activeStopSnapshot.timestamp).getTime()
            });
            activeStopSnapshot = null;
            console.log("%c▶️ [Transient] Nút Stop đã biến mất (Quá trình tạo ảnh kết thúc)!", "background: #10a37f; color: white; padding: 2px 5px; font-weight: bold;");
          }

          if (activeUploadSnapshot && (el.matches?.('.animate-spin, [data-testid*="upload-progress"]') || el.querySelector?.('.animate-spin, [data-testid*="upload-progress"]'))) {
            transientTimeline.push({
              event: "UPLOAD_PROGRESS_UNMOUNTED",
              timestamp: new Date().toISOString(),
              durationMs: Date.now() - new Date(activeUploadSnapshot.timestamp).getTime()
            });
            activeUploadSnapshot = null;
            console.log("%c✅ [Transient] Upload ảnh hoàn tất!", "background: #10a37f; color: white; padding: 2px 5px; font-weight: bold;");
          }
        }
      }
    }
  });

  const targetRoot = document.body;
  observer.observe(targetRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-testid", "aria-label", "src"]
  });

  // 4. LÁ CHẮN BẢO VỆ CHỐNG XÓA NHẦM CHAT (SAFE CAPTURE TRAP)
  const deleteSafetyHandler = (e) => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;

    // A. Bắt nút 3 chấm trong sidebar (nút 3 chấm là sibling với thẻ a)
    const itemContainer = target.closest('nav li, [data-testid*="conversation-item"], div[role="listitem"]');
    const convLink = target.closest('a[href*="/c/"]') || itemContainer?.querySelector('a[href*="/c/"]');
    const threeDots = target.closest('button[aria-haspopup="menu"], [data-testid*="conversation-options"]');
    if (threeDots && (convLink || itemContainer)) {
      capturedDeleteSelectors.threeDotsButton = serializeNodeSafe(threeDots);
      console.log("%c🔘 [Delete Safeguard] Đã bắt nút 3 chấm Conversation Options!", "color: #3b82f6; font-weight: bold;");
    }

    // B. Bắt MenuItem Delete trong dropdown menu
    const menuItem = target.closest('[role="menuitem"]');
    if (menuItem && /delete|xóa/i.test(menuItem.textContent || "")) {
      capturedDeleteSelectors.deleteMenuItem = serializeNodeSafe(menuItem);
      capturedDeleteSelectors.menuContainer = serializeNodeSafe(menuItem.closest('[role="menu"]'));
      console.log("%c🗑️ [Delete Safeguard] Đã bắt mục menu Delete Chat!", "color: #f59e0b; font-weight: bold;");
    }

    // C. Bắt nút Xác nhận Xóa trong Modal Dialog & CHẶN ĐỨNG HÀNH VI XÓA THẬT
    const dialog = target.closest('[role="dialog"], [role="alertdialog"]');
    const btn = target.closest("button");
    if (dialog && btn) {
      const txt = (btn.textContent || "").toLowerCase();
      const isDangerBtn = btn.classList.contains("btn-danger") ||
        /danger|destructive|red/i.test(btn.className) ||
        Boolean(btn.getAttribute("data-testid")?.includes("delete"));
      const isDeleteDialog = /delete|xóa|削除|删除|supprimer|eliminar|löschen|삭제|удалить|cancel|confirm/i.test(dialog.textContent || "");
      const isDeleteText = /delete|xóa|削除|删除|supprimer|eliminar|löschen|삭제|удалить/i.test(txt);

      if (isDeleteText || (isDangerBtn && isDeleteDialog)) {
        // CHẶN ĐỨNG EVENT CLICK NGAY TẠI PHA CAPTURE
        e.preventDefault();
        e.stopImmediatePropagation();

        capturedDeleteSelectors.confirmDialog = serializeNodeSafe(dialog);
        capturedDeleteSelectors.confirmDeleteButton = serializeNodeSafe(btn);

        const cancelBtn = dialog.querySelector('button:not([class*="danger"]):not([class*="red"]):not([class*="destructive"])');
        if (cancelBtn) capturedDeleteSelectors.cancelButton = serializeNodeSafe(cancelBtn);

        console.log("%c🛡️ [LÁ CHẮN KÍCH HOẠT] ĐÃ CHẶN CLICK XÓA THẬT! Selector được lưu thành công, chat nguyên vẹn 100%.", "background: #dc2626; color: white; font-weight: bold; font-size: 14px; padding: 4px;");

        // Đóng dialog an toàn bằng phím Escape
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }, 300);
      }
    }
  };
  window.addEventListener("click", deleteSafetyHandler, true);

  // 5. BÓC TÁCH CÁC LƯỢT CHAT (TURNS) VÀ CẤU TRÚC ẢNH
  function extractAllTurnsData() {
    const turnElements = Array.from(document.querySelectorAll('article, [data-testid^="conversation-turn-"]'));
    const turns = [];

    turnElements.forEach((turnEl, idx) => {
      const userMsg = turnEl.querySelector('[data-message-author-role="user"]');
      const assistantMsg = turnEl.querySelector('[data-message-author-role="assistant"]');

      const userAttachments = [];
      if (userMsg) {
        userMsg.querySelectorAll('img, [data-testid*="attachment"]').forEach((att) => {
          userAttachments.push(serializeNodeSafe(att));
        });
      }

      const generatedImages = [];
      const imageContainers = [];
      if (assistantMsg) {
        const imgs = assistantMsg.querySelectorAll('img[src*="files.oaiusercontent.com"], img[src*="estuary"], img[alt*="Generated image"], img[src*="oaidallea"]');
        imgs.forEach((img) => {
          const parent = img.parentElement;
          const container = parent?.closest('div[class*="grid"], div[class*="flex"], div[data-testid*="image"]') || parent;
          generatedImages.push({
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt"),
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            aspectRatio: img.naturalHeight ? (img.naturalWidth / img.naturalHeight).toFixed(2) : null,
            imageNode: serializeNodeSafe(img),
            containerNode: serializeNodeSafe(container)
          });
        });

        const grids = assistantMsg.querySelectorAll('div[class*="grid"], div[style*="grid"]');
        grids.forEach((g) => imageContainers.push(serializeNodeSafe(g)));
      }

      turns.push({
        turnIndex: idx + 1,
        userText: userMsg ? (userMsg.textContent || "").trim() : null,
        userAttachments,
        assistantText: assistantMsg ? (assistantMsg.textContent || "").trim() : null,
        generatedImagesCount: generatedImages.length,
        generatedImages,
        imageContainers
      });
    });

    return turns;
  }

  // 6. KIỂM ĐỊNH SỨC KHỎE SELECTORS TỪ CONFIG.TS
  function verifyCodebaseSelectors() {
    const report = {};
    for (const [key, selectorString] of Object.entries(CODEBASE_SELECTORS)) {
      const subSelectors = selectorString.split(",").map((s) => s.trim());
      const subResults = [];

      for (const sel of subSelectors) {
        let matchedElements = [];
        let error = null;

        try {
          if (sel.includes(":has-text(")) {
            const m = sel.match(/^([a-z0-9_-]+):has-text\("([^"]+)"\)$/i);
            if (m) {
              matchedElements = Array.from(document.querySelectorAll(m[1])).filter((e) =>
                (e.textContent || "").includes(m[2])
              );
            }
          } else {
            matchedElements = Array.from(document.querySelectorAll(sel));
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const visibleCount = matchedElements.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).length;

        let status = "DEAD";
        if (error) {
          status = "SYNTAX_ERROR_PLAYWRIGHT_ONLY";
        } else if (visibleCount > 0) {
          status = "ALIVE_VISIBLE";
        } else if (matchedElements.length > 0) {
          status = "DOM_PRESENT_HIDDEN";
        } else {
          const wasSeen = transientTimeline.some((t) =>
            t.element?.attributes?.["data-testid"]?.includes(key.toLowerCase()) ||
            t.element?.outerSnippet?.includes(sel)
          );
          if (wasSeen) status = "TRANSIENT_SEEN";
        }

        subResults.push({
          subSelector: sel,
          status,
          totalMatched: matchedElements.length,
          visibleCount,
          error,
          sample: matchedElements.length > 0 ? serializeNodeSafe(matchedElements[0]) : null
        });
      }

      const anyAlive = subResults.some((r) => r.status === "ALIVE_VISIBLE" || r.status === "TRANSIENT_SEEN");
      report[key] = {
        overallVerdict: anyAlive ? "PASS" : "FAIL_OR_INACTIVE",
        subResults
      };
    }
    return report;
  }

  // 7. XUẤT BÁO CÁO TOÀN DIỆN
  function generateFullReport() {
    const turns = extractAllTurnsData();
    const selectorReport = verifyCodebaseSelectors();

    return {
      metadata: {
        tool: "ChatGPT-DOM-Collector-v3.0",
        generatedAt: new Date().toISOString(),
        url: window.location.href,
        pathname: window.location.pathname,
        durationSeconds: Math.round((Date.now() - START_TIME) / 1000)
      },
      turnsData: {
        totalTurns: turns.length,
        turns
      },
      transientTimeline,
      selectorAuditReport: selectorReport,
      capturedDeleteFlow: capturedDeleteSelectors
    };
  }

  // 8. TẢI FILE DUMP JSON XUỐNG MÁY
  function downloadJsonFile() {
    const data = generateFullReport();
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chatgpt_dom_dump_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    console.log("%c✅ [DOM Collector] Đã xuất file JSON dump thành công! Hãy ném file này vào project iLab.", "color: #10a37f; font-weight: bold; font-size: 14px;");
  }

  const autoDisconnectTimer = setTimeout(() => {
    cleanup();
    console.log("ℹ️ [DOM Collector] Đã tự động ngắt observer sau 15 phút.");
  }, 15 * 60 * 1000);

  function cleanup() {
    observer.disconnect();
    window.removeEventListener("click", deleteSafetyHandler, true);
    clearTimeout(autoDisconnectTimer);
    window.__DOM_COLLECTOR_ACTIVE__ = false;
  }

  window.__DOM_COLLECTOR__ = {
    dump: generateFullReport,
    download: downloadJsonFile,
    stop: () => {
      cleanup();
      console.log("🛑 [DOM Collector] Đã ngắt toàn bộ Observer và Listeners an toàn!");
    },
    verifySelectors: verifyCodebaseSelectors,
    getTurns: extractAllTurnsData,
    getTransientTimeline: () => transientTimeline,
    getDeleteSelectors: () => capturedDeleteSelectors
  };

  console.group("%c📊 [DOM Collector] TỔNG QUAN TRẠNG THÁI SELECTORS HIỆN TẠI TRÊN TRANG:", "color: #3b82f6; font-size: 13px; font-weight: bold;");
  const quickVerify = verifyCodebaseSelectors();
  console.table(
    Object.entries(quickVerify).map(([k, v]) => ({
      "Nhóm Selector": k,
      "Đánh Giá": v.overallVerdict === "PASS" ? "🟢 PASS" : "🔴 CHƯA THẤY / CẦN TEST",
      "Chi Tiết Sub-selectors": v.subResults.map((s) => `${s.subSelector} (${s.status})`).join(" | ")
    }))
  );
  console.groupEnd();

  console.log("%c👉 M HÃY THỰC HIỆN 3 TURN (Tạo 2 ảnh -> Edit ảnh -> Tạo 1 ảnh) RỒI GÕ: window.__DOM_COLLECTOR__.download()", "color: #8b5cf6; font-size: 13px; font-weight: bold;");
})();
