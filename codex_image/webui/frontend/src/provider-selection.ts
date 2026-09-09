import type {
  CatalogProvider,
  CatalogProviderBinding,
  GenerationCatalog,
  GenerationOperation,
} from "./types";
import { getLegacyBridge } from "./state";
import { translate } from "./i18n";
import { syncThemedSelect } from "./themed-select";

export interface EligibleProviderBinding {
  provider: CatalogProvider;
  binding: CatalogProviderBinding;
  selectionKey: string;
}

export function providerBindingSelectionKey(providerId: string, bindingId: string): string {
  return `${providerId}::${bindingId}`;
}

function providerIsEligible(
  catalog: GenerationCatalog,
  provider: CatalogProvider,
  modelId: string | null,
): boolean {
  if (!provider.available || !modelId) return false;
  const model = catalog.models.find((item) => item.id === modelId);
  return provider.id !== "codex"
    || (catalog.codex.available && model?.family_id === "gpt-image" && model.id === "gpt-image-2");
}

export function eligibleProviderBindings(
  catalog: GenerationCatalog,
  modelId: string | null,
  operation: GenerationOperation,
): EligibleProviderBinding[] {
  if (!modelId) return [];
  return catalog.providers.flatMap((provider) => {
    if (!providerIsEligible(catalog, provider, modelId)) return [];
    return provider.bindings
      .filter((binding) => (
        binding.canonical_model_id === modelId
        && binding.operations.includes(operation)
        && binding.available !== false
      ))
      .map((binding) => ({
        provider,
        binding,
        selectionKey: providerBindingSelectionKey(provider.id, binding.id),
      }));
  });
}

export function eligibleProviders(
  catalog: GenerationCatalog,
  modelId: string | null,
  operation: GenerationOperation,
): CatalogProvider[] {
  const providers = new Map<string, CatalogProvider>();
  eligibleProviderBindings(catalog, modelId, operation).forEach(({ provider }) => {
    providers.set(provider.id, provider);
  });
  return [...providers.values()];
}

function preferredProviderBinding(
  entries: readonly EligibleProviderBinding[],
  providerId: string | null | undefined,
  codexMode: "images" | "responses",
): EligibleProviderBinding | null {
  const providerEntries = entries.filter((entry) => entry.provider.id === providerId);
  if (!providerEntries.length) return null;
  if (providerId === "codex") {
    return providerEntries.find((entry) => entry.binding.protocol_profile === `codex_${codexMode}`)
      || providerEntries[0]
      || null;
  }
  return providerEntries[0] || null;
}

export function resolveProviderSelection(
  entries: readonly EligibleProviderBinding[],
  lastSelectionKey: string | null | undefined,
  lastProviderId: string | null | undefined,
  defaultProviderId: string | null | undefined,
  codexMode: "images" | "responses",
): EligibleProviderBinding | null {
  if (lastSelectionKey) {
    const remembered = entries.find((entry) => entry.selectionKey === lastSelectionKey);
    if (remembered) return remembered;
  }
  return preferredProviderBinding(entries, lastProviderId, codexMode)
    || preferredProviderBinding(entries, defaultProviderId, codexMode)
    || entries[0]
    || null;
}

export function resolveProviderId(
  eligible: readonly CatalogProvider[],
  lastProviderId: string | null | undefined,
  defaultProviderId: string | null | undefined,
): string | null {
  const ids = new Set(eligible.map((provider) => provider.id));
  if (lastProviderId && ids.has(lastProviderId)) return lastProviderId;
  if (defaultProviderId && ids.has(defaultProviderId)) return defaultProviderId;
  return eligible[0]?.id ?? null;
}

export function selectedProviderBinding(): CatalogProviderBinding | null {
  const { state } = getLegacyBridge();
  const provider = state.generationCatalog?.providers.find((item) => item.id === state.selectedProviderId);
  const candidates = provider?.bindings.filter((binding) => (
    binding.canonical_model_id === state.selectedModelId
    && binding.operations.includes(state.mode as GenerationOperation)
    && binding.available !== false
  )) || [];
  return candidates.find((binding) => binding.id === state.selectedProviderBindingId)
    || candidates[0]
    || null;
}

export function syncCodexCatalogMode(mode: "images" | "responses"): void {
  const { state } = getLegacyBridge();
  const catalog = state.generationCatalog;
  if (!catalog) return;
  catalog.codex.mode = mode;
  if (state.selectedProviderId !== "codex") return;
  const selected = preferredProviderBinding(
    eligibleProviderBindings(catalog, state.selectedModelId, state.mode as GenerationOperation),
    "codex",
    mode,
  );
  if (selected) state.selectedProviderBindingId = selected.binding.id;
  renderProviderSelection();
}

export function settingsTabForProvider(_providerId: string | null | undefined): "api" {
  return "api";
}

function optionLabel(entry: EligibleProviderBinding): string {
  return entry.binding.display_name || entry.provider.name;
}

function applyOptionIcon(option: HTMLOptionElement, entry: EligibleProviderBinding): void {
  if (entry.provider.id === "codex") {
    option.dataset.optionIcon = "/static/brand/codex-channel-mark.svg";
    option.dataset.optionIconKind = "image";
    return;
  }
  if (entry.provider.icon_emoji) {
    option.dataset.optionIcon = entry.provider.icon_emoji;
    option.dataset.optionIconKind = "emoji";
  }
}

export function renderProviderSelection(): void {
  const { state, els } = getLegacyBridge();
  const select = els.generationProviderSelect as HTMLSelectElement | null;
  const catalog = state.generationCatalog;
  const entries = catalog
    ? eligibleProviderBindings(catalog, state.selectedModelId, state.mode as GenerationOperation)
    : [];
  const resolved = catalog
    ? resolveProviderSelection(
        entries,
        state.lastProviderSelectionByModel[state.selectedModelId || ""],
        state.lastProviderByModel[state.selectedModelId || ""],
        catalog.default_provider_by_model[state.selectedModelId || ""],
        catalog.codex.mode,
      )
    : null;
  state.selectedProviderId = resolved?.provider.id || null;
  state.selectedProviderBindingId = resolved?.binding.id || null;
  state.authAvailable = Boolean(resolved);

  if (select) {
    select.replaceChildren();
    if (!entries.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = catalog
        ? translate("modelSelection.providerUnavailable")
        : translate("modelSelection.catalogUnavailable");
      select.append(option);
    } else {
      for (const entry of entries) {
        const option = document.createElement("option");
        option.value = entry.selectionKey;
        option.textContent = optionLabel(entry);
        option.title = optionLabel(entry);
        applyOptionIcon(option, entry);
        select.append(option);
      }
    }
    select.value = resolved?.selectionKey || "";
    select.disabled = !resolved;
    select.title = resolved ? optionLabel(resolved) : "";
    syncThemedSelect(select);
  }
  syncChatGPTDeleteChatControl();
  if (els.runButton) els.runButton.disabled = !resolved;
}

export function isChatGPTWebProvider(): boolean {
  const { state } = getLegacyBridge();
  const providerId = state.selectedProviderId || state.apiSettings?.active_provider_id;
  if (!providerId) return false;
  if (providerId === "default") return true;
  if (providerId.toLowerCase().includes("chatgpt")) return true;

  const provider = state.generationCatalog?.providers.find((item) => item.id === providerId);
  const providerName = (provider?.name || "").toLowerCase();
  const providerBaseUrl = typeof provider?.base_url === "string" ? provider.base_url.toLowerCase() : "";
  if (providerName.includes("chatgpt")) return true;
  if (providerBaseUrl.includes(":3000") || providerBaseUrl.includes("chatgpt-bridge")) return true;

  const providerSettings = state.apiSettings?.providers?.find((item: any) => item.id === providerId);
  const settingsName = (providerSettings?.name || "").toLowerCase();
  const settingsBaseUrl = typeof providerSettings?.base_url === "string" ? providerSettings.base_url.toLowerCase() : "";
  if (settingsName.includes("chatgpt")) return true;
  if (settingsBaseUrl.includes(":3000") || settingsBaseUrl.includes("chatgpt-bridge")) return true;

  return false;
}

export function syncChatGPTDeleteChatControl(): void {
  const { els, methods, state } = getLegacyBridge();
  const isChatGPT = isChatGPTWebProvider();
  if (els.chatgptDeleteChatField) {
    els.chatgptDeleteChatField.style.display = isChatGPT ? "" : "none";
    els.chatgptDeleteChatField.classList.toggle("hidden", !isChatGPT);
  }
  if (els.chatgptBrowserField) {
    els.chatgptBrowserField.style.display = isChatGPT ? "" : "none";
    els.chatgptBrowserField.classList.toggle("hidden", !isChatGPT);
  }
  const ratioField = els.ratio?.closest(".ratio-field") as HTMLElement | null;
  if (ratioField) {
    if (isChatGPT) {
      ratioField.style.display = "none";
      ratioField.classList.add("hidden");
    } else {
      const isLegacyGpt = state.selectedModelId === "gpt-image-2";
      if (isLegacyGpt) {
        ratioField.style.display = "";
        ratioField.classList.remove("hidden");
      }
    }
  }
  if (isChatGPT && typeof methods.restoreChatGPTDeleteChatState === "function") {
    methods.restoreChatGPTDeleteChatState();
  }
  if (isChatGPT && typeof methods.restoreChatGPTBrowserState === "function") {
    methods.restoreChatGPTBrowserState();
  }
  if (els.webSearchField) {
    els.webSearchField.style.display = isChatGPT ? "none" : "";
    if (isChatGPT) els.webSearchField.classList.add("hidden");
  }
}

export function selectGenerationProvider(selectionOrProviderId: string): void {
  const { state } = getLegacyBridge();
  const catalog = state.generationCatalog;
  if (!catalog || !state.selectedModelId) return;
  const entries = eligibleProviderBindings(catalog, state.selectedModelId, state.mode as GenerationOperation);
  const selected = entries.find((entry) => entry.selectionKey === selectionOrProviderId)
    || preferredProviderBinding(entries, selectionOrProviderId, catalog.codex.mode);
  if (!selected) {
    renderProviderSelection();
    return;
  }
  state.selectedProviderId = selected.provider.id;
  state.selectedProviderBindingId = selected.binding.id;
  state.lastProviderByModel[state.selectedModelId] = selected.provider.id;
  state.lastProviderSelectionByModel[state.selectedModelId] = selected.selectionKey;
  getLegacyBridge().methods.persistModelSelection?.();
  renderProviderSelection();
  getLegacyBridge().methods.updateModeSpecificSettings?.();
  getLegacyBridge().methods.updateRequestPreview?.();
}

export function initProviderSelectionFeature(): void {
  Object.assign(getLegacyBridge().methods, {
    eligibleProviders,
    eligibleProviderBindings,
    resolveProviderId,
    resolveProviderSelection,
    settingsTabForProvider,
    renderProviderSelection,
    selectedProviderBinding,
    selectGenerationProvider,
    syncCodexCatalogMode,
    isChatGPTWebProvider,
    syncChatGPTDeleteChatControl,
  });
}
