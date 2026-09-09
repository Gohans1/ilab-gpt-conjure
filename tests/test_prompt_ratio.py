from __future__ import annotations

import unittest

from codex_image.webui.prompt_ratio import (
    append_ratio_prompt_instruction,
    normalize_prompt_ratio,
    orientation_from_ratio,
    ratio_from_size,
    ratio_prompt_instruction,
)


class PromptRatioTests(unittest.TestCase):
    def test_ratio_from_size_standard_ratios(self) -> None:
        self.assertEqual(ratio_from_size("1024x1024"), "1:1")
        self.assertEqual(ratio_from_size("1536x864"), "16:9")
        self.assertEqual(ratio_from_size("864x1536"), "9:16")
        self.assertEqual(ratio_from_size("1536x1152"), "4:3")
        self.assertEqual(ratio_from_size("1152x1536"), "3:4")
        self.assertEqual(ratio_from_size("1536x1024"), "3:2")
        self.assertEqual(ratio_from_size("1024x1536"), "2:3")
        self.assertEqual(ratio_from_size("1024x1280"), "4:5")
        self.assertEqual(ratio_from_size("1280x1024"), "5:4")

    def test_ratio_from_size_9_21_and_21_9_preset_and_gcd(self) -> None:
        # Standard presets
        self.assertEqual(ratio_from_size("672x1568"), "9:21")
        self.assertEqual(ratio_from_size("1568x672"), "21:9")
        # 2K presets
        self.assertEqual(ratio_from_size("1152x2688"), "9:21")
        self.assertEqual(ratio_from_size("2688x1152"), "21:9")
        # 4K presets
        self.assertEqual(ratio_from_size("1632x3808"), "9:21")
        self.assertEqual(ratio_from_size("3808x1632"), "21:9")
        # Arbitrary dimensions that simplify to 3:7 via GCD
        self.assertEqual(ratio_from_size("300x700"), "9:21")
        self.assertEqual(ratio_from_size("700x300"), "21:9")
        # Modern mobile resolutions (e.g. 1080x2340 -> 9:19.5)
        self.assertEqual(ratio_from_size("1080x2340"), "9:19.5")
        self.assertEqual(ratio_from_size("2340x1080"), "19.5:9")

    def test_normalize_prompt_ratio(self) -> None:
        self.assertEqual(normalize_prompt_ratio("9:21"), "9:21")
        self.assertEqual(normalize_prompt_ratio(" 16 : 9 "), "16:9")
        self.assertEqual(normalize_prompt_ratio("9:19.5"), "9:19.5")
        self.assertEqual(normalize_prompt_ratio("19.5:9"), "19.5:9")
        self.assertEqual(normalize_prompt_ratio("1080:1920"), "1080:1920")
        self.assertEqual(normalize_prompt_ratio("1920:1080"), "1920:1080")
        self.assertEqual(normalize_prompt_ratio("none"), "")
        self.assertEqual(normalize_prompt_ratio(""), "")

    def test_orientation_from_ratio(self) -> None:
        self.assertEqual(orientation_from_ratio("1:1"), "square")
        self.assertEqual(orientation_from_ratio("9:21"), "portrait")
        self.assertEqual(orientation_from_ratio("21:9"), "landscape")
        self.assertEqual(orientation_from_ratio("16:9"), "landscape")
        self.assertEqual(orientation_from_ratio("9:16"), "portrait")
        self.assertEqual(orientation_from_ratio("9:19.5"), "portrait")
        self.assertEqual(orientation_from_ratio("19.5:9"), "landscape")

    def test_ratio_prompt_instruction(self) -> None:
        self.assertEqual(ratio_prompt_instruction("9:21", locale="en"), "Set the aspect ratio to 9:21.")
        self.assertEqual(ratio_prompt_instruction("9:21", locale="vi"), "Đặt tỷ lệ khung hình thành 9:21.")


if __name__ == "__main__":
    unittest.main()
