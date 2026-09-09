import { getLegacyBridge } from "./state";
import {
  closeMainModelCombobox,
  currentMainModel,
  handleMainModelKeydown,
  mainModelOptionsForQuery,
  openMainModelCombobox,
  persistMainModel,
  renderMainModelOptions,
  restoreMainModel,
  selectMainModelOption,
} from "./main-model-combobox";
import {
  closeCompressionPopover,
  currentQuantity,
  handleOutputFormatDoubleClick,
  openCompressionPopover,
  syncRadioButtons,
  updateCompression,
  updateQuantity,
  updateRequestPreview,
} from "./output-controls";
import {
  customSizeValidationMessage,
  currentImageToolModel,
  currentSize,
  currentTaskParams,
  currentWebSearchEnabled,
  webSearchSupportedForCurrentBackend,
} from "./size-presets";
import {
  applyFirstReferenceImageAspectRatio,
  handleCustomDimensionInput,
  handleCustomRatioInput,
  handleSizeModeEvent,
  swapCustomSizeDimensions,
  syncSizeControlsFromSize,
  updateCustomSize,
  updatePixelPreview,
  updateSizeFromPreset,
  updateCustomRatioFieldState,
  updateCustomRatioReferenceButtonState,
  isProgrammaticSizeSync,
} from "./custom-size-controls";
import { LOCALE_CHANGE_EVENT, translate } from "./i18n";
import { restoreCurrentModelParameterDraft, saveCurrentModelParameterDraft } from "./model-parameter-drafts";

const bridge = getLegacyBridge();
const state = bridge.state;
const els = bridge.els;

let formControlsInitialized = false;
let formControlEventsBound = false;
const CHATGPT_DELETE_CHAT_STORAGE_KEY = "codex-image-chatgpt-delete-chat";
const CHATGPT_VISIBLE_BROWSER_STORAGE_KEY = "codex-image-chatgpt-visible-browser";
const CHATGPT_BROWSER_STORAGE_KEY = "codex-image-chatgpt-browser";

export function syncChatGPTBrowserState(browser?: "chrome" | "edge"): void {
  const current = browser || (els.chatgptBrowser?.value === "chrome" ? "chrome" : "edge");
  if (els.chatgptBrowser) {
    els.chatgptBrowser.value = current;
  }
  if (els.chatgptBrowserGroup) {
    const buttons = els.chatgptBrowserGroup.querySelectorAll(".radio-btn");
    buttons.forEach((btn: Element) => {
      const active = (btn.getAttribute("data-browser") || "edge") === current;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }
}

export function restoreChatGPTBrowserState(): void {
  const provider = activeChatGPTProvider();
  const providerSetting = typeof provider?.browser === "string" ? provider.browser.toLowerCase() : null;
  const saved = localStorage.getItem(CHATGPT_BROWSER_STORAGE_KEY);
  const browser: "chrome" | "edge" =
    (providerSetting === "chrome" || saved === "chrome") ? "chrome" : "edge";
  syncChatGPTBrowserState(browser);
  localStorage.setItem(CHATGPT_BROWSER_STORAGE_KEY, browser);
}

export function persistChatGPTBrowserState(browser: "chrome" | "edge"): void {
  localStorage.setItem(CHATGPT_BROWSER_STORAGE_KEY, browser);
  syncChatGPTBrowserState(browser);
  const provider = activeChatGPTProvider();
  if (provider && state.apiSettings?.providers) {
    const target = state.apiSettings.providers.find((p: any) => p.id === provider.id);
    if (target && target.browser !== browser) {
      target.browser = browser;
      const methods = getLegacyBridge().methods;
      if (typeof methods?.persistApiSettings === "function") {
        methods.persistApiSettings();
      }
      if (typeof methods?.queueApiSettingsAutosave === "function") {
        methods.queueApiSettingsAutosave();
      }
    }
  }
}

export function currentChatGPTBrowser(): "chrome" | "edge" {
  return els.chatgptBrowser?.value === "chrome" ? "chrome" : "edge";
}

export function syncChatGPTDeleteChatState(): void {
  if (!els.chatgptDeleteChat) return;
  const isChecked = Boolean(els.chatgptDeleteChat.checked);
  if (els.chatgptDeleteChatStatus) {
    els.chatgptDeleteChatStatus.textContent = translate(
      isChecked ? "output.chatgptDeleteChatToggle" : "output.chatgptDeleteChatToggleOff",
    );
  }
}

export function syncChatGPTVisibleBrowserState(): void {}

function activeChatGPTProvider(): any {
  const providerId = state.selectedProviderId || state.apiSettings?.active_provider_id;
  const providers = state.apiSettings?.providers || state.generationCatalog?.providers || [];
  return providers.find((item: any) => item.id === providerId)
    || providers.find((item: any) => item.id === "default")
    || providers.find((item: any) => (item.name || "").toLowerCase().includes("chatgpt"))
    || null;
}

export function restoreChatGPTDeleteChatState(): void {
  if (!els.chatgptDeleteChat) return;
  const provider = activeChatGPTProvider();
  const providerSetting = typeof provider?.delete_chat_after_gen === "boolean" ? provider.delete_chat_after_gen : null;
  const saved = localStorage.getItem(CHATGPT_DELETE_CHAT_STORAGE_KEY);
  const enabled = providerSetting !== null ? providerSetting : (saved !== null ? saved !== "false" : true);
  els.chatgptDeleteChat.checked = enabled;
  localStorage.setItem(CHATGPT_DELETE_CHAT_STORAGE_KEY, String(enabled));
  syncChatGPTDeleteChatState();
}

export function restoreChatGPTVisibleBrowserState(): void {}

export function persistChatGPTDeleteChatState(): void {
  if (!els.chatgptDeleteChat) return;
  const enabled = Boolean(els.chatgptDeleteChat.checked);
  localStorage.setItem(CHATGPT_DELETE_CHAT_STORAGE_KEY, String(enabled));
  syncChatGPTDeleteChatState();
  const provider = activeChatGPTProvider();
  if (provider && state.apiSettings?.providers) {
    const target = state.apiSettings.providers.find((p: any) => p.id === provider.id);
    if (target && target.delete_chat_after_gen !== enabled) {
      target.delete_chat_after_gen = enabled;
      const methods = getLegacyBridge().methods;
      if (typeof methods?.persistApiSettings === "function") {
        methods.persistApiSettings();
      }
      if (typeof methods?.queueApiSettingsAutosave === "function") {
        methods.queueApiSettingsAutosave();
      }
    }
  }
  if (els.apiProviderDeleteChat) {
    els.apiProviderDeleteChat.checked = enabled;
  }
}

export function persistChatGPTVisibleBrowserState(): void {}

export function currentChatGPTDeleteChatEnabled(): boolean {
  return Boolean(els.chatgptDeleteChat?.checked ?? true);
}

export function currentChatGPTVisibleBrowserEnabled(): boolean {
  return true;
}

function syncRunButtonLabel(): void {
  if (!els.runButton || state.runTimerId) return;
  const mode = state.mode === "edit" ? "edit" : "generate";
  els.runButton.textContent = translate(mode === "edit" ? "prompt.runEdit" : "prompt.run");
  els.runButton.title = translate(mode === "edit" ? "prompt.runEditTitle" : "prompt.runTitle");
}

export function bindFormControlEvents(): void {
  if (formControlEventsBound) return;
  formControlEventsBound = true;

  restoreChatGPTDeleteChatState();
  restoreChatGPTBrowserState();
  const handleChatGPTDeleteChatChange = () => {
    persistChatGPTDeleteChatState();
    updateRequestPreview();
  };
  els.chatgptDeleteChat?.addEventListener("input", handleChatGPTDeleteChatChange);
  els.chatgptDeleteChat?.addEventListener("change", handleChatGPTDeleteChatChange);

  els.chatgptBrowserGroup?.addEventListener("click", (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".radio-btn");
    if (!button || button.disabled || button.classList.contains("disabled")) return;
    const browser = button.getAttribute("data-browser") === "edge" ? "edge" : "chrome";
    persistChatGPTBrowserState(browser);
    updateRequestPreview();
  });

  document.querySelectorAll("[data-mode]").forEach((button: any) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  [
    els.mainModel,
    els.webSearch,
    els.model,
    els.size,
    els.customWidth,
    els.customHeight,
    els.quality,
    els.outputFormat,
    els.moderation,
    els.compression,
    els.nInput,
    els.promptFidelity,
  ].filter(Boolean).forEach((element: any) => {
    const handleParameterChange = () => {
    persistMainModel();
    updateQuantity();
    updateCompression();
    if (element === els.customWidth || element === els.customHeight) handleCustomDimensionInput(element);
    updateCustomSize();
    if (element === els.customWidth || element === els.customHeight) updatePixelPreview("custom");
    updateRequestPreview();
    saveCurrentModelParameterDraft();
    };
    element.addEventListener("input", handleParameterChange);
    element.addEventListener("change", handleParameterChange);
  });

  els.mainModel?.addEventListener("focus", () => openMainModelCombobox({ showAll: true }));
  els.mainModel?.addEventListener("click", () => {
    if (!state.mainModelComboboxOpen) openMainModelCombobox({ showAll: true });
  });
  els.mainModel?.addEventListener("input", () => {
    state.mainModelShowAllOptions = false;
    openMainModelCombobox();
    renderMainModelOptions();
  });
  els.mainModel?.addEventListener("keydown", handleMainModelKeydown);
  els.mainModelToggle?.addEventListener("click", (event: any) => {
    event.preventDefault();
    if (state.mainModelComboboxOpen) {
      closeMainModelCombobox();
    } else {
      openMainModelCombobox({ showAll: true });
      els.mainModel?.focus();
    }
  });
  document.addEventListener("click", (event: any) => {
    if (!els.mainModelCombobox || els.mainModelCombobox.contains(event.target)) return;
    closeMainModelCombobox();
  });

  [els.resolution, els.ratio, els.orientation].filter(Boolean).forEach((element: any) => {
    element.addEventListener("input", (event: any) => {
      if (isProgrammaticSizeSync()) return;
      updateSizeFromPreset(event);
      saveCurrentModelParameterDraft();
    });
    element.addEventListener("change", (event: any) => {
      if (isProgrammaticSizeSync()) return;
      updateSizeFromPreset(event);
      saveCurrentModelParameterDraft();
    });
  });
  [els.customRatioWidth, els.customRatioHeight].filter(Boolean).forEach((element: any) => {
    element.addEventListener("input", () => {
      handleCustomRatioInput(element);
      updateCustomSize();
      updatePixelPreview("custom");
      updateRequestPreview();
      saveCurrentModelParameterDraft();
    });
  });
  els.sizeModeGroup?.addEventListener("click", handleSizeModeEvent);
  els.swapCustomSizeButton?.addEventListener("click", swapCustomSizeDimensions);
  els.customRatioFromImageButton?.addEventListener("click", (event: any) => {
    void applyFirstReferenceImageAspectRatio(event);
  });
  if (els.customSizeToggle) {
    els.customSizeToggle.addEventListener("change", updateSizeFromPreset);
  }
  els.outputFormatGroup?.addEventListener("dblclick", handleOutputFormatDoubleClick);
}

export function setMode(mode: any): void {
  saveCurrentModelParameterDraft();
  state.mode = mode;
  document.querySelectorAll("[data-mode]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  if (!state.runTimerId) {
    syncRunButtonLabel();
  }
  syncRadioButtons(els.quality, els.outputFormat, els.moderation);
  bridge.methods.renderProviderSelection?.();
  restoreCurrentModelParameterDraft();
  bridge.methods.updateModeSpecificSettings?.();
  bridge.methods.updateRequestPreview?.();
}

export function initFormControlsFeature(): void {
  if (formControlsInitialized) return;
  formControlsInitialized = true;
  document.addEventListener(LOCALE_CHANGE_EVENT, syncRunButtonLabel);
  document.addEventListener(LOCALE_CHANGE_EVENT, syncChatGPTDeleteChatState);
  document.addEventListener(LOCALE_CHANGE_EVENT, syncChatGPTVisibleBrowserState);
  Object.assign(getLegacyBridge().methods, {
    bindFormControlEvents,
    syncChatGPTDeleteChatState,
    restoreChatGPTDeleteChatState,
    persistChatGPTDeleteChatState,
    currentChatGPTDeleteChatEnabled,
    syncChatGPTVisibleBrowserState,
    restoreChatGPTVisibleBrowserState,
    persistChatGPTVisibleBrowserState,
    currentChatGPTVisibleBrowserEnabled,
    syncChatGPTBrowserState,
    restoreChatGPTBrowserState,
    persistChatGPTBrowserState,
    currentChatGPTBrowser,
    setMode,
    syncRunButtonLabel,
    updateQuantity,
    updateCompression,
    openCompressionPopover,
    closeCompressionPopover,
    currentSize,
    currentTaskParams,
    currentMainModel,
    currentQuantity,
    currentImageToolModel,
    currentWebSearchEnabled,
    webSearchSupportedForCurrentBackend,
    restoreMainModel,
    persistMainModel,
    syncSizeControlsFromSize,
    updateSizeFromPreset,
    updateCustomSize,
    updateCustomRatioFieldState,
    updateCustomRatioReferenceButtonState,
    updatePixelPreview,
    customSizeValidationMessage,
    syncRadioButtons,
    updateRequestPreview,
    mainModelOptionsForQuery,
    openMainModelCombobox,
    closeMainModelCombobox,
    renderMainModelOptions,
    selectMainModelOption,
    handleMainModelKeydown,
    handleSizeModeEvent,
    handleCustomDimensionInput,
    handleCustomRatioInput,
    applyFirstReferenceImageAspectRatio,
    swapCustomSizeDimensions,
    handleOutputFormatDoubleClick,
  });
}
