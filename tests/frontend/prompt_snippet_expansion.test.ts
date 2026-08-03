import assert from "node:assert/strict";
import test from "node:test";

test("adjacent prompt snippet chips both expand before submission", async () => {
  const bridge: any = {
    state: {
      promptSnippets: [
        { id: "makeup", tag: "妆容", title: "妆容", content: "妆容完整内容", category: "常用", order: 0 },
        { id: "skin", tag: "肤质", title: "肤质", content: "肤质完整内容", category: "常用", order: 1 },
      ],
    },
    els: {},
    methods: {},
  };
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { __codexImageWebUI: bridge };

  try {
    const { initPromptSnippetsFeature } = await import(
      "../../codex_image/webui/frontend/src/prompt-snippets"
    );
    initPromptSnippetsFeature();

    assert.equal(
      bridge.methods.expandPromptSnippets("主体描述。~妆容~肤质"),
      "主体描述。妆容完整内容肤质完整内容",
    );
    assert.equal(
      bridge.methods.expandPromptSnippets("普通正文中的波浪号~妆容"),
      "普通正文中的波浪号~妆容",
      "a tilde embedded in ordinary text must not become a snippet reference",
    );
  } finally {
    (globalThis as any).window = previousWindow;
  }
});
