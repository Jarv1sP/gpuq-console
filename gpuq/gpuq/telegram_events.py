"""Read-only gpuq event notifications with a durable delivery outbox.

This module is deliberately independent from the Telegram HTTP client.  It
reads the daemon's SQLite event log without acquiring write capabilities and
turns a validated event batch into durable, per-chat deliveries.  Callers own
the JSON file containing :class:`DurableEventState` and inject its atomic
``persist`` callback.

The delivery contract is at-least-once: advancing the event cursor and adding
all chat deliveries is persisted before the first network send.  A successful
send is then removed and persisted individually.  A crash in between those
two operations can repeat one message, but cannot lose it.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import stat
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Config
from .constants import MAX_PRIORITY, MIN_PRIORITY, STORE_SCHEMA_VERSION, JobState
from .store import APPLICATION_ID


EVENT_STATE_VERSION = 3
LEGACY_EVENT_STATE_VERSION = 2
# Schema 7 can be initialized transactionally from production schemas 4/5/6.
# These migrations preserve the events table and
# schema_meta.initialized_at, so a durable sidecar cursor may follow either
# identity after the continuity checks below.  Future Store versions fall back
# to accepting only their immediately preceding version until another skipped
# upgrade path is explicitly audited.
SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS = (
    frozenset({4, 5, 6, 7, 8})
    if STORE_SCHEMA_VERSION == 9
    else frozenset({STORE_SCHEMA_VERSION - 1})
)
# Compatibility exports for local tooling which imported the earlier scalar
# names.  New code must use SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS.
PREVIOUS_EVENT_SOURCE_SCHEMA_VERSION = STORE_SCHEMA_VERSION - 1
LEGACY_EVENT_SOURCE_SCHEMA_VERSION = PREVIOUS_EVENT_SOURCE_SCHEMA_VERSION
DEFAULT_EVENT_BATCH_LIMIT = 1000
MAX_EVENT_BATCH_LIMIT = 10_000
MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024
MAX_NOTIFICATION_CHARS = 3500
MAX_PENDING_DELIVERIES = 10_000
MAX_PENDING_TEXT_BYTES = 8 * 1024 * 1024
MAX_PENDING_ROUTE_BYTES = 2 * 1024 * 1024
MAX_DEAD_LETTERS = 100
DEFAULT_DRAIN_DELIVERIES = 3

_SQLITE_SIGNED_INT_MAX = 2**63 - 1
_FILESYSTEM_INT_MAX = 2**64 - 1
_EVENT_TYPE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,255}$")
_PROGRESS_PHASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,63}$")
_DELIVERY_ID_RE = re.compile(
    r"^events:[1-9][0-9]{0,18}-[1-9][0-9]{0,18}:chat:-?[1-9][0-9]{0,18}:chunk:[0-9]{1,5}$"
)
_JOB_STATES = frozenset(item.value for item in JobState)
_NOTIFICATION_EVENT_TYPES = frozenset(
    {
        "ATTEMPT_BOOT_LOST",
        "ATTEMPT_FINISHED",
        "DAEMON_MODE_CHANGED",
        "JOB_CANCELED",
        "JOB_RETRIED",
        "JOB_SUBMITTED",
        "PREEMPT_REQUESTED",
        "PREEMPT_TIMEOUT",
        "PREEMPT_WITHDRAWN",
        "PROGRESS_MILESTONE",
        "PROGRESS_RECOVERED",
        "PROGRESS_REPORTED_PROBLEM",
        "PROGRESS_STALLED",
        "SCALE_UP_CHECKPOINTED",
        "SCALE_UP_COMPLETED",
        "SCALE_UP_FAILED",
        "SCALE_UP_REQUESTED",
        "SCALE_UP_RESTART_PLANNED",
        "SCALE_UP_WITHDRAWN",
        "START_ABORTED",
        "START_PLANNED",
        "START_REJECTED",
        "UNIT_STARTED",
    }
)


class EventReaderError(RuntimeError):
    """The read-only event source is unavailable or invalid."""


class EventSourceChangedError(EventReaderError):
    """The database identity changed after the reader/state was initialized."""


class EventSchemaError(EventReaderError):
    """The database identity or required gpuq schema is no longer valid."""


class EventCursorRollbackError(EventReaderError):
    """The durable cursor is ahead of the database event log."""


class EventDataError(EventReaderError):
    """A persisted event or joined job contains invalid data."""


class EventStateError(RuntimeError):
    """Durable event-notification state is invalid or incompatible."""


class OutboxFullError(EventStateError):
    """Enqueuing the batch would exceed a durable outbox bound."""


def _plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _bounded_int(value: Any, field_name: str, *, minimum: int, maximum: int) -> int:
    if not _plain_int(value) or not minimum <= value <= maximum:
        raise EventStateError(
            f"{field_name} must be an integer from {minimum} to {maximum}"
        )
    return int(value)


def _strict_json_loads(raw: Any) -> Any:
    if not isinstance(raw, str):
        raise EventDataError("event payload_json must be SQLite TEXT")

    def reject_constant(_value: str) -> None:
        raise ValueError("non-finite JSON number")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    try:
        if len(raw.encode("utf-8", errors="strict")) > MAX_EVENT_PAYLOAD_BYTES:
            raise EventDataError("event payload_json exceeds the size limit")
        result = json.loads(
            raw,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
        _validate_json_tree(result)
        return result
    except EventDataError:
        raise
    except (UnicodeError, ValueError, RecursionError, json.JSONDecodeError):
        raise EventDataError("event payload_json is not strict JSON") from None


def _validate_json_tree(value: Any) -> None:
    """Reject unpaired surrogates and unreasonably large decoded trees."""

    remaining = 10_000
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        remaining -= 1
        if remaining < 0 or depth > 64:
            raise ValueError("JSON structure is too large")
        if item is None or isinstance(item, (bool, int)):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("non-finite JSON number")
            continue
        if isinstance(item, str):
            item.encode("utf-8", errors="strict")
            continue
        if isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
            continue
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise ValueError("non-string JSON object key")
                key.encode("utf-8", errors="strict")
                stack.append((child, depth + 1))
            continue
        raise ValueError("invalid decoded JSON value")


@dataclass(frozen=True)
class EventSourceIdentity:
    device: int
    inode: int
    initialized_at: float = 0.0
    schema_version: int = STORE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if (
            not _plain_int(self.device)
            or not 0 <= self.device <= _FILESYSTEM_INT_MAX
            or not _plain_int(self.inode)
            or not 1 <= self.inode <= _FILESYSTEM_INT_MAX
            or isinstance(self.initialized_at, bool)
            or not isinstance(self.initialized_at, (int, float))
            or not math.isfinite(float(self.initialized_at))
            or not _plain_int(self.schema_version)
            or self.schema_version != STORE_SCHEMA_VERSION
        ):
            raise ValueError("invalid event source identity")

    def to_dict(self) -> dict[str, int | float]:
        return {
            "device": self.device,
            "inode": self.inode,
            "initialized_at": float(self.initialized_at),
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "EventSourceIdentity":
        if not isinstance(raw, dict) or set(raw) != {
            "device",
            "inode",
            "initialized_at",
            "schema_version",
        }:
            raise EventStateError("event source identity fields do not match schema")
        try:
            return cls(
                device=raw["device"],
                inode=raw["inode"],
                initialized_at=raw["initialized_at"],
                schema_version=raw["schema_version"],
            )
        except ValueError as exc:
            raise EventStateError(str(exc)) from None


@dataclass(frozen=True)
class EventRecord:
    id: int
    event_type: str
    job_id: str | None
    attempt_id: str | None
    payload: Any
    created_at: float
    job_name: str | None
    job_owner: str | None
    job_priority: int | None
    job_state: str | None


@dataclass(frozen=True)
class EventPosition:
    source: EventSourceIdentity
    max_event_id: int


@dataclass(frozen=True)
class EventBatch:
    source: EventSourceIdentity
    max_event_id: int
    events: tuple[EventRecord, ...]


class EventReader:
    """Validated, WAL-aware, read-only view of the gpuq event table."""

    _EVENT_COLUMNS = frozenset(
        {"id", "job_id", "attempt_id", "event_type", "payload_json", "created_at"}
    )
    _JOB_COLUMNS = frozenset({"id", "name", "owner", "priority", "state"})

    def __init__(self, config: Config, *, busy_timeout_ms: int = 5000) -> None:
        if not _plain_int(busy_timeout_ms) or not 0 <= busy_timeout_ms <= 60_000:
            raise ValueError("busy_timeout_ms must be an integer from 0 to 60000")
        self.path = Path(config.db_path)
        self.allowed_uid = config.allowed_uid
        if not _plain_int(self.allowed_uid) or self.allowed_uid < 1:
            raise ValueError("allowed_uid must be a non-root integer uid")
        if os.geteuid() != self.allowed_uid:
            raise EventReaderError("event reader must run as the gpuq configured uid")
        before = self._stat_main_file()
        connection: sqlite3.Connection | None = None
        try:
            uri = f"{self.path.absolute().as_uri()}?mode=ro"
            connection = sqlite3.connect(
                uri,
                uri=True,
                timeout=busy_timeout_ms / 1000,
                isolation_level=None,
                check_same_thread=False,
            )
            connection.row_factory = sqlite3.Row
            connection.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            query_only = connection.execute("PRAGMA query_only").fetchone()
            if query_only is None or int(query_only[0]) != 1:
                raise EventReaderError("SQLite query_only mode could not be enabled")
            self._connection = connection
            self._lock = threading.RLock()
            self._file_identity = self._file_identity_from_stat(before)
            self._validate_path_identity()
            initialized_at = self._validate_schema(expected_initialized_at=None)
            self._identity = EventSourceIdentity(
                device=self._file_identity[0],
                inode=self._file_identity[1],
                initialized_at=initialized_at,
            )
        except BaseException:
            if connection is not None:
                connection.close()
            raise

    def _stat_main_file(self) -> os.stat_result:
        try:
            info = self.path.lstat()
        except OSError as exc:
            raise EventReaderError(
                f"cannot inspect gpuq database: {self.path}"
            ) from exc
        if not stat.S_ISREG(info.st_mode):
            raise EventReaderError(
                f"gpuq database must be a non-symlink regular file: {self.path}"
            )
        if info.st_uid != self.allowed_uid:
            raise EventReaderError(
                f"gpuq database is not owned by configured uid {self.allowed_uid}"
            )
        return info

    @staticmethod
    def _file_identity_from_stat(info: os.stat_result) -> tuple[int, int]:
        device = int(info.st_dev)
        inode = int(info.st_ino)
        if (
            not 0 <= device <= _FILESYSTEM_INT_MAX
            or not 1 <= inode <= _FILESYSTEM_INT_MAX
        ):
            raise EventReaderError("gpuq database has an invalid file identity")
        return device, inode

    def _validate_path_identity(self) -> None:
        current = self._file_identity_from_stat(self._stat_main_file())
        if current != self._file_identity:
            raise EventSourceChangedError(
                "gpuq database file identity changed; manual reinitialization required"
            )

    def _validate_schema(self, *, expected_initialized_at: float | None) -> float:
        try:
            app_id = int(
                self._connection.execute("PRAGMA application_id").fetchone()[0]
            )
            user_version = int(
                self._connection.execute("PRAGMA user_version").fetchone()[0]
            )
            if app_id != APPLICATION_ID:
                raise EventSchemaError("wrong gpuq SQLite application_id")
            if user_version != STORE_SCHEMA_VERSION:
                raise EventSchemaError(
                    "gpuq SQLite schema version changed; manual reinitialization required"
                )
            rows = self._connection.execute(
                """
                SELECT singleton, schema_version, initialized_at
                FROM main.schema_meta
                """
            ).fetchall()
            if (
                len(rows) != 1
                or int(rows[0][0]) != 1
                or int(rows[0][1]) != user_version
            ):
                raise EventSchemaError("gpuq schema_meta does not match user_version")
            initialized_at = rows[0][2]
            if (
                isinstance(initialized_at, bool)
                or not isinstance(initialized_at, (int, float))
                or not math.isfinite(float(initialized_at))
            ):
                raise EventSchemaError("gpuq schema_meta initialized_at is invalid")
            normalized_initialized_at = float(initialized_at)
            if (
                expected_initialized_at is not None
                and normalized_initialized_at != expected_initialized_at
            ):
                raise EventSchemaError(
                    "gpuq database initialization identity changed; "
                    "manual reinitialization required"
                )
            table_types = {
                str(row[0]): str(row[1])
                for row in self._connection.execute(
                    """
                    SELECT name, type FROM main.sqlite_master
                    WHERE name IN ('events', 'jobs')
                    """
                ).fetchall()
            }
            if table_types != {"events": "table", "jobs": "table"}:
                raise EventSchemaError(
                    "gpuq event source tables are missing or invalid"
                )
            event_columns = {
                str(row[1])
                for row in self._connection.execute(
                    "PRAGMA main.table_info('events')"
                ).fetchall()
            }
            job_columns = {
                str(row[1])
                for row in self._connection.execute(
                    "PRAGMA main.table_info('jobs')"
                ).fetchall()
            }
            if not self._EVENT_COLUMNS.issubset(
                event_columns
            ) or not self._JOB_COLUMNS.issubset(job_columns):
                raise EventSchemaError("gpuq event source columns do not match schema")
            query_only = self._connection.execute("PRAGMA query_only").fetchone()
            if query_only is None or int(query_only[0]) != 1:
                raise EventReaderError("SQLite query_only mode was disabled")
            return normalized_initialized_at
        except sqlite3.DatabaseError as exc:
            raise EventReaderError("cannot validate gpuq event database") from exc

    @property
    def source_identity(self) -> EventSourceIdentity:
        return self._identity

    @property
    def query_only(self) -> bool:
        with self._lock:
            row = self._connection.execute("PRAGMA query_only").fetchone()
            return row is not None and int(row[0]) == 1

    def _begin_snapshot(self) -> None:
        self._validate_path_identity()
        self._connection.execute("BEGIN")
        try:
            self._validate_schema(expected_initialized_at=self._identity.initialized_at)
            self._validate_path_identity()
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise

    def position(self) -> EventPosition:
        with self._lock:
            try:
                self._begin_snapshot()
                row = self._connection.execute(
                    "SELECT COALESCE(MAX(id), 0) FROM main.events"
                ).fetchone()
                maximum = int(row[0])
                if not 0 <= maximum <= _SQLITE_SIGNED_INT_MAX:
                    raise EventDataError("event log maximum id is invalid")
                self._connection.execute("COMMIT")
                self._validate_path_identity()
                return EventPosition(self._identity, maximum)
            except sqlite3.DatabaseError as exc:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise EventReaderError("cannot read gpuq event position") from exc
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise

    def read_after(
        self,
        after_id: int,
        *,
        limit: int = DEFAULT_EVENT_BATCH_LIMIT,
    ) -> EventBatch:
        if not _plain_int(after_id) or not 0 <= after_id <= _SQLITE_SIGNED_INT_MAX:
            raise ValueError("after_id must be a non-negative SQLite integer")
        if not _plain_int(limit) or not 1 <= limit <= MAX_EVENT_BATCH_LIMIT:
            raise ValueError(f"limit must be between 1 and {MAX_EVENT_BATCH_LIMIT}")
        with self._lock:
            try:
                self._begin_snapshot()
                max_row = self._connection.execute(
                    "SELECT COALESCE(MAX(id), 0) FROM main.events"
                ).fetchone()
                maximum = int(max_row[0])
                if maximum < after_id:
                    raise EventCursorRollbackError(
                        "gpuq event id moved behind the durable cursor"
                    )
                rows = self._connection.execute(
                    """
                    SELECT
                        e.id AS event_id,
                        e.job_id AS event_job_id,
                        e.attempt_id AS attempt_id,
                        e.event_type AS event_type,
                        e.payload_json AS payload_json,
                        e.created_at AS created_at,
                        j.id AS joined_job_id,
                        j.name AS job_name,
                        j.owner AS job_owner,
                        j.priority AS job_priority,
                        j.state AS job_state
                    FROM main.events AS e
                    LEFT JOIN main.jobs AS j ON j.id = e.job_id
                    WHERE e.id > ?
                    ORDER BY e.id
                    LIMIT ?
                    """,
                    (after_id, limit),
                ).fetchall()
                events = tuple(self._decode_row(row) for row in rows)
                self._connection.execute("COMMIT")
                self._validate_path_identity()
                return EventBatch(self._identity, maximum, events)
            except sqlite3.DatabaseError as exc:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise EventReaderError("cannot read gpuq events") from exc
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise

    @staticmethod
    def _decode_row(row: sqlite3.Row) -> EventRecord:
        event_id = row["event_id"]
        if not _plain_int(event_id) or not 1 <= event_id <= _SQLITE_SIGNED_INT_MAX:
            raise EventDataError("event id is invalid")
        event_type = row["event_type"]
        if not isinstance(event_type, str) or not _EVENT_TYPE_RE.fullmatch(event_type):
            raise EventDataError("event type is invalid")
        job_id = row["event_job_id"]
        joined_job_id = row["joined_job_id"]
        if job_id is not None and (
            not isinstance(job_id, str)
            or not job_id
            or len(job_id) > 256
            or "\x00" in job_id
        ):
            raise EventDataError("event job id is invalid")
        if job_id is not None and joined_job_id != job_id:
            raise EventDataError("event references a missing or mismatched job")
        attempt_id = row["attempt_id"]
        if attempt_id is not None and (
            not isinstance(attempt_id, str)
            or not attempt_id
            or len(attempt_id) > 256
            or "\x00" in attempt_id
        ):
            raise EventDataError("event attempt id is invalid")
        created_at = row["created_at"]
        if (
            isinstance(created_at, bool)
            or not isinstance(created_at, (int, float))
            or not math.isfinite(float(created_at))
        ):
            raise EventDataError("event timestamp is invalid")

        if job_id is None:
            if any(
                row[name] is not None
                for name in (
                    "joined_job_id",
                    "job_name",
                    "job_owner",
                    "job_priority",
                    "job_state",
                )
            ):
                raise EventDataError("jobless event unexpectedly joined a job")
            job_name = job_owner = job_state = None
            job_priority = None
        else:
            job_name = row["job_name"]
            job_owner = row["job_owner"]
            job_priority = row["job_priority"]
            job_state = row["job_state"]
            if (
                not isinstance(job_name, str)
                or not job_name
                or len(job_name) > 4096
                or "\x00" in job_name
                or not isinstance(job_owner, str)
                or not job_owner
                or len(job_owner) > 4096
                or "\x00" in job_owner
                or not _plain_int(job_priority)
                or not MIN_PRIORITY <= job_priority <= MAX_PRIORITY
                or job_state not in _JOB_STATES
            ):
                raise EventDataError("joined job identity/state is invalid")
        return EventRecord(
            id=event_id,
            event_type=event_type,
            job_id=job_id,
            attempt_id=attempt_id,
            payload=_strict_json_loads(row["payload_json"]),
            created_at=float(created_at),
            job_name=job_name,
            job_owner=job_owner,
            job_priority=job_priority,
            job_state=job_state,
        )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def __enter__(self) -> "EventReader":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()


def _display(value: Any, *, maximum: int) -> str:
    text = str(value)
    clean = "".join(character if character.isprintable() else "?" for character in text)
    return clean if len(clean) <= maximum else clean[: maximum - 1] + "…"


def _job_label(event: EventRecord) -> str:
    if event.job_id is None:
        return "gpuq"
    owner = _display(event.job_owner or "-", maximum=64)
    name = _display(event.job_name or "-", maximum=64)
    priority = "?" if event.job_priority is None else f"P{event.job_priority}"
    return f"{_display(event.job_id, maximum=32)} {owner}/{name} {priority}"


def _payload_object(event: EventRecord) -> Mapping[str, Any]:
    return event.payload if isinstance(event.payload, dict) else {}


def _gpu_indices(payload: Mapping[str, Any]) -> str | None:
    raw = payload.get("gpu_indices")
    if not isinstance(raw, list) or not raw or len(raw) > 64:
        return None
    if any(not _plain_int(value) or value < 0 or value > 65_535 for value in raw):
        return None
    return ",".join(str(value) for value in raw)


def _gpu_count(payload: Mapping[str, Any], field: str) -> int | None:
    value = payload.get(field)
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= 65_535
    ):
        return None
    return value


def _progress_phase(payload: Mapping[str, Any]) -> str | None:
    """Return only the narrow display label from a self-reported payload."""

    value = payload.get("phase")
    if not isinstance(value, str) or not _PROGRESS_PHASE_RE.fullmatch(value):
        return None
    return value


def _progress_percent(payload: Mapping[str, Any]) -> int | None:
    value = payload.get("percent")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= 100 else None


def _progress_stale_seconds(payload: Mapping[str, Any]) -> int | None:
    value = payload.get("stale_seconds")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= _SQLITE_SIGNED_INT_MAX else None


def _progress_suffix(
    payload: Mapping[str, Any],
    *,
    stale_seconds: bool = False,
) -> str:
    """Render only explicitly allowed, size-bounded progress fields."""

    parts: list[str] = []
    if stale_seconds:
        seconds = _progress_stale_seconds(payload)
        if seconds is not None:
            parts.append(f"{seconds} 秒")
    phase = _progress_phase(payload)
    if phase is not None:
        parts.append(f"阶段 {phase}")
    return "" if not parts else "（" + "，".join(parts) + "）"


def render_event(event: EventRecord) -> str | None:
    """Render one explicitly whitelisted event, or ignore it."""

    if event.event_type not in _NOTIFICATION_EVENT_TYPES:
        return None
    payload = _payload_object(event)
    label = _job_label(event)
    detail: str
    if event.event_type == "JOB_SUBMITTED":
        detail = "已提交并进入调度"
    elif event.event_type == "START_PLANNED":
        indices = _gpu_indices(payload)
        detail = "已分配 GPU，准备启动"
        if indices is not None:
            detail += f"（GPU {indices}）"
    elif event.event_type == "UNIT_STARTED":
        detail = "已开始运行"
    elif event.event_type == "PREEMPT_REQUESTED":
        mode = payload.get("mode")
        mode_text = (
            _display(mode, maximum=32)
            if mode in {"preempt-save", "preempt-now"}
            else "抢占"
        )
        detail = f"收到 {mode_text} 请求，正在处理"
    elif event.event_type == "PREEMPT_WITHDRAWN":
        detail = "抢占请求已撤回，任务继续运行"
    elif event.event_type == "PREEMPT_TIMEOUT":
        detail = "抢占流程超时，请用 /job 确认当前状态"
    elif event.event_type == "PROGRESS_MILESTONE":
        percent = _progress_percent(payload)
        detail = "训练自报进度已更新"
        if percent is not None:
            detail += f"：{percent}%"
        detail += _progress_suffix(payload)
    elif event.event_type == "PROGRESS_STALLED":
        detail = "训练自报进度长时间未更新；这只是告警，不代表任务失败"
        detail += _progress_suffix(payload, stale_seconds=True)
    elif event.event_type == "PROGRESS_RECOVERED":
        detail = "训练自报进度已恢复更新"
        detail += _progress_suffix(payload, stale_seconds=True)
    elif event.event_type == "PROGRESS_REPORTED_PROBLEM":
        severity = payload.get("severity")
        severity_text = (
            "错误" if severity == "error" else "警告" if severity == "warning" else None
        )
        detail = "训练主动报告了问题"
        if severity_text is not None:
            detail += f"（级别 {severity_text}）"
        phase = _progress_phase(payload)
        if phase is not None:
            detail += f"（阶段 {phase}）"
    elif event.event_type == "SCALE_UP_REQUESTED":
        source = _gpu_count(payload, "from_gpu_count")
        target = _gpu_count(payload, "target_gpu_count")
        detail = "发现更多空闲 GPU，计划在当前 epoch 保存后自动扩容"
        if source is not None and target is not None and target > source:
            detail += f"（{source}→{target} 卡）"
    elif event.event_type == "SCALE_UP_CHECKPOINTED":
        target = _gpu_count(payload, "target_gpu_count")
        detail = "扩容 checkpoint 已确认，正在安全退出本次运行"
        if target is not None:
            detail += f"（目标 {target} 卡）"
    elif event.event_type == "SCALE_UP_WITHDRAWN":
        detail = "自动扩容已撤回，任务继续按当前卡数运行"
    elif event.event_type == "SCALE_UP_RESTART_PLANNED":
        target = _gpu_count(payload, "target_gpu_count")
        detail = "已准备从 checkpoint 启动扩容后的新实例"
        if target is not None:
            detail += f"（目标 {target} 卡）"
    elif event.event_type == "SCALE_UP_COMPLETED":
        source = _gpu_count(payload, "from_gpu_count")
        actual = _gpu_count(payload, "assigned_gpu_count")
        if actual is None:
            actual = _gpu_count(payload, "target_gpu_count")
        detail = "自动扩容已完成"
        if source is not None and actual is not None and actual > source:
            detail += f"（{source}→{actual} 卡）"
        elif actual is not None:
            detail += f"（当前 {actual} 卡）"
    elif event.event_type == "SCALE_UP_FAILED":
        detail = "自动扩容失败，请用 /job 确认当前状态"
    elif event.event_type == "ATTEMPT_FINISHED":
        state = payload.get("job_state")
        attempt_state = payload.get("attempt_state")
        if state == "SUCCEEDED":
            detail = "训练已完成"
        elif state == "FAILED":
            detail = "训练失败，请在服务器查看日志"
        elif state == "PENDING" and attempt_state == "PREEMPTED":
            detail = "本次运行已被抢占，任务已重新排队"
        elif state == "CANCELED":
            detail = "本次运行已结束，任务不会自动重启"
        else:
            detail = "本次运行已结束，请用 /job 确认当前状态"
    elif event.event_type == "JOB_CANCELED":
        # Cancel is recorded before the active process group has necessarily
        # drained, so this must never claim that leases/GPUs are already free.
        detail = "已收到终止请求，相关进程可能仍在退出；GPU 状态请以 /q 为准"
    elif event.event_type == "JOB_RETRIED":
        detail = "已手动重试并重新进入队列"
    elif event.event_type == "ATTEMPT_BOOT_LOST":
        detail = "检测到运行实例丢失，请在服务器检查恢复状态"
    elif event.event_type in {"START_ABORTED", "START_REJECTED"}:
        detail = "启动未成功，请在服务器查看任务和服务日志"
    elif event.event_type == "DAEMON_MODE_CHANGED":
        observe_only = payload.get("observe_only")
        if not isinstance(observe_only, bool):
            return None
        detail = (
            "调度器已切换为只观察模式" if observe_only else "调度器已切换为主动调度模式"
        )
    else:  # The whitelist and branches must stay in lockstep.
        return None
    return f"event #{event.id} | {label}：{detail}"


@dataclass(frozen=True)
class _RoutedMessageChunk:
    text: str
    requires_global: bool
    required_owner_routes: tuple[str, ...]


def _chunk_event_messages_with_routes(
    events: Sequence[EventRecord],
    *,
    limit: int = MAX_NOTIFICATION_CHARS,
) -> list[_RoutedMessageChunk]:
    if not _plain_int(limit) or limit < 128 or limit > MAX_NOTIFICATION_CHARS:
        raise ValueError(
            f"notification limit must be between 128 and {MAX_NOTIFICATION_CHARS}"
        )
    rendered = [
        (event, line) for event in events if (line := render_event(event)) is not None
    ]
    if not rendered:
        return []
    header = "GPU 任务事件："
    available = limit - len(header) - 1
    chunks: list[_RoutedMessageChunk] = []
    current_lines: list[str] = []
    current_requires_global = False
    current_owners: set[str] = set()

    def add_route(event: EventRecord) -> None:
        nonlocal current_requires_global
        owner = event.job_owner
        if owner is None or not _PROGRESS_PHASE_RE.fullmatch(owner):
            current_requires_global = True
        else:
            current_owners.add(owner)

    def flush() -> None:
        nonlocal current_lines, current_requires_global, current_owners
        if not current_lines:
            return
        chunks.append(
            _RoutedMessageChunk(
                text=header + "\n" + "\n".join(current_lines),
                requires_global=current_requires_global,
                required_owner_routes=tuple(sorted(current_owners)),
            )
        )
        current_lines = []
        current_requires_global = False
        current_owners = set()

    for event, line in rendered:
        marker = line.partition(" |")[0] + " | （续）"
        pieces: list[str] = []
        remaining = line
        first = True
        while remaining:
            prefix = "" if first else marker
            width = available - len(prefix)
            if width < 1:
                raise ValueError("notification limit is too small for event marker")
            pieces.append(prefix + remaining[:width])
            remaining = remaining[width:]
            first = False
        for piece in pieces:
            candidate_lines = [*current_lines, piece]
            candidate = header + "\n" + "\n".join(candidate_lines)
            if len(candidate) <= limit:
                current_lines = candidate_lines
                add_route(event)
                continue
            flush()
            current_lines = [piece]
            add_route(event)
    flush()
    if any(not chunk.text or len(chunk.text) > limit for chunk in chunks):
        raise AssertionError("event notification chunking exceeded its bound")
    return chunks


def chunk_event_messages(
    events: Sequence[EventRecord],
    *,
    limit: int = MAX_NOTIFICATION_CHARS,
) -> list[str]:
    return [
        chunk.text for chunk in _chunk_event_messages_with_routes(events, limit=limit)
    ]


@dataclass(frozen=True)
class PendingDelivery:
    delivery_id: str
    first_event_id: int
    last_event_id: int
    chat_id: int
    chunk_index: int
    text: str
    requires_global: bool = True
    required_owner_routes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if (
            not isinstance(self.delivery_id, str)
            or not _DELIVERY_ID_RE.fullmatch(self.delivery_id)
            or not _plain_int(self.first_event_id)
            or not 1 <= self.first_event_id <= _SQLITE_SIGNED_INT_MAX
            or not _plain_int(self.last_event_id)
            or not self.first_event_id <= self.last_event_id <= _SQLITE_SIGNED_INT_MAX
            or not _plain_int(self.chat_id)
            or self.chat_id == 0
            or abs(self.chat_id) > _SQLITE_SIGNED_INT_MAX
            or not _plain_int(self.chunk_index)
            or not 0 <= self.chunk_index <= 99_999
            or not isinstance(self.text, str)
            or not self.text
            or len(self.text) > MAX_NOTIFICATION_CHARS
            or not isinstance(self.requires_global, bool)
            or not isinstance(self.required_owner_routes, tuple)
            or len(self.required_owner_routes) > MAX_EVENT_BATCH_LIMIT
            or any(
                not isinstance(owner, str) or not _PROGRESS_PHASE_RE.fullmatch(owner)
                for owner in self.required_owner_routes
            )
            or len(set(self.required_owner_routes)) != len(self.required_owner_routes)
            or tuple(sorted(self.required_owner_routes)) != self.required_owner_routes
            or (not self.requires_global and not self.required_owner_routes)
        ):
            raise ValueError("invalid pending event delivery")
        expected = _delivery_id(
            self.first_event_id,
            self.last_event_id,
            self.chat_id,
            self.chunk_index,
        )
        if self.delivery_id != expected:
            raise ValueError("pending delivery id does not match its fields")

    def to_dict(self) -> dict[str, Any]:
        return {
            "delivery_id": self.delivery_id,
            "first_event_id": self.first_event_id,
            "last_event_id": self.last_event_id,
            "chat_id": self.chat_id,
            "chunk_index": self.chunk_index,
            "text": self.text,
            "requires_global": self.requires_global,
            "required_owner_routes": list(self.required_owner_routes),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "PendingDelivery":
        fields = {
            "delivery_id",
            "first_event_id",
            "last_event_id",
            "chat_id",
            "chunk_index",
            "text",
            "requires_global",
            "required_owner_routes",
        }
        if (
            not isinstance(raw, dict)
            or set(raw) != fields
            or not isinstance(raw["required_owner_routes"], list)
        ):
            raise EventStateError("pending delivery fields do not match schema")
        try:
            return cls(
                delivery_id=raw["delivery_id"],
                first_event_id=raw["first_event_id"],
                last_event_id=raw["last_event_id"],
                chat_id=raw["chat_id"],
                chunk_index=raw["chunk_index"],
                text=raw["text"],
                requires_global=raw["requires_global"],
                required_owner_routes=tuple(raw["required_owner_routes"]),
            )
        except (TypeError, ValueError):
            raise EventStateError("pending delivery is invalid") from None

    def is_authorized(
        self,
        global_chat_ids: Sequence[int],
        owner_chat_ids: Mapping[str, Sequence[int]],
    ) -> bool:
        """Return whether every event in this complete chunk remains routed."""

        global_chats = _validate_chat_ids(global_chat_ids)
        owner_routes = _validate_owner_chat_ids(owner_chat_ids)
        if self.chat_id in global_chats:
            return True
        if self.requires_global:
            return False
        return all(
            self.chat_id in owner_routes.get(owner, ())
            for owner in self.required_owner_routes
        )


@dataclass(frozen=True)
class DeadLetter:
    delivery: PendingDelivery
    reason: str = "permanent delivery failure"

    def to_dict(self) -> dict[str, Any]:
        return {"delivery": self.delivery.to_dict(), "reason": self.reason}

    @classmethod
    def from_dict(cls, raw: Any) -> "DeadLetter":
        if (
            not isinstance(raw, dict)
            or set(raw) != {"delivery", "reason"}
            or raw["reason"] != "permanent delivery failure"
        ):
            raise EventStateError("dead-letter fields do not match schema")
        return cls(PendingDelivery.from_dict(raw["delivery"]))


def _delivery_id(first: int, last: int, chat_id: int, chunk_index: int) -> str:
    return f"events:{first}-{last}:chat:{chat_id}:chunk:{chunk_index}"


PersistEventState = Callable[["DurableEventState"], None]
SendDelivery = Callable[[int, str], None]
PermanentFailureClassifier = Callable[[Exception], bool]
DeliveryAuthorization = Callable[[PendingDelivery], bool]


@dataclass
class DurableEventState:
    source: EventSourceIdentity | None = None
    last_event_id: int | None = None
    pending_deliveries: list[PendingDelivery] = field(default_factory=list)
    dead_letters: list[DeadLetter] = field(default_factory=list)

    @property
    def initialized(self) -> bool:
        return self.source is not None

    def validate(self) -> None:
        if (self.source is None) != (self.last_event_id is None):
            raise EventStateError(
                "event source and cursor must be initialized together"
            )
        if self.last_event_id is not None:
            _bounded_int(
                self.last_event_id,
                "last_event_id",
                minimum=0,
                maximum=_SQLITE_SIGNED_INT_MAX,
            )
        if len(self.pending_deliveries) > MAX_PENDING_DELIVERIES:
            raise EventStateError("pending delivery count exceeds the limit")
        if _delivery_text_bytes(self.pending_deliveries) > MAX_PENDING_TEXT_BYTES:
            raise EventStateError("pending delivery text exceeds the limit")
        if len(self.dead_letters) > MAX_DEAD_LETTERS:
            raise EventStateError("dead-letter count exceeds the limit")
        all_deliveries = [
            *self.pending_deliveries,
            *(item.delivery for item in self.dead_letters),
        ]
        if _delivery_route_bytes(all_deliveries) > MAX_PENDING_ROUTE_BYTES:
            raise EventStateError("delivery route metadata exceeds the limit")
        identifiers = [item.delivery_id for item in self.pending_deliveries]
        if len(set(identifiers)) != len(identifiers):
            raise EventStateError("pending delivery ids contain duplicates")
        if self.last_event_id is None and (
            self.pending_deliveries or self.dead_letters
        ):
            raise EventStateError("uninitialized event state cannot contain deliveries")
        if self.last_event_id is not None and any(
            delivery.last_event_id > self.last_event_id
            for delivery in self.pending_deliveries
        ):
            raise EventStateError("pending delivery is ahead of event cursor")

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "version": EVENT_STATE_VERSION,
            "source": None if self.source is None else self.source.to_dict(),
            "last_event_id": self.last_event_id,
            "pending_deliveries": [item.to_dict() for item in self.pending_deliveries],
            "dead_letters": [item.to_dict() for item in self.dead_letters],
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "DurableEventState":
        fields = {
            "version",
            "source",
            "last_event_id",
            "pending_deliveries",
            "dead_letters",
        }
        if not isinstance(raw, dict) or set(raw) != fields:
            raise EventStateError("durable event state fields do not match schema")
        if raw["version"] != EVENT_STATE_VERSION:
            raise EventStateError("unsupported durable event state version")
        if not isinstance(raw["pending_deliveries"], list) or not isinstance(
            raw["dead_letters"], list
        ):
            raise EventStateError("event outbox fields must be arrays")
        source = (
            None
            if raw["source"] is None
            else EventSourceIdentity.from_dict(raw["source"])
        )
        state = cls(
            source=source,
            last_event_id=raw["last_event_id"],
            pending_deliveries=[
                PendingDelivery.from_dict(item) for item in raw["pending_deliveries"]
            ],
            dead_letters=[DeadLetter.from_dict(item) for item in raw["dead_letters"]],
        )
        state.validate()
        return state

    def _persist_or_restore(
        self,
        persist: PersistEventState,
        old_values: tuple[
            EventSourceIdentity | None,
            int | None,
            list[PendingDelivery],
            list[DeadLetter],
        ],
    ) -> None:
        try:
            self.validate()
            persist(self)
        except BaseException:
            (
                self.source,
                self.last_event_id,
                self.pending_deliveries,
                self.dead_letters,
            ) = old_values
            raise

    def initialize(
        self,
        position: EventPosition,
        persist: PersistEventState,
    ) -> bool:
        """Pin a fresh state to the current tail without replaying history."""

        self.validate()
        if self.initialized:
            self.assert_compatible(position.source, position.max_event_id)
            return False
        old = (
            self.source,
            self.last_event_id,
            list(self.pending_deliveries),
            list(self.dead_letters),
        )
        self.source = position.source
        self.last_event_id = position.max_event_id
        self._persist_or_restore(persist, old)
        return True

    def assert_compatible(
        self,
        source: EventSourceIdentity,
        max_event_id: int,
    ) -> None:
        self.validate()
        if self.source is None or self.last_event_id is None:
            raise EventStateError("durable event state is not initialized")
        if source != self.source:
            raise EventSourceChangedError(
                "gpuq database identity/schema changed; manual reinitialization required"
            )
        if max_event_id < self.last_event_id:
            raise EventCursorRollbackError(
                "gpuq event id moved behind the durable cursor"
            )

    def enqueue(
        self,
        batch: EventBatch,
        chat_ids: Sequence[int],
        persist: PersistEventState,
        *,
        owner_chat_ids: Mapping[str, Sequence[int]] | None = None,
        message_limit: int = MAX_NOTIFICATION_CHARS,
    ) -> int:
        """Atomically persist cursor advancement and every routed delivery.

        ``chat_ids`` are operations/global destinations and receive every
        whitelisted event.  Owner routes receive only events whose joined
        ``job_owner`` exactly matches their configured label.  A destination
        present in both routes receives one copy.
        """

        self.assert_compatible(batch.source, batch.max_event_id)
        assert self.last_event_id is not None
        if not batch.events:
            return 0
        previous = self.last_event_id
        event_ids = [event.id for event in batch.events]
        if (
            event_ids != sorted(set(event_ids))
            or event_ids[0] <= previous
            or event_ids[-1] > batch.max_event_id
        ):
            raise EventStateError(
                "event batch is not strictly ordered after the cursor"
            )
        routed_events = _events_by_chat(
            batch.events,
            chat_ids,
            owner_chat_ids or {},
        )
        first_event_id = event_ids[0]
        last_event_id = event_ids[-1]
        additions: list[PendingDelivery] = []
        for chat_id, visible_events in routed_events.items():
            chunks = _chunk_event_messages_with_routes(
                visible_events,
                limit=message_limit,
            )
            for chunk_index, chunk in enumerate(chunks):
                additions.append(
                    PendingDelivery(
                        delivery_id=_delivery_id(
                            first_event_id,
                            last_event_id,
                            chat_id,
                            chunk_index,
                        ),
                        first_event_id=first_event_id,
                        last_event_id=last_event_id,
                        chat_id=chat_id,
                        chunk_index=chunk_index,
                        text=chunk.text,
                        requires_global=chunk.requires_global,
                        required_owner_routes=chunk.required_owner_routes,
                    )
                )
        projected = [*self.pending_deliveries, *additions]
        if len(projected) > MAX_PENDING_DELIVERIES:
            raise OutboxFullError("pending delivery count would exceed the limit")
        if _delivery_text_bytes(projected) > MAX_PENDING_TEXT_BYTES:
            raise OutboxFullError("pending delivery text would exceed the limit")
        all_projected = [
            *projected,
            *(item.delivery for item in self.dead_letters),
        ]
        if _delivery_route_bytes(all_projected) > MAX_PENDING_ROUTE_BYTES:
            raise OutboxFullError("delivery route metadata would exceed the limit")
        existing_ids = {item.delivery_id for item in self.pending_deliveries}
        if any(item.delivery_id in existing_ids for item in additions):
            raise EventStateError("event batch would create a duplicate delivery")
        old = (
            self.source,
            self.last_event_id,
            list(self.pending_deliveries),
            list(self.dead_letters),
        )
        self.pending_deliveries = projected
        self.last_event_id = last_event_id
        self._persist_or_restore(persist, old)
        return len(additions)

    def _ack_success(
        self, delivery: PendingDelivery, persist: PersistEventState
    ) -> None:
        if not self.pending_deliveries or self.pending_deliveries[0] != delivery:
            raise EventStateError("outbox delivery order changed unexpectedly")
        old = (
            self.source,
            self.last_event_id,
            list(self.pending_deliveries),
            list(self.dead_letters),
        )
        self.pending_deliveries = self.pending_deliveries[1:]
        self._persist_or_restore(persist, old)

    def _dead_letter(
        self, delivery: PendingDelivery, persist: PersistEventState
    ) -> None:
        if not self.pending_deliveries or self.pending_deliveries[0] != delivery:
            raise EventStateError("outbox delivery order changed unexpectedly")
        old = (
            self.source,
            self.last_event_id,
            list(self.pending_deliveries),
            list(self.dead_letters),
        )
        self.pending_deliveries = self.pending_deliveries[1:]
        self.dead_letters = [
            *self.dead_letters[-(MAX_DEAD_LETTERS - 1) :],
            DeadLetter(delivery),
        ]
        self._persist_or_restore(persist, old)

    def drain(
        self,
        send: SendDelivery,
        persist: PersistEventState,
        *,
        is_permanent: PermanentFailureClassifier | None = None,
        is_authorized: DeliveryAuthorization | None = None,
        max_deliveries: int = DEFAULT_DRAIN_DELIVERIES,
    ) -> "DeliveryReport":
        """Send in order; transient errors retain the failed delivery onward."""

        if not _plain_int(max_deliveries) or not 1 <= max_deliveries <= 100:
            raise ValueError("max_deliveries must be an integer from 1 to 100")
        classifier = is_permanent or _default_permanent_failure
        sent = 0
        dead_lettered = 0
        processed = 0
        while self.pending_deliveries and processed < max_deliveries:
            delivery = self.pending_deliveries[0]
            if is_authorized is not None and not is_authorized(delivery):
                self._dead_letter(delivery, persist)
                dead_lettered += 1
                processed += 1
                continue
            try:
                send(delivery.chat_id, delivery.text)
            except Exception as exc:
                if not classifier(exc):
                    raise
                self._dead_letter(delivery, persist)
                dead_lettered += 1
                processed += 1
                continue
            self._ack_success(delivery, persist)
            sent += 1
            processed += 1
        return DeliveryReport(sent=sent, dead_lettered=dead_lettered)


_EVENT_STATE_FIELDS = frozenset(
    {
        "version",
        "source",
        "last_event_id",
        "pending_deliveries",
        "dead_letters",
    }
)
_LEGACY_PENDING_DELIVERY_FIELDS = frozenset(
    {
        "delivery_id",
        "first_event_id",
        "last_event_id",
        "chat_id",
        "chunk_index",
        "text",
    }
)
_EVENT_SOURCE_FIELDS = frozenset(
    {
        "device",
        "inode",
        "initialized_at",
        "schema_version",
    }
)


def _upgrade_v2_delivery(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != _LEGACY_PENDING_DELIVERY_FIELDS:
        raise EventStateError("legacy pending delivery fields do not match schema")
    return {
        **raw,
        # Event-state v2 predates owner routing.  Treating every old complete
        # message as global-only is conservative: a later owner remap can
        # revoke it but can never expose it to a newly mapped owner chat.
        "requires_global": True,
        "required_owner_routes": [],
    }


def _upgrade_v2_dead_letter(raw: Any) -> dict[str, Any]:
    if (
        not isinstance(raw, dict)
        or set(raw) != {"delivery", "reason"}
        or raw["reason"] != "permanent delivery failure"
    ):
        raise EventStateError("legacy dead-letter fields do not match schema")
    return {
        "delivery": _upgrade_v2_delivery(raw["delivery"]),
        "reason": raw["reason"],
    }


def _upgrade_v2_event_state_raw(raw: dict[str, Any]) -> dict[str, Any]:
    pending = raw["pending_deliveries"]
    dead_letters = raw["dead_letters"]
    if not isinstance(pending, list) or not isinstance(dead_letters, list):
        raise EventStateError("event outbox fields must be arrays")
    return {
        **raw,
        "version": EVENT_STATE_VERSION,
        "pending_deliveries": [_upgrade_v2_delivery(item) for item in pending],
        "dead_letters": [_upgrade_v2_dead_letter(item) for item in dead_letters],
    }


def _assert_migration_source_continuity(
    source: Mapping[str, Any],
    position: EventPosition,
) -> None:
    initialized_at = source["initialized_at"]
    current = position.source
    if (
        not _plain_int(source["device"])
        or source["device"] != current.device
        or not _plain_int(source["inode"])
        or source["inode"] != current.inode
        # EventSourceIdentity.to_dict() has always persisted this field as a
        # JSON float.  Requiring the same representation avoids treating a
        # hand-edited or ambiguously decoded identity as an authorized upgrade.
        or not isinstance(initialized_at, float)
        or not math.isfinite(initialized_at)
        or initialized_at != current.initialized_at
    ):
        raise EventSourceChangedError(
            "gpuq database identity changed during state migration"
        )
    _bounded_int(
        position.max_event_id,
        "max_event_id",
        minimum=0,
        maximum=_SQLITE_SIGNED_INT_MAX,
    )


def migrate_legacy_event_state(
    raw: Any,
    position: EventPosition,
) -> DurableEventState:
    """Upgrade event-state v2 and/or a reviewed legacy Store identity.

    Every initialized migration proves the same database device, inode,
    initialization epoch, and non-rollback cursor.  Event-state v2 deliveries
    gain conservative global-only route provenance.  Store schema 4/5 sources
    are upgraded only after proving continuity with current schema 6.  The
    caller persists the returned complete state atomically before networking.
    """

    if not isinstance(raw, dict) or set(raw) != _EVENT_STATE_FIELDS:
        raise EventStateError("durable event state fields do not match schema")
    version = raw["version"]
    if not _plain_int(version) or version not in {
        LEGACY_EVENT_STATE_VERSION,
        EVENT_STATE_VERSION,
    }:
        raise EventStateError("unsupported durable event state version")
    upgraded_raw = (
        _upgrade_v2_event_state_raw(raw)
        if version == LEGACY_EVENT_STATE_VERSION
        else dict(raw)
    )
    source = raw["source"]
    if source is None:
        if version != LEGACY_EVENT_STATE_VERSION:
            raise EventStateError("durable event state does not require migration")
        return DurableEventState.from_dict(upgraded_raw)
    if not isinstance(source, dict) or set(source) != _EVENT_SOURCE_FIELDS:
        raise EventStateError("event source identity fields do not match schema")
    source_schema = source["schema_version"]
    if not _plain_int(source_schema):
        raise EventStateError("event source schema identity is invalid")
    legacy_source = source_schema in SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS
    if source_schema != STORE_SCHEMA_VERSION and not legacy_source:
        raise EventStateError("event source is not a supported legacy schema identity")
    if version == EVENT_STATE_VERSION and not legacy_source:
        raise EventStateError("durable event state does not require migration")

    _assert_migration_source_continuity(source, position)
    if legacy_source:
        upgraded_source = dict(source)
        upgraded_source["schema_version"] = STORE_SCHEMA_VERSION
        upgraded_raw["source"] = upgraded_source
    state = DurableEventState.from_dict(upgraded_raw)
    state.assert_compatible(position.source, position.max_event_id)
    return state


def migrate_previous_event_state(
    raw: Any,
    position: EventPosition,
) -> DurableEventState:
    """Compatibility entry point requiring a reviewed legacy Store source."""

    source = raw.get("source") if isinstance(raw, dict) else None
    if (
        not isinstance(source, dict)
        or not _plain_int(source.get("schema_version"))
        or source.get("schema_version")
        not in SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS
    ):
        raise EventStateError("event source is not a supported legacy schema identity")
    return migrate_legacy_event_state(raw, position)


def migrate_v4_event_state(
    raw: Any,
    position: EventPosition,
) -> DurableEventState:
    """Backward-compatible name for :func:`migrate_previous_event_state`."""

    return migrate_previous_event_state(raw, position)


@dataclass(frozen=True)
class DeliveryReport:
    sent: int
    dead_lettered: int


def _default_permanent_failure(error: Exception) -> bool:
    return getattr(error, "retriable", True) is False


def _delivery_text_bytes(deliveries: Sequence[PendingDelivery]) -> int:
    return sum(len(item.text.encode("utf-8", errors="strict")) for item in deliveries)


def _delivery_route_bytes(deliveries: Sequence[PendingDelivery]) -> int:
    return sum(
        1
        + sum(
            len(owner.encode("utf-8", errors="strict")) + 3
            for owner in item.required_owner_routes
        )
        for item in deliveries
    )


def _validate_chat_ids(raw: Sequence[int]) -> tuple[int, ...]:
    if isinstance(raw, (str, bytes)):
        raise ValueError("chat_ids must be a sequence of integers")
    values = tuple(raw)
    if any(
        not _plain_int(value) or value == 0 or abs(value) > _SQLITE_SIGNED_INT_MAX
        for value in values
    ):
        raise ValueError("chat_ids contains an invalid Telegram chat id")
    if len(set(values)) != len(values):
        raise ValueError("chat_ids contains duplicates")
    return values


def _validate_owner_chat_ids(
    raw: Mapping[str, Sequence[int]],
) -> dict[str, tuple[int, ...]]:
    if not isinstance(raw, Mapping):
        raise ValueError("owner_chat_ids must be a mapping")
    result: dict[str, tuple[int, ...]] = {}
    for owner, chat_ids in raw.items():
        if not isinstance(owner, str) or not _PROGRESS_PHASE_RE.fullmatch(owner):
            raise ValueError("owner_chat_ids contains an invalid owner label")
        result[owner] = _validate_chat_ids(chat_ids)
    return result


def _events_by_chat(
    events: Sequence[EventRecord],
    global_chat_ids: Sequence[int],
    owner_chat_ids: Mapping[str, Sequence[int]],
) -> dict[int, list[EventRecord]]:
    """Build exact per-destination event views without cross-owner leakage."""

    global_chats = _validate_chat_ids(global_chat_ids)
    owner_routes = _validate_owner_chat_ids(owner_chat_ids)
    routed: dict[int, list[EventRecord]] = {chat_id: [] for chat_id in global_chats}
    for event in events:
        recipients = list(global_chats)
        if event.job_owner is not None:
            recipients.extend(owner_routes.get(event.job_owner, ()))
        seen: set[int] = set()
        for chat_id in recipients:
            if chat_id in seen:
                continue
            seen.add(chat_id)
            routed.setdefault(chat_id, []).append(event)
    return routed


def initialize_from_reader(
    reader: EventReader,
    state: DurableEventState,
    persist: PersistEventState,
) -> bool:
    """Initialize at the current tail, intentionally emitting no history."""

    return state.initialize(reader.position(), persist)


def poll_event_batch(
    reader: EventReader,
    state: DurableEventState,
    chat_ids: Sequence[int],
    persist: PersistEventState,
    *,
    owner_chat_ids: Mapping[str, Sequence[int]] | None = None,
    limit: int = DEFAULT_EVENT_BATCH_LIMIT,
) -> int:
    """Read and durably enqueue one batch; unknown events only move the cursor."""

    if state.last_event_id is None:
        raise EventStateError("durable event state is not initialized")
    batch = reader.read_after(state.last_event_id, limit=limit)
    return state.enqueue(
        batch,
        chat_ids,
        persist,
        owner_chat_ids=owner_chat_ids,
    )
