from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

from .context import Context
from .herdr import BrokerError, Pane
from .snapshot import bounded, clean
from .worker import Effort, Purpose, Worker

CODE = re.compile(r"^([1-9][0-9]{3})(?:\s*·\s*(.*))?$")


def pane_code(label: str | None) -> str | None:
    match = CODE.fullmatch(label or "")
    return match[1] if match else None


def now() -> str:
    return datetime.now(UTC).isoformat()


def compact_receipt(result: dict[str, Any]) -> dict[str, Any]:
    fields = {
        "request_id", "operation", "pane_id", "terminal_id", "submission", "completion",
        "error", "changed", "reason", "focused_pane_id", "target_pane_id", "closed_pane_id",
        "temporary_tab_id", "tab_id", "direction",
    }
    receipt = {key: value for key, value in result.items() if key in fields}
    if "native_error" in result:
        receipt["native_error"] = bounded(str(result["native_error"]), 256)
    if "steps" in result:
        receipt["steps"] = list(result["steps"])
    identity_fields = {"pane_id", "terminal_id", "workspace_id", "tab_id"}
    if "pane" in result:
        receipt["pane"] = {key: value for key, value in result["pane"].items() if key in identity_fields}
    if "participants" in result:
        receipt["participants"] = [
            {key: value for key, value in pane.items() if key in identity_fields}
            for pane in result["participants"]
        ]
    return {**receipt, "details_retained": False}


class Broker:
    def __init__(self, context: Context, worker: Worker):
        self.context = context
        self.herdr = context.herdr
        self.worker = worker
        self.submissions: dict[str, dict[str, Any]] = {}

    async def target(self, pane_id: str, terminal_id: str) -> Pane:
        pane = await self.herdr.pane(pane_id)
        if pane.terminal_id != terminal_id:
            raise BrokerError("target_changed")
        return pane

    def describe(self, pane: Pane) -> dict[str, Any]:
        result = pane.model_dump()
        for key, value in result.items():
            if isinstance(value, str) and key not in {"pane_id", "terminal_id", "workspace_id", "tab_id"}:
                result[key] = bounded(clean(value, self.context.patterns), 1024)
        result.update(
            pane_code=pane_code(pane.label),
            name=result.get("label") or result.get("terminal_title_stripped"),
            role="caller" if pane.pane_id == self.context.caller else "agent" if pane.agent else "terminal",
            can_operate=True,
            state="present",
        )
        return result

    async def workspace_list(self) -> dict[str, Any]:
        return {
            "workspaces": [
                dict(w.model_dump(), label=bounded(clean(w.label, self.context.patterns), 1024))
                for w in await self.herdr.workspaces()
            ],
            "caller_pane_id": self.context.caller,
            "default_workspace_id": self.context.workspace,
            "connection": "herdr" if self.context.caller else "local",
            "checked_at": now(),
        }

    async def workspace(self, requested: str | None) -> str:
        selected = requested or self.context.workspace
        if selected is None:
            raise BrokerError("workspace_required")
        if requested and selected not in {w.workspace_id for w in await self.herdr.workspaces()}:
            raise BrokerError("workspace_not_found")
        return selected

    async def tab_list(self, workspace_id: str | None = None) -> dict[str, Any]:
        workspace = await self.workspace(workspace_id)
        tabs = await self.herdr.tabs(workspace)
        return {
            "workspace_id": workspace,
            "tabs": [
                dict(t.model_dump(), label=bounded(clean(t.label, self.context.patterns), 1024)) for t in tabs
            ],
            "checked_at": now(),
        }

    async def pane_list(
        self, tab_id: str | None, offset: int, workspace_id: str | None = None
    ) -> dict[str, Any]:
        workspace = await self.workspace(workspace_id)
        panes = await self.herdr.panes(workspace)
        if tab_id:
            if tab_id not in {t.tab_id for t in await self.herdr.tabs(workspace)}:
                raise BrokerError("tab_not_found")
            panes = [p for p in panes if p.tab_id == tab_id]

        async def row(pane: Pane) -> dict[str, Any]:
            result = self.describe(pane)
            try:
                info = await self.herdr.process_info(pane.pane_id)
                result["processes"] = [
                    bounded(clean(str(p.get("name", "")), self.context.patterns), 256)
                    for p in info.get("foreground_processes", [])[:8]
                ]
                result["process_status"] = "checked"
            except BrokerError as exc:
                result.update(processes=None, process_status="unavailable", process_error=exc.code)
            return result

        rows = await asyncio.gather(*(row(p) for p in panes[offset : offset + 32]))
        next_offset = offset + len(rows)
        return {
            "workspace_id": workspace,
            "panes": rows,
            "checked_at": now(),
            "total": len(panes),
            "truncated": next_offset < len(panes),
            "next_offset": next_offset if next_offset < len(panes) else None,
        }

    async def capture(
        self, pane_id: str, terminal_id: str, max_lines: int = 1000
    ) -> tuple[str, dict[str, Any]]:
        pane = await self.target(pane_id, terminal_id)
        result = await self.herdr.request(
            "pane.read",
            {
                "pane_id": pane_id,
                "source": "recent_unwrapped",
                "lines": max_lines,
                "format": "ansi",
                "strip_ansi": True,
            },
        )
        capture = result.get("read")
        if (
            result.get("type") != "pane_read"
            or not isinstance(capture, dict)
            or any(capture.get(k) != getattr(pane, k) for k in ("pane_id", "workspace_id", "tab_id"))
            or not isinstance(capture.get("text"), str)
            or capture.get("source") != "recent_unwrapped"
            or capture.get("format") != "ansi"
            or type(capture.get("revision")) is not int
            or capture["revision"] < 0
            or not isinstance(capture.get("truncated"), bool)
        ):
            raise BrokerError("herdr_invalid_response")
        await self.target(pane_id, terminal_id)
        text = clean(capture["text"], self.context.patterns)
        recent = "\n".join(text.split("\n")[-max_lines:])
        cropped = recent.encode()[-65536:].decode(errors="ignore")
        metadata = {
            "pane_id": pane_id,
            "terminal_id": terminal_id,
            "captured_at": now(),
            "revision": capture.get("revision"),
            "truncated": bool(capture.get("truncated")) or cropped != text,
            "history_complete": False,
            "max_lines": max_lines,
            "captured_lines": len(cropped.split("\n")),
            "captured_bytes": len(cropped.encode()),
        }
        return cropped, metadata

    async def pane_read(
        self, pane_id: str, terminal_id: str, objective: str, raw: bool, offset: int,
        effort: Effort | None = None, max_lines: int | None = None,
        purpose: Purpose = "analysis", analysis_id: str | None = None,
    ) -> dict[str, Any]:
        started = perf_counter()
        lines = max_lines if max_lines is not None else (1000 if raw else 80)
        if raw:
            cropped, metadata = await self.capture(pane_id, terminal_id, lines)
            excerpt = bounded(cropped[offset:], 8192)
            next_offset = offset + len(excerpt)
            return {
                **metadata,
                "kind": "raw",
                "text": excerpt,
                "next_offset": next_offset if next_offset < len(cropped) else None,
                "truncated": metadata["truncated"] or next_offset < len(cropped),
            }
        if offset:
            raise BrokerError("offset_requires_raw")
        metadata = {}

        async def capture() -> str:
            text, observed = await self.capture(pane_id, terminal_id, lines)
            metadata.update(observed)
            return text

        pane = await self.target(pane_id, terminal_id)
        report = await self.worker.analyze(
            capture, objective, self.context.patterns, effort=effort, purpose=purpose,
            identity=(pane.workspace_id, pane_id, terminal_id), analysis_id=analysis_id,
        )
        check_started = perf_counter()
        try:
            await self.target(pane_id, terminal_id)
        except BrokerError:
            await self.worker.release(report["analysis_id"])
            raise
        timings = report.setdefault("timings_ms", {})
        timings["final_identity_check"] = round((perf_counter() - check_started) * 1000, 3)
        timings["total"] = round((perf_counter() - started) * 1000, 3)
        return {**metadata, "kind": "analysis", **report}

    async def pane_send(
        self, pane_id: str, terminal_id: str, request_id: str, text: str, keys: list[str]
    ) -> dict[str, Any]:
        return await self.submit_input("pane_send", pane_id, terminal_id, request_id, text, keys)

    async def pane_execute(
        self, pane_id: str, terminal_id: str, request_id: str, command: str
    ) -> dict[str, Any]:
        if not command.strip():
            raise BrokerError("empty_command")
        return await self.submit_input("pane_execute", pane_id, terminal_id, request_id, command, ["Enter"])

    async def submit_input(
        self, operation: str, pane_id: str, terminal_id: str, request_id: str, text: str, keys: list[str]
    ) -> dict[str, Any]:
        payload = {"pane_id": pane_id, "terminal_id": terminal_id, "text": text, "keys": keys}
        if not text and not keys:
            raise BrokerError("empty_input")
        if len(text.encode()) > 65536:
            raise BrokerError("input_too_large")

        async def send(writing: Callable[[], None], state: dict[str, Any]) -> dict[str, Any]:
            await self.target(pane_id, terminal_id)
            response = await self.herdr.request(
                "pane.send_input", {"pane_id": pane_id, "text": text, "keys": keys}, writing
            )
            if response.get("type") != "ok":
                raise BrokerError("herdr_invalid_response")
            return {}

        return await self.mutate(operation, request_id, payload, send)

    async def mutate(
        self,
        operation: str,
        request_id: str,
        payload: dict[str, Any],
        action: Callable[[Callable[[], None], dict[str, Any]], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        digest = hashlib.sha256(
            json.dumps([operation, payload], ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        if request_id in self.submissions:
            record = self.submissions[request_id]
            if record["digest"] != digest:
                raise BrokerError("request_payload_changed")
            return dict(compact_receipt(record["result"]), duplicate=True)
        if len(self.submissions) >= 10000:
            raise BrokerError("request_capacity_reached")
        result = {
            "request_id": request_id,
            "operation": operation,
            "pane_id": payload["pane_id"],
            "terminal_id": payload["terminal_id"],
            "submission": "pending",
            "completion": "not_observed",
        }
        self.submissions[request_id] = {"digest": digest, "result": result}
        written = False

        def writing() -> None:
            nonlocal written
            written = True

        try:
            result.update(await action(writing, result))
            result["submission"] = "accepted"
        except asyncio.CancelledError:
            result["submission"] = "unknown" if written else "not_sent"
            result["error"] = "cancelled"
            raise
        except BrokerError as exc:
            rejected = exc.native_code in {
                "invalid_key",
                "pane_not_found",
                "pane_send_failed",
                "target_pane_not_found",
                "tab_not_found",
                "invalid_pane_swap",
                "confirmation_required",
            }
            acknowledged = bool(result.get("steps"))
            result["submission"] = (
                "not_sent"
                if not written
                else "partial"
                if acknowledged and (rejected or not exc.code.startswith("herdr_"))
                else "rejected"
                if rejected
                else "unknown"
            )
            result["error"] = exc.code
            if exc.native_code:
                result["native_error"] = exc.native_code
        finally:
            self.submissions[request_id]["result"] = compact_receipt(result)
        return dict(result)

    async def pane_rename(self, pane_id: str, terminal_id: str, name: str, numbered: bool) -> dict[str, Any]:
        pane = await self.target(pane_id, terminal_id)
        if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
            raise BrokerError("invalid_name")
        label = name.strip()
        if numbered:
            code = pane_code(pane.label)
            if not code:
                used = {pane_code(p.label) for p in await self.herdr.panes(pane.workspace_id)}
                code = next((str(n) for n in range(1000, 10000) if str(n) not in used), None)
            if not code:
                raise BrokerError("address_space_exhausted")
            prior = CODE.fullmatch(pane.label or "")
            label = label or (prior[2] if prior else pane.label) or ""
            label = f"{code} · {label}" if label else code
        await self.target(pane_id, terminal_id)
        await self.herdr.request("pane.rename", {"pane_id": pane_id, "label": label or None})
        return self.describe(await self.target(pane_id, terminal_id))

    async def tab_rename(self, tab_id: str, name: str, workspace_id: str | None = None) -> dict[str, Any]:
        if not name.strip() or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
            raise BrokerError("invalid_name")
        workspace = await self.workspace(workspace_id)
        if tab_id not in {t.tab_id for t in await self.herdr.tabs(workspace)}:
            raise BrokerError("tab_not_found")
        await self.herdr.request("tab.rename", {"tab_id": tab_id, "label": name.strip()})
        return await self.tab_list(workspace)
