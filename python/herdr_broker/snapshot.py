from __future__ import annotations

import re

ANSI = re.compile(
    r"\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]"
)
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
TOKEN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b"
)
CREDENTIAL = re.compile(
    r"""["']?\b(?:[A-Z0-9_]*(?:password|passwd|secret|token|api[_-]?key)|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?:Bearer\s+)?[^\s,;]+)""",
    re.I,
)


def clean(text: str, patterns: list[str] | None = None) -> str:
    text = ANSI.sub(lambda m: "\n" * m[0].count("\n"), text)
    text = CONTROL.sub(lambda m: f"\\u{ord(m[0]):04x}", text)
    text = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
        "[REDACTED:key]",
        text,
    )
    text = TOKEN.sub("[REDACTED:token]", text)
    text = CREDENTIAL.sub("[REDACTED:credential]", text)
    for pattern in patterns or []:
        text = text.replace(pattern, "[REDACTED:custom]")
    return text


def bounded(text: str, limit: int) -> str:
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
