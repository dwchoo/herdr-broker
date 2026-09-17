"""Typed Worker startup defaults and bounded, user-editable response templates."""
from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Literal

from .herdr import BrokerError

MODEL = "gpt-5.6-luna"
Effort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
Purpose = Literal["status", "analysis"]
ServiceTier = Literal["default", "fast"]
LengthMode = Literal["short", "medium", "long", "auto"]
FastMode = Literal["off", "analysis", "status", "all"]
TEMPLATE_BYTES = 8192


@dataclass(frozen=True)
class WorkerOptions:
    analysis_model: str = MODEL
    analysis_effort: Effort = "medium"
    status_model: str = MODEL
    status_effort: Effort = "low"
    response_length_mode: LengthMode = "medium"
    fast_mode: FastMode = "off"
    template_dir: Path | None = None

    def model(self, purpose: Purpose) -> str:
        return self.status_model if purpose == "status" else self.analysis_model

    def effort(self, purpose: Purpose) -> Effort:
        return self.status_effort if purpose == "status" else self.analysis_effort

    def tier(self, purpose: Purpose) -> ServiceTier:
        return "fast" if self.fast_mode in ("all", purpose) else "default"

    def description(self) -> str:
        return "Worker startup defaults: " + "; ".join(
            f"{purpose} model={self.model(purpose)}, effort={self.effort(purpose)}, tier={self.tier(purpose)}"
            for purpose in ("status", "analysis")
        ) + f"; analysis response_length_mode={self.response_length_mode}."


def load_templates(directory: Path | None) -> dict[str, str]:
    result = {}
    for purpose in ("analysis", "status"):
        source = directory / f"{purpose}.md" if directory else files("herdr_broker").joinpath(f"resources/{purpose}.md")
        try:
            with source.open("rb") as stream:
                data = stream.read(TEMPLATE_BYTES + 1)
            text = data.decode("utf-8")
            if len(data) > TEMPLATE_BYTES or not text.strip():
                raise ValueError()
        except (OSError, UnicodeError, ValueError):
            raise BrokerError("worker_template_invalid", f"{purpose}.md") from None
        result[purpose] = text.strip()
    return result


def export_templates(directory: Path) -> list[str]:
    templates = load_templates(None)
    paths = [directory / f"{purpose}.md" for purpose in templates]
    if any(path.exists() or path.is_symlink() for path in paths):
        raise BrokerError("template_already_exists")
    directory.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        for path, text in zip(paths, templates.values(), strict=True):
            with path.open("x", encoding="utf-8") as stream:
                created.append(path)
                stream.write(text + "\n")
    except OSError:
        for path in created:
            path.unlink()
        raise
    return [str(path) for path in paths]
