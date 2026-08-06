#!/usr/bin/env python3
"""Audit or fill missing String Catalog translations without touching existing work.

The app is not coupled to the translation service: this is a developer-only
maintenance tool. Run without --apply for a read-only completeness report.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


LOCALES = {
    "de": "de",
    "fr": "fr",
    "ja": "ja",
    "ko": "ko",
    "ru": "ru",
    "zh-Hans": "zh-CN",
    "zh-Hant": "zh-TW",
}

KEEP_TERMS = [
    "LeoPhoneAgent", "Token", "tokens", "token", "iOS", "iCloud", "CloudKit",
    "HomeKit", "HealthKit", "WeatherKit", "App Store", "App Group", "Keychain",
    "Siri", "OAuth", "PKCE", "API",
    "JSON", "HTTP", "HTTPS", "URL", "MCP", "CKAsset", "SHA-256", "NFC",
    "Bluetooth", "Wi-Fi", "Shell", "Rootfs",
]

COPY_AS_IS = {
    "Alibaba Bailian", "Doubao (Volcano)", "iFlytek (Xunfei)", "Xiaomi MiMo",
    "Kimi", "Kimi Code", "Azure OpenAI", "Alpine Linux", "JavaScript", "STDIO",
    "HTTP", "LB", "FB", "npx", "SKILL.md", "model-id", "github.com/user/repo/blob/main/SKILL.md",
}

# Product-language overrides for high-traffic controls where generic machine
# translation lacks the app context (for example, "Composer" is the chat input,
# not a musician). These are applied without replacing other existing work.
CURATED_OVERRIDES = {
    "de": {
        "%.1f Token/s": "%.1f Token/s",
        "%@ prepared": "%@ vorbereitet",
        "Composer Limit Reached": "Limit im Eingabebereich erreicht",
        "Composer Shortcuts": "Kurzbefehle im Eingabebereich",
        "Pin to Composer": "Im Eingabebereich anheften",
        "Pinned to Composer": "Im Eingabebereich angeheftet",
        "Remove from Composer": "Aus dem Eingabebereich entfernen",
    },
    "fr": {
        "%.1f Token/s": "%.1f Token/s",
        "%@ prepared": "%@ prêt",
        "Composer Limit Reached": "Limite de la zone de saisie atteinte",
        "Composer Shortcuts": "Raccourcis de saisie",
        "Pin to Composer": "Épingler dans la zone de saisie",
        "Pinned to Composer": "Épinglé dans la zone de saisie",
        "Remove from Composer": "Retirer de la zone de saisie",
    },
    "ja": {
        "%.1f Token/s": "%.1f Token/秒",
        "%@ prepared": "%@ を準備しました",
        "Composer Limit Reached": "入力欄の上限に達しました",
        "Composer Shortcuts": "入力ショートカット",
        "Pin to Composer": "入力欄に固定",
        "Pinned to Composer": "入力欄に固定済み",
        "Remove from Composer": "入力欄から削除",
    },
    "ko": {
        "%.1f Token/s": "초당 %.1f Token",
        "%@ prepared": "%@ 준비됨",
        "Composer Limit Reached": "입력 영역 한도에 도달함",
        "Composer Shortcuts": "입력 단축키",
        "Pin to Composer": "입력 영역에 고정",
        "Pinned to Composer": "입력 영역에 고정됨",
        "Remove from Composer": "입력 영역에서 제거",
    },
    "ru": {
        "%.1f Token/s": "%.1f Token/с",
        "%@ prepared": "%@ подготовлено",
        "Composer Limit Reached": "Достигнут лимит области ввода",
        "Composer Shortcuts": "Быстрые команды ввода",
        "Pin to Composer": "Закрепить в области ввода",
        "Pinned to Composer": "Закреплено в области ввода",
        "Remove from Composer": "Убрать из области ввода",
    },
    "zh-Hans": {
        "%.1f Token/s": "%.1f Token/秒",
        "%@ prepared": "%@ 已准备好",
        "AI Providers": "AI 服务商",
        "Agent Access": "智能体访问权限",
        "Apple Capabilities": "Apple 系统能力",
        "Artifact Files": "产出文件",
        "Artifacts": "任务产出",
        "Artifacts Unavailable": "暂无可用产出",
        "Choose Quick Actions": "选择快捷操作",
        "Composer Limit Reached": "输入区固定项已达上限",
        "Composer Shortcuts": "输入快捷操作",
        "Interaction": "交互",
        "Loading Artifacts": "正在加载任务产出",
        "Max Artifact Version Size": "产出版本大小上限",
        "Move to Trash": "移到最近删除",
        "New Quick Task": "新建快捷任务",
        "No Artifacts Yet": "暂无任务产出",
        "No pinned actions": "暂无固定操作",
        "Output Mode": "输出模式",
        "Personal Data": "个人数据",
        "Pin to Composer": "固定到输入区",
        "Pinned to Composer": "已固定到输入区",
        "Quick Task (Compatibility)": "快捷任务（兼容）",
        "Quick Tasks": "快捷任务",
        "Remove from Composer": "从输入区移除",
        "Result Format": "结果格式",
        "Send Background Ready": "后台就绪发送",
        "Send Standard": "普通发送",
        "Start with a Quick Task": "从快捷任务开始",
        "Trash": "最近删除",
        "Trash Is Empty": "最近删除为空",
        "Add Quick Task": "添加快捷任务",
        "Edit Quick Task": "编辑快捷任务",
        "Delete Quick Task?": "删除快捷任务？",
        "Pin up to three tasks above the chat input for one-tap prompt preparation.": "在聊天输入框上方最多固定三个任务，轻点即可填入提示词。",
        "Prepares this task in the message field": "将此任务填入消息输入框",
        "Remove %@ from Composer": "从输入区移除 %@",
        "Remove one of the three pinned actions before adding another.": "添加前请先移除三个固定操作中的一个。",
        "Reading the local artifact index.": "正在读取本地产出索引。",
        "Shows active artifacts": "显示可用的任务产出",
        "Shows deleted artifacts": "显示已删除的任务产出",
        "Tap an artifact for Quick Look. Swipe to share or move it to Trash.": "轻点产出文件即可快速查看；轻扫可分享或移到最近删除。",
        "The original workspace file remains unchanged when an artifact is deleted.": "删除产出文件不会影响工作区中的原始文件。",
        "This removes the artifact and every local version. This action cannot be undone.": "这会删除该产出文件及其全部本地版本，且无法撤销。",
        "Authenticated (manual token)": "已认证（手动 Token）",
        "Bearer token": "Bearer Token",
        "Bearer Token": "Bearer Token",
        "Change Token": "更换 Token",
        "Copy Token": "复制 Token",
        "Manual Bearer Token": "手动 Bearer Token",
        "Manual Token": "手动 Token",
        "Max Output Tokens": "最大输出 Token",
        "No usage data yet. Start a conversation to see token statistics here.": "暂无用量数据。开始对话后可在此查看 Token 统计。",
        "Output Tokens": "输出 Token",
        "Over limit: %lld / %lld tokens. Each CJK character and each Latin word counts as one.": "超过限制：%lld / %lld Token。每个中日韩字符和每个拉丁词均按一个计算。",
        "Reasoning: %lld tokens (encrypted)": "推理：%lld Token（已加密）",
        "Response truncated (max tokens reached)": "响应已截断（达到最大 Token 限制）",
        "Session Token Usage": "会话 Token 用量",
        "Set Manual Bearer Token": "设置手动 Bearer Token",
        "Token": "Token",
        "Token Usage": "Token 用量",
        "Tokens (Session Total)": "Token（会话总计）",
        "%lld / %lld tokens": "%lld / %lld Token",
    },
    "zh-Hant": {
        "%.1f Token/s": "%.1f Token/秒",
        "%@ prepared": "%@ 已準備好",
        "Composer Limit Reached": "輸入區固定項目已達上限",
        "Composer Shortcuts": "輸入快速操作",
        "Pin to Composer": "固定到輸入區",
        "Pinned to Composer": "已固定到輸入區",
        "Remove from Composer": "從輸入區移除",
    },
}

PLACEHOLDER_RE = re.compile(
    r"%(?:\d+\$)?(?:[-+0#]*\d*(?:\.\d+)?)?(?:lld|llu|ld|lu|d|u|f|s|@|%)"
    r"|\{\{[^{}]+\}\}"
    r"|https?://[^\s]+"
    r"|/var/minis/[^\s]*"
)


def protect(text: str) -> tuple[str, dict[str, str]]:
    replacements: dict[str, str] = {}

    def stash(value: str) -> str:
        # Keep placeholders as clearly technical ASCII identifiers. Translation
        # engines preserve these more reliably than private-use Unicode scalars.
        key = f"__LEOPH{len(replacements):03d}__"
        replacements[key] = "Token" if re.fullmatch(r"tokens?", value, re.I) else value
        return key

    protected = PLACEHOLDER_RE.sub(lambda match: stash(match.group(0)), text)
    protected = re.sub(r"\btokens?\b", lambda match: stash(match.group(0)), protected, flags=re.I)
    for term in sorted(KEEP_TERMS, key=len, reverse=True):
        if term.lower() in {"token", "tokens"}:
            continue
        protected = re.sub(
            rf"(?<![A-Za-z0-9]){re.escape(term)}(?![A-Za-z0-9])",
            lambda match: stash(match.group(0)),
            protected,
        )
    return protected, replacements


def restore(text: str, replacements: dict[str, str]) -> str:
    restored = text
    for key, value in replacements.items():
        restored = restored.replace(key, value)
    return restored


def should_copy_source(text: str) -> bool:
    stripped = text.strip()
    if not stripped or stripped in COPY_AS_IS or not re.search(r"[A-Za-z]", stripped):
        return True
    if re.fullmatch(r"[A-Z0-9_.+\-/ ]{1,16}", stripped):
        return True
    if re.fullmatch(r"v?\d+(?:\.\d+)*(?:\s*(?:MB|KB|K))?", stripped):
        return True
    return False


def translate_request(text: str, target: str) -> str:
    query = urllib.parse.urlencode({
        "client": "gtx",
        "sl": "en",
        "tl": target,
        "dt": "t",
        "q": text,
    })
    request = urllib.request.Request(
        f"https://translate.googleapis.com/translate_a/single?{query}",
        headers={"User-Agent": "LeoPhoneAgent-Localization-Audit/1.0"},
    )
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.load(response)
            return "".join(segment[0] for segment in payload[0] if segment[0])
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(0.5 * (2**attempt))
    raise RuntimeError(f"translation request failed for {target}: {text!r}: {last_error}")


def translate(text: str, target: str) -> str:
    if should_copy_source(text):
        return text
    protected, replacements = protect(text)
    translated = translate_request(protected, target)
    result = restore(translated, replacements)
    missing = [value for value in replacements.values() if value not in result]
    if not missing:
        return result

    # Rare fallback for engines that drop a sentinel: translate only the prose
    # between protected values, then reassemble every placeholder/term exactly.
    source_values = list(PLACEHOLDER_RE.findall(text))
    source_values += re.findall(r"\btokens?\b", text, flags=re.I)
    for term in KEEP_TERMS:
        source_values += re.findall(
            rf"(?<![A-Za-z0-9]){re.escape(term)}(?![A-Za-z0-9])",
            text,
        )
    protected_values = sorted(set(source_values), key=len, reverse=True)
    splitter = re.compile("(" + "|".join(map(re.escape, protected_values)) + ")")
    chunks = splitter.split(text)
    return "".join(
        ("Token" if re.fullmatch(r"tokens?", chunk, re.I) else chunk)
        if chunk in protected_values or not chunk.strip()
        else translate_request(chunk, target)
        for chunk in chunks
    )


def missing_jobs(strings: dict) -> list[tuple[str, str]]:
    jobs: list[tuple[str, str]] = []
    for source, entry in strings.items():
        localizations = entry.get("localizations", {})
        for locale in LOCALES:
            if locale not in localizations:
                jobs.append((source, locale))
    return jobs


def placeholder_signature(text: str) -> list[str]:
    return sorted(
        re.sub(r"^%(?:\d+\$)", "%", value)
        for value in PLACEHOLDER_RE.findall(text)
        if value.startswith("%") or value.startswith("{{")
    )


def audit(strings: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    placeholder_errors: list[tuple[str, str]] = []
    token_errors: list[tuple[str, str]] = []
    for source, entry in strings.items():
        expected = placeholder_signature(source)
        for locale in LOCALES:
            unit = entry.get("localizations", {}).get(locale, {}).get("stringUnit", {})
            value = unit.get("value")
            if value is None:
                continue
            if placeholder_signature(value) != expected:
                placeholder_errors.append((source, locale))
            if re.search(r"\btokens?\b", source, re.I) and "Token" not in value:
                token_errors.append((source, locale))
    return placeholder_errors, token_errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="src/ios/Localizable.xcstrings")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--refresh-token-terms",
        action="store_true",
        help="retranslate Token-related entries while preserving the word Token",
    )
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    path = Path(args.catalog)
    catalog = json.loads(path.read_text(encoding="utf-8"))
    strings = catalog["strings"]
    jobs = missing_jobs(strings)
    counts = {locale: 0 for locale in LOCALES}
    for _, locale in jobs:
        counts[locale] += 1
    print("missing: " + ", ".join(f"{locale}={counts[locale]}" for locale in LOCALES))
    if not args.apply:
        placeholder_errors, token_errors = audit(strings)
        print(f"placeholder mismatches: {len(placeholder_errors)}")
        print(f"Token preservation errors: {len(token_errors)}")
        if jobs or placeholder_errors or token_errors:
            raise SystemExit(1)
        return

    if args.refresh_token_terms:
        token_jobs = [
            (source, locale)
            for source in strings
            if re.search(r"\btokens?\b", source, re.I)
            for locale in LOCALES
        ]
        jobs = list(dict.fromkeys(jobs + token_jobs))

    def work(job: tuple[str, str]) -> tuple[str, str, str]:
        source, locale = job
        return source, locale, translate(source, LOCALES[locale])

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        for source, locale, value in executor.map(work, jobs):
            localizations = strings[source].setdefault("localizations", {})
            localizations[locale] = {
                "stringUnit": {
                    "state": "translated",
                    "value": value,
                }
            }
            completed += 1
            if completed % 100 == 0:
                print(f"translated {completed}/{len(jobs)}")

    curated = 0
    for locale, overrides in CURATED_OVERRIDES.items():
        for source, value in overrides.items():
            if source not in strings:
                continue
            strings[source].setdefault("localizations", {})[locale] = {
                "stringUnit": {"state": "translated", "value": value}
            }
            curated += 1

    path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"updated {completed} missing localizations and {curated} curated values")


if __name__ == "__main__":
    main()
