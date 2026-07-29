from __future__ import annotations

import re

TITLE_MARKERS = ("文案标题", "标题", "字体", "字形", "字效")
TITLE_STYLE_MARKERS = ("Q版", "卡通", "圆润", "可爱", "儿童", "泡泡", "手写", "贴纸")
COLOR_MARKERS = ("色彩", "颜色", "配色", "色调")
LIMIT_MARKERS = ("限制", "要求", "禁止", "不要", "不能", "不得", "必须", "只生成", "避免")

_PROMPT_GUARD_TEMPLATES = {
    "zh-CN": (
        "提示词保真规则：",
        "你只能扩写用户提示词，不得改变原意，不得删除、弱化或转移用户的硬性约束。",
        "如果硬性约束之间有冲突，优先保留用户明确指定的对象、文字、字体、颜色、构图和限制项。",
        "硬性约束：",
    ),
    "zh-TW": (
        "提示詞保真規則：",
        "你只能擴寫使用者提示詞，不得改變原意，也不得刪除、弱化或轉移硬性約束。",
        "如果硬性約束互相衝突，優先保留使用者明確指定的物件、文字、字體、顏色、構圖和限制項。",
        "硬性約束：",
    ),
    "zh-HK": (
        "提示詞保真規則：",
        "你只能擴寫使用者提示詞，不得改變原意，亦不得刪除、弱化或轉移硬性約束。",
        "如果硬性約束互相衝突，優先保留使用者明確指定的物件、文字、字體、顏色、構圖和限制項。",
        "硬性約束：",
    ),
    "en": (
        "Prompt fidelity guidance:",
        "You may expand the user's prompt, but do not change its meaning or remove, weaken, or redirect hard constraints.",
        "If hard constraints conflict, preserve explicitly specified subjects, text, typography, colors, composition, and restrictions.",
        "Hard constraints:",
    ),
    "ja": (
        "プロンプト忠実度ガイド：",
        "ユーザーのプロンプトを拡張しても、意味を変えたり、必須条件を削除・弱化・転換したりしないでください。",
        "必須条件が競合する場合は、明示された被写体、文字、書体、色、構図、制限を優先してください。",
        "必須条件：",
    ),
    "ko": (
        "프롬프트 충실도 지침:",
        "사용자 프롬프트를 확장할 수 있지만 의미를 바꾸거나 필수 조건을 삭제·약화·전환하지 마세요.",
        "필수 조건이 충돌하면 명시된 대상, 텍스트, 서체, 색상, 구도 및 제한을 우선하세요.",
        "필수 조건:",
    ),
    "es": (
        "Guía de fidelidad del prompt:",
        "Puedes ampliar el prompt del usuario, pero no cambies su significado ni elimines, debilites o desvíes restricciones obligatorias.",
        "Si hay restricciones en conflicto, conserva los sujetos, textos, tipografías, colores, composiciones y límites indicados expresamente.",
        "Restricciones obligatorias:",
    ),
    "pt": (
        "Orientação de fidelidade do prompt:",
        "Você pode ampliar o prompt do usuário, mas não altere o sentido nem remova, enfraqueça ou desvie restrições obrigatórias.",
        "Se houver conflito, preserve os objetos, textos, tipografia, cores, composição e limitações especificados explicitamente.",
        "Restrições obrigatórias:",
    ),
    "fr": (
        "Consignes de fidélité du prompt :",
        "Vous pouvez développer le prompt, sans en changer le sens ni supprimer, affaiblir ou détourner ses contraintes impératives.",
        "En cas de conflit, préservez les sujets, textes, typographies, couleurs, compositions et restrictions explicitement demandés.",
        "Contraintes impératives :",
    ),
    "de": (
        "Hinweise zur Prompt-Treue:",
        "Du darfst den Prompt erweitern, aber seine Bedeutung nicht ändern und verbindliche Vorgaben nicht entfernen, abschwächen oder umlenken.",
        "Bei Konflikten haben ausdrücklich genannte Motive, Texte, Schriften, Farben, Kompositionen und Einschränkungen Vorrang.",
        "Verbindliche Vorgaben:",
    ),
    "ru": (
        "Правила точного следования промпту:",
        "Можно расширять промпт пользователя, но нельзя менять его смысл, удалять, ослаблять или подменять обязательные ограничения.",
        "При конфликте сохраняйте явно заданные объекты, текст, шрифты, цвета, композицию и ограничения.",
        "Обязательные ограничения:",
    ),
    "it": (
        "Indicazioni di fedeltà al prompt:",
        "Puoi ampliare il prompt dell'utente, ma non cambiarne il significato né rimuovere, indebolire o deviare i vincoli obbligatori.",
        "In caso di conflitto, conserva soggetti, testi, caratteri, colori, composizione e limiti indicati esplicitamente.",
        "Vincoli obbligatori:",
    ),
    "hi": (
        "प्रॉम्प्ट निष्ठा निर्देश:",
        "आप उपयोगकर्ता के प्रॉम्प्ट का विस्तार कर सकते हैं, लेकिन उसका अर्थ न बदलें और अनिवार्य सीमाओं को हटाएँ, कमजोर या पुनर्निर्देशित न करें।",
        "सीमाओं में टकराव हो तो स्पष्ट रूप से बताए विषय, पाठ, फ़ॉन्ट, रंग, संरचना और प्रतिबंध सुरक्षित रखें।",
        "अनिवार्य सीमाएँ:",
    ),
    "vi": (
        "Hướng dẫn giữ sát prompt:",
        "Bạn có thể mở rộng prompt của người dùng, nhưng không được đổi nghĩa hay xóa, làm yếu hoặc chuyển hướng các ràng buộc bắt buộc.",
        "Nếu các ràng buộc xung đột, hãy giữ những chủ thể, chữ, kiểu chữ, màu sắc, bố cục và giới hạn được nêu rõ.",
        "Ràng buộc bắt buộc:",
    ),
}

_ORIGINAL_PROMPT_LABELS = {
    "zh-CN": "用户原始提示词：",
    "zh-TW": "使用者原始提示詞：",
    "zh-HK": "使用者原始提示詞：",
    "en": "Original user prompt:",
    "ja": "ユーザーの元のプロンプト：",
    "ko": "사용자의 원본 프롬프트:",
    "es": "Prompt original del usuario:",
    "pt": "Prompt original do usuário:",
    "fr": "Prompt original de l’utilisateur :",
    "de": "Ursprünglicher Benutzer-Prompt:",
    "ru": "Исходный промпт пользователя:",
    "it": "Prompt originale dell'utente:",
    "hi": "उपयोगकर्ता का मूल प्रॉम्प्ट:",
    "vi": "Prompt gốc của người dùng:",
}


def extract_prompt_constraints(prompt: str) -> list[str]:
    text = _clean_text(prompt)
    if not text:
        return []

    constraints: list[str] = []
    clauses = _prompt_clauses(text)

    for clause in clauses:
        if _is_title_font_constraint(clause):
            constraints.append(f"标题字体/标题设计：{clause}")

        audience = _target_audience(clause)
        if audience:
            constraints.append(f"目标人群：{audience}")

        color = _color_constraint(clause)
        if color:
            constraints.append(f"色彩：{color}")

    limit = _limit_constraint(text)
    if limit:
        constraints.append(limit)

    return _dedupe(constraints)


def build_prompt_guard_instructions(
    constraints: list[str],
    *,
    locale: str | None = None,
) -> str:
    clean_constraints = [item.strip() for item in constraints if item.strip()]
    heading, expansion_rule, conflict_rule, constraints_heading = (
        _PROMPT_GUARD_TEMPLATES[_normalize_prompt_guard_locale(locale)]
    )
    lines = [heading, expansion_rule, conflict_rule]
    if clean_constraints:
        lines.append(constraints_heading)
        lines.extend(f"- {item}" for item in clean_constraints)
    return "\n".join(lines)


def build_original_prompt_instructions() -> str:
    return "\n".join(
        [
            "原始提示词模式：",
            "不得优化、扩写、翻译、总结、重排或改写用户提示词。",
            "调用图像生成工具时，必须逐字使用用户原始提示词；不要自行添加风格、构图、受众、文字或限制条件。",
        ]
    )


def build_guarded_prompt(
    prompt: str,
    instructions: str,
    *,
    locale: str | None = None,
) -> str:
    clean_prompt = str(prompt or "").strip()
    clean_instructions = str(instructions or "").strip()
    if not clean_instructions:
        return clean_prompt
    normalized_locale = _normalize_prompt_guard_locale(locale)
    return (
        f"{clean_instructions}\n\n"
        f"{_ORIGINAL_PROMPT_LABELS[normalized_locale]}\n{clean_prompt}"
    )


def _normalize_prompt_guard_locale(value: str | None) -> str:
    language = str(value or "zh-CN").strip().lower()
    exact = next(
        (locale for locale in _PROMPT_GUARD_TEMPLATES if locale.lower() == language),
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
    for locale in ("en", "ja", "ko", "es", "pt", "fr", "de", "ru", "it", "hi", "vi"):
        if language.startswith(locale):
            return locale
    return "en"


def _clean_text(prompt: str) -> str:
    return re.sub(r"\s+", " ", str(prompt or "").replace("\r", "\n")).strip()


def _prompt_clauses(text: str) -> list[str]:
    parts = re.split(r"[，。；;、\n]+", text)
    return [part.strip(" ：:") for part in parts if part.strip(" ：:")]


def _is_title_font_constraint(clause: str) -> bool:
    return any(marker in clause for marker in TITLE_MARKERS) and any(marker in clause for marker in TITLE_STYLE_MARKERS)


def _target_audience(clause: str) -> str:
    match = re.search(r"(?:产品)?目标人群(?:是|为|:|：)?(.+)", clause)
    if not match:
        return ""
    return match.group(1).strip(" ：:")


def _color_constraint(clause: str) -> str:
    for marker in COLOR_MARKERS:
        if marker in clause:
            value = clause.split(marker, 1)[1].strip(" ：:")
            return value or clause
    return ""


def _limit_constraint(text: str) -> str:
    match = re.search(r"(限制|要求|禁止|避免)(?:：|:)(.+)", text)
    if match:
        value = match.group(2).strip()
        if value:
            return f"{match.group(1)}：{value}"
    negative_clauses = [clause for clause in _prompt_clauses(text) if any(clause.startswith(marker) for marker in LIMIT_MARKERS)]
    if negative_clauses:
        return "限制：" + "，".join(negative_clauses)
    return ""


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result
