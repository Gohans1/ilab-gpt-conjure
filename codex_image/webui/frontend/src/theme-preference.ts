export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

export const THEME_STORAGE_KEY =
  "codex-image-theme-preference";

let themeTransitionFrame: number | null = null;

export function normalizeThemePreference(
  value: unknown,
): ThemePreference {
  return value === "light" || value === "dark"
    ? value
    : "system";
}

export function readThemePreference(
  storage: Pick<Storage, "getItem"> = localStorage,
): ThemePreference {
  try {
    return normalizeThemePreference(
      storage.getItem(THEME_STORAGE_KEY),
    );
  } catch {
    return "system";
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Restricted storage must not block a visible theme change.
  }
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemDark =
    window.matchMedia?.("(prefers-color-scheme: dark)")
      ?.matches === true,
): EffectiveTheme {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return systemDark ? "dark" : "light";
}

function lockThemeTransitions(root: HTMLElement): void {
  root.classList.add("theme-transition-lock");
  const requestFrame = window.requestAnimationFrame?.bind(window);
  if (!requestFrame) {
    root.classList.remove("theme-transition-lock");
    return;
  }
  if (themeTransitionFrame !== null) {
    window.cancelAnimationFrame?.(themeTransitionFrame);
  }
  themeTransitionFrame = requestFrame(() => {
    themeTransitionFrame = requestFrame(() => {
      root.classList.remove("theme-transition-lock");
      themeTransitionFrame = null;
    });
  });
}

export function applyDocumentTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
  systemDark =
    window.matchMedia?.("(prefers-color-scheme: dark)")
      ?.matches === true,
): EffectiveTheme {
  const normalized = normalizeThemePreference(preference);
  const effective = resolveEffectiveTheme(
    normalized,
    systemDark,
  );
  if (root.dataset.theme !== effective) {
    lockThemeTransitions(root);
  }
  root.dataset.theme = effective;
  root.dataset.themePreference = normalized;
  return effective;
}

export function syncThemeSwitcher(
  root: HTMLElement | null,
  preference: ThemePreference,
): void {
  root
    ?.querySelectorAll<HTMLElement>("[data-theme-option]")
    .forEach((button) => {
      const active =
        button.dataset.themeOption === preference;
      button.classList.toggle("active", active);
      button.setAttribute(
        "aria-pressed",
        active ? "true" : "false",
      );
    });
}

export function bindThemeSwitcher(
  root: HTMLElement | null,
  onSelect: (preference: ThemePreference) => void,
): () => void {
  if (!root) return () => undefined;
  const handleClick = (event: Event): void => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLElement>(
      "[data-theme-option]",
    );
    if (!button || !root.contains(button)) return;
    const value = button.dataset.themeOption;
    if (
      value !== "system" &&
      value !== "light" &&
      value !== "dark"
    ) {
      return;
    }
    onSelect(value);
  };
  root.addEventListener("click", handleClick);
  return () => root.removeEventListener("click", handleClick);
}

export function bindSystemThemePreference(
  onChange: (systemDark: boolean) => void,
): () => void {
  const media = window.matchMedia?.(
    "(prefers-color-scheme: dark)",
  );
  if (!media) return () => undefined;
  const handleChange = (event: MediaQueryListEvent): void => {
    onChange(event.matches);
  };
  if (media.addEventListener) {
    media.addEventListener("change", handleChange);
    return () =>
      media.removeEventListener("change", handleChange);
  }
  media.addListener?.(handleChange);
  return () => media.removeListener?.(handleChange);
}
