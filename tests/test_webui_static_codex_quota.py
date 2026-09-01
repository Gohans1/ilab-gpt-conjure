from __future__ import annotations

import unittest
from pathlib import Path


class WebUIStaticCodexQuotaTests(unittest.TestCase):
    def test_quota_mount_is_immediately_before_provider_control(self) -> None:
        html = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")
        quota_index = html.index('id="codexQuota"')
        provider_index = html.index('<div class="generation-provider-control">')

        self.assertLess(quota_index, provider_index)
        self.assertIn('class="codex-quota"', html)
        self.assertIn('id="codexQuotaFill"', html)
        self.assertIn('id="codexQuotaValue"', html)
        self.assertIn('data-i18n-attr="aria-label:codexQuota.label;title:codexQuota.label"', html)

    def test_quota_mount_opens_a_single_account_detail_panel(self) -> None:
        html = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")

        self.assertIn('<button id="codexQuota"', html)
        self.assertIn('aria-controls="codexQuotaPanel"', html)
        self.assertIn('id="codexQuotaPanel"', html)
        self.assertIn('id="codexQuotaWindows"', html)
        self.assertIn('id="codexQuotaResetBank"', html)
        self.assertIn('id="codexQuotaPanelClose"', html)
        self.assertIn('data-i18n="codexQuota.label"', html)
        self.assertIn('data-i18n="codexQuota.currentAccount"', html)
        self.assertNotIn("Add account", html)

    def test_main_initializes_quota_feature(self) -> None:
        source = Path("codex_image/webui/frontend/src/main.ts").read_text(encoding="utf-8")

        self.assertIn('import { initCodexQuotaFeature } from "./codex-quota";', source)
        self.assertIn("initCodexQuotaFeature();", source)

    def test_quota_percent_normalization_keeps_unknown_as_null(self) -> None:
        module_path = Path("codex_image/webui/frontend/src/codex-quota.ts")
        source = module_path.read_text(encoding="utf-8")
        self.assertIn("export function normalizeRemainingPercent", source)
        self.assertIn("if (value == null)", source)
        self.assertIn("return null", source)
        self.assertIn("Math.max(0, Math.min(100", source)

    def test_quota_source_contains_eight_checkpoint_and_banked_reset_rendering(self) -> None:
        source = Path("codex_image/webui/frontend/src/codex-quota.ts").read_text(encoding="utf-8")

        self.assertIn("QUOTA_CHECKPOINT_COUNT = 7", source)
        self.assertIn("buildQuotaPacing", source)
        self.assertIn("banked_resets", source)
        self.assertIn("banked_reset_credits", source)
        self.assertIn("codexQuotaPanelClose", source)
        self.assertIn("/api/codex/quota", source)
        self.assertIn("formatTranslation", source)
        self.assertIn("LOCALE_CHANGE_EVENT", source)
        self.assertIn("document.addEventListener(LOCALE_CHANGE_EVENT", source)

    def test_quota_pacing_matches_plugin_direction_and_click_detail(self) -> None:
        source = Path("codex_image/webui/frontend/src/codex-quota.ts").read_text(encoding="utf-8")

        self.assertIn("const markerPoint = QUOTA_MARKER_COUNT - index;", source)
        self.assertIn("Number(((index * 100) / QUOTA_CHECKPOINT_COUNT).toFixed(1))", source)
        self.assertIn("marker.style.left = `${checkpoint}%`;", source)
        self.assertIn("codex-quota-pacing-fill", source)
        self.assertIn('marker.addEventListener("click"', source)
        self.assertIn('const nowMarker = document.createElement("button");', source)
        self.assertIn("if (!pacing)", source)
        self.assertIn("value !== 5 * 60 * 60", source)
        self.assertIn("value !== 7 * 24 * 60 * 60", source)
        self.assertNotIn("if (pacing && remaining !== null)", source)

    def test_quota_refresh_preserves_focus_inside_the_panel(self) -> None:
        source = Path("codex_image/webui/frontend/src/codex-quota.ts").read_text(encoding="utf-8")

        self.assertIn("activeMarker", source)
        self.assertIn("dataset.quotaMarker", source)
        self.assertIn("replacement?.focus()", source)

    def test_quota_panel_exposes_accessible_marker_feedback(self) -> None:
        html = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")
        source = Path("codex_image/webui/frontend/src/codex-quota.ts").read_text(encoding="utf-8")

        self.assertIn('aria-modal="false"', html)
        self.assertIn('detail.setAttribute("role", "status")', source)
        self.assertIn('detail.setAttribute("aria-live", "polite")', source)
        self.assertIn('document.getElementById("codexQuotaPanelClose")?.focus()', source)

    def test_quota_translations_cover_all_locales(self) -> None:
        locale_files = (
            "zh-cn.ts",
            "zh-tw.ts",
            "zh-hk.ts",
            "ja.ts",
            "ko.ts",
            "en.ts",
            "vi.ts",
            "es.ts",
            "pt.ts",
            "fr.ts",
            "de.ts",
            "ru.ts",
            "it.ts",
            "hi.ts",
        )
        for filename in locale_files:
            source = Path(
                "codex_image/webui/frontend/src/i18n"
            ).joinpath(filename).read_text(encoding="utf-8")
            self.assertIn('"codexQuota.label":', source, filename)

    def test_quota_panel_is_anchored_to_the_clicked_control(self) -> None:
        source = Path("codex_image/webui/frontend/src/codex-quota.ts").read_text(encoding="utf-8")
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertIn("positionPromptPopoverAtAnchor", source)
        self.assertIn("root.getBoundingClientRect()", source)
        self.assertIn("--codex-quota-panel-origin-x", source)
        self.assertIn("position: fixed", styles[styles.index(".codex-quota-panel"):])
        self.assertIn("transform-origin: var(--codex-quota-panel-origin-x", styles)
        self.assertIn("@keyframes codex-quota-panel-open", styles)
        self.assertIn(
            "scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track)",
            styles,
        )
        self.assertIn(".codex-quota-panel::-webkit-scrollbar", styles)

        panel_source = source[
            source.index("function renderCodexQuotaPanel") : source.index("function renderUnavailable")
        ]
        self.assertIn("if (quotaPanelOpen && panel)", panel_source)

    def test_quota_styles_keep_the_mount_in_the_provider_row(self) -> None:
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertIn(".codex-quota", styles)
        self.assertIn("order: 1", styles[styles.index(".codex-quota"):])

    def test_quota_assets_bust_old_cache_and_show_loading_track(self) -> None:
        index = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")
        history = Path("codex_image/webui/static/history.html").read_text(encoding="utf-8")
        service_worker = Path("codex_image/webui/static/service-worker.js").read_text(encoding="utf-8")
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertIn("styles.css?v=runtime-783", index)
        self.assertIn("app.js?v=runtime-783", index)
        self.assertIn("styles.css?v=runtime-783", history)
        self.assertIn("styles.css?v=runtime-783", service_worker)
        self.assertIn("app.js?v=runtime-783", service_worker)
        self.assertIn(".codex-quota[data-state=\"loading\"] .codex-quota-track::before", styles)
        self.assertIn("flex: 0 0 140px", styles)

    def test_quota_fill_respects_reduced_motion(self) -> None:
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertRegex(
            styles,
            r"@media \(prefers-reduced-motion: reduce\)[\s\S]*\.codex-quota-fill[\s\S]*transition:\s*none",
        )

    def test_now_marker_stays_visible_over_the_current_checkpoint(self) -> None:
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")
        marker = styles[styles.index(".codex-quota-pacing-now {"):styles.index(".codex-quota-pacing-now::before")]
        marker_line = styles[styles.index(".codex-quota-pacing-now::before"):styles.index(".codex-quota-pacing-now:focus-visible")]

        self.assertIn("z-index: 4", marker)
        self.assertIn("background: var(--text);", marker_line)


if __name__ == "__main__":
    unittest.main()
