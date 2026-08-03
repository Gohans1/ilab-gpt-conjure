import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("staged preview references survive a history round trip in the same tab", async () => {
  const storage = new MemoryStorage();
  const state: any = { collectedReferences: [] };
  const revokedImageLists: any[][] = [];
  let promptMentionSyncCount = 0;
  const eventTarget = { addEventListener() {} };
  const bridge: any = {
    state,
    els: {
      clearPromptButton: eventTarget,
      refreshButton: eventTarget,
      runButton: { ...eventTarget, disabled: false },
    },
    boot() {},
    constants: { defaultDocumentTitle: "iLab CONJURE" },
    methods: {
      escapeHtml(value: unknown) {
        return String(value);
      },
      renderImageStrip() {},
      revokeUploadPreviewUrls(sources: any[]) {
        revokedImageLists.push(sources);
      },
      setMode(mode: string) {
        state.mode = mode;
      },
      setStatus() {},
      syncPromptGalleryMentionsFromInputs() {
        promptMentionSyncCount += 1;
      },
      updateRequestPreview() {},
    },
  };
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;
  const previousFetch = (globalThis as any).fetch;
  const previousSessionStorage = (globalThis as any).sessionStorage;
  (globalThis as any).window = {
    __codexImageWebUI: bridge,
    startRealtimeUpdates: () => true,
  };
  (globalThis as any).document = {
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  (globalThis as any).sessionStorage = storage;
  (globalThis as any).fetch = async () => new Response(
    new Blob(["replacement"], { type: "image/png" }),
    { status: 200 },
  );

  try {
    const { initInputSourcesFeature } = await import(
      "../../codex_image/webui/frontend/src/input-sources"
    );
    initInputSourcesFeature();
    bridge.methods.revokeUploadPreviewUrls = (sources: any[]) => {
      revokedImageLists.push(sources);
    };
    bridge.methods.collectReferenceOutput("/outputs/task-a/1.png", {
      name: "task-a-1.png",
      sourceTaskId: "task-a",
      outputIndex: 1,
    });

    assert.notEqual(
      storage.getItem("codex-image-staged-references"),
      null,
      "staging a preview should persist it for the current tab",
    );

    state.collectedReferences = [];
    const { bootWebUI } = await import(
      "../../codex_image/webui/frontend/src/boot"
    );
    bootWebUI(state, bridge.els, bridge.methods);

    assert.deepEqual(state.collectedReferences, [{
      url: "/outputs/task-a/1.png",
      name: "task-a-1.png",
      sourceTaskId: "task-a",
      outputIndex: 1,
    }]);

    const oldImages = [
      { kind: "upload", name: "old-upload.png", previewUrl: "blob:old-upload" },
      { kind: "gallery", id: "old-gallery", name: "Old gallery image" },
    ];
    const existingReferenceFile = { kind: "upload", filename: "brief.pdf" };
    state.images = oldImages;
    state.referenceFiles = [existingReferenceFile];
    state.mode = "edit";
    const promptMentionSyncCountBeforeReplace = promptMentionSyncCount;

    await bridge.methods.addCollectedReferencesToInput({ replace: true });

    assert.equal(state.images.length, 1);
    assert.equal(state.images[0].kind, "upload");
    assert.equal(state.images[0].name, "task-a-1.png");
    assert.deepEqual(state.referenceFiles, [existingReferenceFile]);
    assert.deepEqual(revokedImageLists, [oldImages]);
    assert.equal(promptMentionSyncCount, promptMentionSyncCountBeforeReplace + 1);
    assert.deepEqual(state.collectedReferences, []);
  } finally {
    (globalThis as any).window = previousWindow;
    (globalThis as any).document = previousDocument;
    (globalThis as any).fetch = previousFetch;
    (globalThis as any).sessionStorage = previousSessionStorage;
  }
});
