from __future__ import annotations

import re
from math import gcd
from typing import Any


_RATIO_RE = re.compile(r"^\s*([1-9]\d*(?:\.\d+)?)\s*:\s*([1-9]\d*(?:\.\d+)?)\s*$")
_SIZE_RE = re.compile(r"^\s*([1-9]\d*)\s*x\s*([1-9]\d*)\s*$", re.IGNORECASE)

_RATIO_INSTRUCTION_TEMPLATES = {
    "zh-CN": "将宽高比设为 {ratio}",
    "zh-TW": "將寬高比設為 {ratio}",
    "zh-HK": "將寬高比設為 {ratio}",
    "ja": "アスペクト比を {ratio} に設定してください。",
    "ko": "화면 비율을 {ratio}로 설정하세요.",
    "en": "Set the aspect ratio to {ratio}.",
    "es": "Establece la relación de aspecto en {ratio}.",
    "pt": "Defina a proporção da imagem como {ratio}.",
    "fr": "Réglez le rapport largeur/hauteur sur {ratio}.",
    "de": "Stelle das Seitenverhältnis auf {ratio} ein.",
    "ru": "Установите соотношение сторон {ratio}.",
    "it": "Imposta le proporzioni su {ratio}.",
    "hi": "पक्षानुपात को {ratio} पर सेट करें।",
    "vi": "Đặt tỷ lệ khung hình thành {ratio}.",
}


def _normalize_prompt_locale(value: Any) -> str:
    language = str(value or "zh-CN").strip().lower()
    exact = next(
        (locale for locale in _RATIO_INSTRUCTION_TEMPLATES if locale.lower() == language),
        None,
    )
    if exact:
        return exact
    if language.startswith(("zh-hk", "zh-mo")):
        return "zh-HK"
    if language.startswith(("zh-tw", "zh-hant")):
        return "zh-TW"
    if language.startswith(("zh-cn", "zh-sg", "zh-hans")) or language == "zh":
        return "zh-CN"
    for locale in ("ja", "ko", "en", "es", "pt", "fr", "de", "ru", "it", "hi", "vi"):
        if language.startswith(locale):
            return locale
    return "zh-CN"


def normalize_prompt_ratio(value: Any) -> str:
    match = _RATIO_RE.match(str(value or ""))
    if not match:
        return ""
    w = match.group(1)
    h = match.group(2)
    w_str = f"{float(w):g}" if "." in w else f"{int(w)}"
    h_str = f"{float(h):g}" if "." in h else f"{int(h)}"
    return f"{w_str}:{h_str}"


_STANDARD_RATIO_PRESETS: dict[tuple[int, int], str] = {
    (672, 1568): "9:21",
    (1568, 672): "21:9",
    (1152, 2688): "9:21",
    (2688, 1152): "21:9",
    (1632, 3808): "9:21",
    (3808, 1632): "21:9",
}


_STANDARD_RATIO_TARGETS: tuple[tuple[str, float], ...] = (
    ("1:1", 1.0),
    ("16:9", 16 / 9),
    ("9:16", 9 / 16),
    ("4:3", 4 / 3),
    ("3:4", 3 / 4),
    ("3:2", 3 / 2),
    ("2:3", 2 / 3),
    ("4:5", 4 / 5),
    ("5:4", 5 / 4),
    ("21:9", 21 / 9),
    ("9:21", 9 / 21),
    ("19.5:9", 19.5 / 9),
    ("9:19.5", 9 / 19.5),
)


def ratio_from_size(value: Any) -> str:
    match = _SIZE_RE.match(str(value or ""))
    if not match:
        return ""
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return ""
    preset = _STANDARD_RATIO_PRESETS.get((width, height))
    if preset:
        return preset
    ratio = width / height
    best_match: str | None = None
    min_relative_diff = 0.03
    for name, target_ratio in _STANDARD_RATIO_TARGETS:
        diff = abs(ratio - target_ratio) / target_ratio
        if diff < min_relative_diff:
            min_relative_diff = diff
            best_match = name
    if best_match:
        return best_match
    divisor = gcd(width, height)
    reduced_w = width // divisor
    reduced_h = height // divisor
    if reduced_w == 3 and reduced_h == 7:
        return "9:21"
    if reduced_w == 7 and reduced_h == 3:
        return "21:9"
    return f"{reduced_w}:{reduced_h}"


def orientation_from_ratio(value: Any) -> str:
    ratio = normalize_prompt_ratio(value)
    if not ratio:
        return ""
    width, height = (float(part) for part in ratio.split(":"))
    if width == height:
        return "square"
    return "landscape" if width > height else "portrait"


def ratio_prompt_instruction(value: Any, *, locale: Any = None) -> str:
    ratio = normalize_prompt_ratio(value)
    if not ratio:
        return ""
    template = _RATIO_INSTRUCTION_TEMPLATES[_normalize_prompt_locale(locale)]
    return template.format(ratio=ratio)


def append_ratio_prompt_instruction(prompt: str, ratio: Any, *, locale: Any = None) -> str:
    instruction = ratio_prompt_instruction(ratio, locale=locale)
    if not instruction:
        return prompt
    prompt_text = str(prompt or "").rstrip()
    if instruction in prompt_text:
        return prompt_text
    if not prompt_text:
        return instruction
    return f"{prompt_text}\n\n{instruction}"
