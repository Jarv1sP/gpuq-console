from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
import signal
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.client import HTTPMessage
from pathlib import Path
from types import FrameType
from typing import Any, Callable, Mapping, Protocol, Sequence, cast

from .config import Config
from .constants import STORE_SCHEMA_VERSION
from .protocol import Client, ProtocolError
from .telegram_events import (
    DurableEventState,
    EVENT_STATE_VERSION,
    EventCursorRollbackError,
    EventDataError,
    EventPosition,
    EventReader,
    EventReaderError,
    EventSchemaError,
    EventSourceChangedError,
    EventStateError,
    LEGACY_EVENT_STATE_VERSION,
    PendingDelivery,
    SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS,
    initialize_from_reader,
    migrate_legacy_event_state,
    poll_event_batch,
)
from .util import atomic_write_json, reject_duplicate_json, validate_label


TELEGRAM_API_ORIGIN = "https://api.telegram.org"
MAX_TELEGRAM_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_TELEGRAM_MESSAGE_CHARS = 3500
MAX_CONFIG_BYTES = 64 * 1024
MAX_STATE_BYTES = 16 * 1024 * 1024
STATE_VERSION = 2
MAX_TELEGRAM_ID = 9_223_372_036_854_775_807
MAX_NOTIFICATION_DELIVERIES_PER_CHECK = 5
MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60

_TOKEN_RE = re.compile(r"^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$")
_LOOPBACK_HTTPS_PROXY_RE = re.compile(
    r"^http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(/?)$"
)
_JOB_ID_RE = re.compile(r"^J[0-9a-f]{12}$")
_COMMAND_RE = re.compile(r"^/([A-Za-z]+)(?:@([A-Za-z0-9_]{5,32}))?$")
_TELEGRAM_METHOD_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
_ALLOWED_METHODS = frozenset({"getMe", "getWebhookInfo", "getUpdates", "sendMessage"})
_SUPPORTED_CHAT_TYPES = frozenset({"private", "group", "supergroup"})


class RpcClient(Protocol):
    def call(
        self,
        operation: str,
        arguments: dict[str, Any] | None = None,
        *,
        request_id: str | None = None,
    ) -> Any: ...


class ReadOnlyGpuqClient:
    """Capability wrapper that refuses every mutating or unknown RPC locally."""

    ALLOWED_OPERATIONS = frozenset({"status", "show", "health"})

    def __init__(self, client: RpcClient) -> None:
        self._client = client

    def call(
        self,
        operation: str,
        arguments: dict[str, Any] | None = None,
        *,
        request_id: str | None = None,
    ) -> Any:
        if operation not in self.ALLOWED_OPERATIONS:
            raise ProtocolError(
                "operation is not available through the read-only Telegram client"
            )
        if request_id is None:
            return self._client.call(operation, arguments)
        return self._client.call(operation, arguments, request_id=request_id)


class TelegramApiError(RuntimeError):
    """A deliberately redacted Bot API failure.

    Telegram embeds the bot token in the request URL.  This exception never
    retains the URL, response body, urllib exception, or token.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
        retriable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after
        self.retriable = retriable


class _RevokedNotificationDestination(TelegramApiError):
    """A locally removed chat; safe to consume into the dead-letter list."""


class _StopRequested(Exception):
    """Internal control flow for an interruptible outbound rate-limit wait."""


def _is_plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_id_list(
    raw: Any,
    field_name: str,
    *,
    allow_negative: bool,
    allow_empty: bool,
) -> tuple[int, ...]:
    if not isinstance(raw, list):
        raise ValueError(f"{field_name} must be an array of integers")
    values: list[int] = []
    for value in raw:
        if not _is_plain_int(value):
            raise ValueError(f"{field_name} must be an array of integers")
        if value == 0 or abs(value) > MAX_TELEGRAM_ID:
            raise ValueError(f"{field_name} contains an invalid Telegram id")
        if not allow_negative and value < 1:
            raise ValueError(f"{field_name} must contain positive user ids")
        values.append(value)
    if not allow_empty and not values:
        raise ValueError(f"{field_name} must not be empty")
    if len(set(values)) != len(values):
        raise ValueError(f"{field_name} contains duplicates")
    return tuple(values)


def _canonical_https_proxy(raw: Any) -> str | None:
    """Validate an explicit local HTTP CONNECT proxy for Telegram HTTPS.

    A deliberately narrow textual grammar avoids hostname resolution and URL
    parser ambiguities such as integer/octal IPv4 forms, IPv4-mapped IPv6,
    userinfo, percent escapes, or hidden path/query components.  Environment
    proxies remain disabled when this option is absent.
    """

    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError("https_proxy must be a canonical loopback HTTP URL")
    match = _LOOPBACK_HTTPS_PROXY_RE.fullmatch(raw)
    if match is None:
        raise ValueError("https_proxy must be a canonical loopback HTTP URL")
    port = int(match.group(2))
    if port > 65_535:
        raise ValueError("https_proxy must be a canonical loopback HTTP URL")
    return f"http://{match.group(1)}:{port}"


def _secure_json_read(path: Path, *, max_bytes: int, label: str) -> Any:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NONBLOCK"):
        # Opening an attacker-replaced FIFO for reading must not block before
        # fstat gets a chance to reject the non-regular file.
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        # Do not include arbitrary file contents in an error.  The path is not
        # secret and is useful for diagnosing a service installation.
        raise ValueError(f"cannot securely open {label}: {path}") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"{label} must be a regular file: {path}")
        if info.st_uid != os.getuid():
            raise ValueError(f"{label} must be owned by uid {os.getuid()}: {path}")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError(f"{label} must have mode 0600: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            payload = handle.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise ValueError(f"{label} is too large: {path}")
        try:
            text = payload.decode("utf-8", errors="strict")
            return reject_duplicate_json(text)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            raise ValueError(f"{label} is not valid JSON: {path}") from None
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class TelegramConfig:
    bot_token: str = field(repr=False)
    allowed_chat_ids: tuple[int, ...]
    notification_chat_ids: tuple[int, ...]
    gpuq_config: Path
    state_path: Path
    owner_notification_chat_ids: Mapping[str, tuple[int, ...]] = field(
        default_factory=dict
    )
    https_proxy: str | None = field(default=None, repr=False)
    allowed_user_ids: tuple[int, ...] | None = None
    poll_timeout_seconds: int = 25
    status_interval_seconds: int = 30

    @classmethod
    def from_json(cls, path: str | Path) -> "TelegramConfig":
        config_path = Path(path)
        raw = _secure_json_read(
            config_path,
            max_bytes=MAX_CONFIG_BYTES,
            label="Telegram config",
        )
        if not isinstance(raw, dict):
            raise ValueError("Telegram config must be a JSON object")
        allowed_fields = {
            "bot_token",
            "allowed_chat_ids",
            "allowed_user_ids",
            "notification_chat_ids",
            "owner_notification_chat_ids",
            "gpuq_config",
            "state_path",
            "https_proxy",
            "poll_timeout_seconds",
            "status_interval_seconds",
        }
        required_fields = {
            "bot_token",
            "allowed_chat_ids",
            "notification_chat_ids",
            "gpuq_config",
            "state_path",
        }
        unknown = sorted(set(raw) - allowed_fields)
        if unknown:
            raise ValueError(f"unknown Telegram config keys: {', '.join(unknown)}")
        missing = sorted(required_fields - set(raw))
        if missing:
            raise ValueError(f"missing Telegram config keys: {', '.join(missing)}")

        token = raw["bot_token"]
        if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
            raise ValueError("bot_token has an invalid format")
        raw_allowed_users = raw.get("allowed_user_ids")
        allowed_users = (
            None
            if raw_allowed_users is None
            else _validate_id_list(
                raw_allowed_users,
                "allowed_user_ids",
                allow_negative=False,
                allow_empty=False,
            )
        )
        allowed_chats = _validate_id_list(
            raw["allowed_chat_ids"],
            "allowed_chat_ids",
            allow_negative=allowed_users is not None,
            allow_empty=False,
        )
        notification_chats = _validate_id_list(
            raw["notification_chat_ids"],
            "notification_chat_ids",
            allow_negative=allowed_users is not None,
            allow_empty=True,
        )
        if not set(notification_chats).issubset(allowed_chats):
            raise ValueError(
                "notification_chat_ids must be a subset of allowed_chat_ids"
            )

        raw_owner_notifications = raw.get("owner_notification_chat_ids", {})
        if not isinstance(raw_owner_notifications, dict):
            raise ValueError("owner_notification_chat_ids must be an object")
        owner_notifications: dict[str, tuple[int, ...]] = {}
        for owner, destinations in raw_owner_notifications.items():
            try:
                normalized_owner = validate_label(owner, "owner")
            except (TypeError, ValueError):
                raise ValueError(
                    "owner_notification_chat_ids contains an invalid owner label"
                ) from None
            chats = _validate_id_list(
                destinations,
                f"owner_notification_chat_ids[{normalized_owner}]",
                allow_negative=allowed_users is not None,
                allow_empty=False,
            )
            if not set(chats).issubset(allowed_chats):
                raise ValueError(
                    "owner_notification_chat_ids destinations must be a subset "
                    "of allowed_chat_ids"
                )
            owner_notifications[normalized_owner] = chats

        paths: dict[str, Path] = {}
        for name in ("gpuq_config", "state_path"):
            value = raw[name]
            if not isinstance(value, str):
                raise ValueError(f"{name} must be an absolute path string")
            parsed = Path(value)
            if not parsed.is_absolute():
                raise ValueError(f"{name} must be an absolute path string")
            paths[name] = parsed
        if paths["gpuq_config"] == paths["state_path"]:
            raise ValueError("gpuq_config and state_path must be different files")
        try:
            if paths["state_path"].samefile(config_path):
                raise ValueError("state_path must not overwrite Telegram config")
        except FileNotFoundError:
            pass

        poll_timeout = raw.get("poll_timeout_seconds", 25)
        status_interval = raw.get("status_interval_seconds", 30)
        https_proxy = _canonical_https_proxy(raw.get("https_proxy"))
        if not _is_plain_int(poll_timeout) or not 1 <= poll_timeout <= 50:
            raise ValueError("poll_timeout_seconds must be an integer from 1 to 50")
        if not _is_plain_int(status_interval) or not 5 <= status_interval <= 3600:
            raise ValueError(
                "status_interval_seconds must be an integer from 5 to 3600"
            )

        return cls(
            bot_token=token,
            allowed_chat_ids=allowed_chats,
            allowed_user_ids=allowed_users,
            notification_chat_ids=notification_chats,
            gpuq_config=paths["gpuq_config"],
            state_path=paths["state_path"],
            owner_notification_chat_ids=owner_notifications,
            https_proxy=https_proxy,
            poll_timeout_seconds=poll_timeout,
            status_interval_seconds=status_interval,
        )

    @property
    def all_notification_chat_ids(self) -> tuple[int, ...]:
        """Return global and owner-routed destinations once, in stable order."""

        values = list(self.notification_chat_ids)
        for chats in self.owner_notification_chat_ids.values():
            values.extend(chats)
        return tuple(dict.fromkeys(values))


@dataclass
class BotState:
    next_update_id: int | None = None
    bot_id: int | None = None
    event_state: DurableEventState = field(default_factory=DurableEventState)

    @classmethod
    def _read(cls, path: Path) -> dict[str, Any] | None:
        try:
            raw = _secure_json_read(
                path,
                max_bytes=MAX_STATE_BYTES,
                label="Telegram state",
            )
        except ValueError:
            if not path.exists() and not path.is_symlink():
                return None
            raise
        if not isinstance(raw, dict):
            raise ValueError("Telegram state must be a JSON object")
        return raw

    @classmethod
    def _decode(
        cls,
        raw: dict[str, Any],
        *,
        legacy_position: EventPosition | None = None,
    ) -> "BotState":
        if set(raw) != {
            "version",
            "next_update_id",
            "bot_id",
            "event_state",
        }:
            raise ValueError("Telegram state fields do not match schema")
        if raw["version"] != STATE_VERSION:
            raise ValueError("unsupported Telegram state version")
        offset = raw["next_update_id"]
        if offset is not None and (
            not _is_plain_int(offset) or not 0 <= offset <= MAX_TELEGRAM_ID
        ):
            raise ValueError("Telegram state has an invalid next_update_id")
        bot_id = raw["bot_id"]
        if bot_id is not None and (
            not _is_plain_int(bot_id) or not 1 <= bot_id <= MAX_TELEGRAM_ID
        ):
            raise ValueError("Telegram state has an invalid bot_id")
        try:
            event_state = (
                DurableEventState.from_dict(raw["event_state"])
                if legacy_position is None
                else migrate_legacy_event_state(raw["event_state"], legacy_position)
            )
        except EventStateError as exc:
            raise ValueError(f"Telegram event state is invalid: {exc}") from None
        return cls(offset, bot_id, event_state)

    @classmethod
    def load(cls, path: Path) -> "BotState":
        raw = cls._read(path)
        return cls() if raw is None else cls._decode(raw)

    @classmethod
    def load_for_event_reader(cls, path: Path, reader: EventReader) -> "BotState":
        """Load state, narrowly upgrading reviewed durable event state.

        Normal state decoding remains fail-closed.  Only event-state v2 or a
        source pinned to a reviewed legacy Store schema reaches migration.  It
        independently snapshots the current reader, proves database identity
        and cursor continuity, and atomically persists the upgraded complete
        bot state before the caller can create network traffic.
        """

        raw = cls._read(path)
        if raw is None:
            return cls()
        try:
            return cls._decode(raw)
        except ValueError:
            event_state = raw.get("event_state")
            event_state_version = (
                event_state.get("version") if isinstance(event_state, dict) else None
            )
            source = (
                event_state.get("source") if isinstance(event_state, dict) else None
            )
            legacy_routes = (
                _is_plain_int(event_state_version)
                and event_state_version == LEGACY_EVENT_STATE_VERSION
            )
            if not _is_plain_int(event_state_version) or event_state_version not in {
                LEGACY_EVENT_STATE_VERSION,
                EVENT_STATE_VERSION,
            }:
                raise
            if source is None:
                if not legacy_routes:
                    raise
            elif isinstance(source, dict):
                source_schema = source.get("schema_version")
                if (
                    not _is_plain_int(source_schema)
                    or source_schema
                    not in {
                        *SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS,
                        STORE_SCHEMA_VERSION,
                    }
                    or (
                        not legacy_routes
                        and source_schema
                        not in SUPPORTED_LEGACY_EVENT_SOURCE_SCHEMA_VERSIONS
                    )
                ):
                    raise
            else:
                raise
        migrated = cls._decode(raw, legacy_position=reader.position())
        migrated.save(path)
        return migrated

    def save(self, path: Path) -> None:
        atomic_write_json(
            path,
            {
                "version": STATE_VERSION,
                "next_update_id": self.next_update_id,
                "bot_id": self.bot_id,
                "event_state": self.event_state.to_dict(),
            },
            mode=0o600,
        )


class StateFileLock:
    """Non-blocking per-state-file lock that prevents two long pollers."""

    def __init__(self, state_path: Path) -> None:
        self.path = state_path.with_name(state_path.name + ".lock")
        self._descriptor: int | None = None

    def __enter__(self) -> "StateFileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        parent_info = self.path.parent.lstat()
        if not stat.S_ISDIR(parent_info.st_mode):
            raise RuntimeError("Telegram state parent must be a directory")
        if (
            parent_info.st_uid != os.getuid()
            or stat.S_IMODE(parent_info.st_mode) & 0o077
        ):
            raise RuntimeError(
                "Telegram state parent must be current-user owned and private"
            )
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError:
            raise RuntimeError("cannot securely open Telegram state lock") from None
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise RuntimeError(
                    "Telegram state lock must be current-user owned mode 0600"
                )
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError(
                    "another Telegram bot process is using this state file"
                ) from None
        except BaseException:
            os.close(descriptor)
            raise
        self._descriptor = descriptor
        return self

    def __exit__(self, *args: object) -> None:
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> None:
        return None


class TelegramTransport:
    def __init__(
        self,
        bot_token: str,
        *,
        https_proxy: str | None = None,
        opener: Any | None = None,
        max_response_bytes: int = MAX_TELEGRAM_RESPONSE_BYTES,
    ) -> None:
        if not _TOKEN_RE.fullmatch(bot_token):
            raise ValueError("bot_token has an invalid format")
        if not _is_plain_int(max_response_bytes) or max_response_bytes < 1024:
            raise ValueError("max_response_bytes must be at least 1024")
        canonical_proxy = _canonical_https_proxy(https_proxy)
        self._bot_token = bot_token
        self._opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler(
                {} if canonical_proxy is None else {"https": canonical_proxy}
            ),
            _NoRedirectHandler(),
        )
        self._max_response_bytes = max_response_bytes

    def _decode_response(self, body: bytes) -> Any:
        try:
            raw = reject_duplicate_json(body.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            raise TelegramApiError(
                "Telegram API returned an invalid JSON response",
                retriable=True,
            ) from None
        if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool):
            raise TelegramApiError(
                "Telegram API response fields are invalid",
                retriable=True,
            )
        if raw["ok"] is True:
            if "result" not in raw:
                raise TelegramApiError(
                    "Telegram API response is missing result",
                    retriable=True,
                )
            return raw["result"]
        error_code = raw.get("error_code")
        if not _is_plain_int(error_code):
            raise TelegramApiError(
                "Telegram API error response fields are invalid",
                retriable=True,
            )
        error_code = cast(int, error_code)
        retry_after = _parse_retry_after(raw.get("parameters"))
        if error_code == 429:
            suffix = (
                f"; retry_after={retry_after:g}s" if retry_after is not None else ""
            )
            raise TelegramApiError(
                f"Telegram API rate limited the bot{suffix}",
                status_code=429,
                retry_after=retry_after,
                retriable=True,
            )
        raise TelegramApiError(
            f"Telegram API rejected a request (error {error_code})",
            status_code=error_code,
            retriable=error_code >= 500,
        )

    def _read_bounded(self, response: Any) -> bytes:
        body = response.read(self._max_response_bytes + 1)
        if not isinstance(body, bytes) or len(body) > self._max_response_bytes:
            raise TelegramApiError("Telegram API response exceeded the size limit")
        return body

    def call(
        self,
        method: str,
        payload: Mapping[str, Any],
        *,
        timeout_seconds: float = 15.0,
    ) -> Any:
        if method not in _ALLOWED_METHODS or not _TELEGRAM_METHOD_RE.fullmatch(method):
            raise ValueError("unsupported Telegram API method")
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(float(timeout_seconds))
            or timeout_seconds <= 0
            or timeout_seconds > 120
        ):
            raise ValueError("timeout_seconds must be positive and at most 120")
        try:
            wire = json.dumps(
                dict(payload),
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError):
            raise ValueError(
                "Telegram request payload is not JSON serializable"
            ) from None
        request = urllib.request.Request(
            f"{TELEGRAM_API_ORIGIN}/bot{self._bot_token}/{method}",
            data=wire,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=float(timeout_seconds)) as response:
                status_code = int(response.getcode())
                if status_code < 200 or status_code >= 300:
                    raise TelegramApiError(
                        f"Telegram API returned HTTP {status_code}",
                        status_code=status_code,
                        retriable=status_code >= 500,
                    )
                return self._decode_response(self._read_bounded(response))
        except urllib.error.HTTPError as exc:
            status_code = int(exc.code)
            try:
                body = self._read_bounded(exc)
            except (TelegramApiError, OSError, TimeoutError):
                body = b""
            if body:
                try:
                    return self._decode_response(body)
                except TelegramApiError as decoded:
                    if decoded.status_code == 429:
                        raise decoded from None
            if status_code == 429:
                raise TelegramApiError(
                    "Telegram API rate limited the bot",
                    status_code=429,
                    retriable=True,
                ) from None
            raise TelegramApiError(
                f"Telegram API returned HTTP {status_code}",
                status_code=status_code,
                retriable=status_code >= 500,
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise TelegramApiError(
                "Telegram API network request failed",
                retriable=True,
            ) from None

    def get_webhook_info(self) -> dict[str, Any]:
        result = self.call("getWebhookInfo", {})
        if not isinstance(result, dict) or not isinstance(result.get("url"), str):
            raise TelegramApiError(
                "Telegram getWebhookInfo result fields are invalid",
                retriable=True,
            )
        return cast(dict[str, Any], result)

    def get_me(self) -> dict[str, Any]:
        result = self.call("getMe", {})
        if (
            not isinstance(result, dict)
            or not _is_plain_int(result.get("id"))
            or not 1 <= cast(int, result.get("id")) <= MAX_TELEGRAM_ID
            or not isinstance(result.get("username"), str)
            or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", result["username"])
        ):
            raise TelegramApiError(
                "Telegram getMe result fields are invalid",
                retriable=True,
            )
        return cast(dict[str, Any], result)

    def get_updates(
        self,
        *,
        offset: int | None,
        timeout_seconds: int,
    ) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": timeout_seconds,
            "allowed_updates": ["message"],
            "limit": 100,
        }
        if offset is not None:
            payload["offset"] = offset
        result = self.call(
            "getUpdates",
            payload,
            timeout_seconds=float(timeout_seconds + 10),
        )
        if not isinstance(result, list) or any(
            not isinstance(update, dict) for update in result
        ):
            raise TelegramApiError(
                "Telegram getUpdates result fields are invalid",
                retriable=True,
            )
        return cast(list[dict[str, Any]], result)

    def send_message(self, chat_id: int, text: str) -> None:
        result = self.call(
            "sendMessage",
            {"chat_id": chat_id, "text": text},
        )
        chat = result.get("chat") if isinstance(result, dict) else None
        if (
            not isinstance(result, dict)
            or not _is_plain_int(result.get("message_id"))
            or not 1 <= cast(int, result.get("message_id")) <= MAX_TELEGRAM_ID
            or not isinstance(chat, dict)
            or not _is_plain_int(chat.get("id"))
            or cast(int, chat.get("id")) != chat_id
        ):
            raise TelegramApiError(
                "Telegram sendMessage result fields are invalid",
                retriable=True,
            )


def _parse_retry_after(parameters: Any) -> float | None:
    if not isinstance(parameters, dict):
        return None
    value = parameters.get("retry_after")
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or value <= 0
        or value > MAX_RETRY_AFTER_SECONDS
    ):
        return None
    return float(value)


def chunk_text(text: str, *, limit: int = MAX_TELEGRAM_MESSAGE_CHARS) -> list[str]:
    if not _is_plain_int(limit) or limit < 1:
        raise ValueError("message chunk limit must be a positive integer")
    if not text:
        return [""]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        split = remaining.rfind("\n", 0, limit + 1)
        if split <= 0:
            split = limit
        chunks.append(remaining[:split])
        remaining = remaining[split:]
        if remaining.startswith("\n"):
            remaining = remaining[1:]
    if remaining or not chunks:
        chunks.append(remaining)
    return chunks


def _display(value: Any, *, maximum: int = 200) -> str:
    if value is None:
        return "-"
    text = str(value)
    clean = "".join(character if character.isprintable() else "?" for character in text)
    if len(clean) > maximum:
        return clean[: maximum - 1] + "…"
    return clean


def _gpu_assignment(job: Mapping[str, Any]) -> str:
    indices = job.get("assigned_gpu_indices")
    if isinstance(indices, list) and indices:
        return ",".join(_display(item, maximum=12) for item in indices)
    requested = job.get("gpu_count")
    minimum = job.get("min_gpu_count")
    if job.get("elastic_gpu_count") is True and requested is not None:
        return f"waiting({minimum}-{requested})"
    return f"waiting({requested})"


def _capacity_summary(payload: Mapping[str, Any]) -> str:
    """Render only bounded capacity facts; collision details remain local."""

    parts: list[str] = []
    capacity = payload.get("capacity_health")
    if isinstance(capacity, str) and capacity in {"ok", "partial", "blocked"}:
        parts.append(f"capacity={capacity}")
    quarantined = payload.get("quarantined_gpus")
    if isinstance(quarantined, list):
        indices = sorted(
            {
                item["index"]
                for item in quarantined
                if isinstance(item, Mapping)
                and _is_plain_int(item.get("index"))
                and item["index"] >= 0
            }
        )
        if indices:
            parts.append("quarantine=" + ",".join(str(item) for item in indices))
    schedulable = payload.get("schedulable_gpu_indices")
    if isinstance(schedulable, list) and all(
        _is_plain_int(item) and item >= 0 for item in schedulable
    ):
        parts.append(
            "schedulable="
            + (",".join(str(item) for item in sorted(set(schedulable))) or "-")
        )
    return " | ".join(parts)


def format_queue(result: Any) -> str:
    if not isinstance(result, dict):
        raise ProtocolError("status result is not an object")
    daemon = result.get("daemon")
    jobs = result.get("jobs")
    if not isinstance(daemon, dict) or not isinstance(jobs, list):
        raise ProtocolError("status result fields are invalid")
    mode = "observe-only" if daemon.get("observe_only") is True else "active"
    indices = daemon.get("managed_indices")
    pool = ",".join(map(str, indices)) if isinstance(indices, list) else "?"
    capacity = _capacity_summary(daemon)
    lines = [
        f"gpuq {mode} | health={_display(daemon.get('health'), maximum=32)}"
        + (f" | {capacity}" if capacity else "")
        + f" | pool={pool}",
        f"active jobs shown: {len(jobs)} (最多100条；达到上限时可能截断)",
    ]
    for raw_job in jobs:
        if not isinstance(raw_job, dict):
            raise ProtocolError("status contains an invalid job")
        priority = raw_job.get("priority_name")
        if priority is None and raw_job.get("priority") is not None:
            priority = f"P{raw_job['priority']}"
        identity = f"{_display(raw_job.get('owner'), maximum=64)}/{_display(raw_job.get('name'), maximum=64)}"
        lines.append(
            f"{_display(raw_job.get('id'), maximum=32)} "
            f"{_display(priority, maximum=8)} "
            f"{_display(raw_job.get('state'), maximum=32)} "
            f"gpu={_gpu_assignment(raw_job)} {identity}"
        )
    external = result.get("external", [])
    if isinstance(external, list) and external:
        process_count = sum(
            len(item.get("pids", []))
            for item in external
            if isinstance(item, dict) and isinstance(item.get("pids", []), list)
        )
        lines.append(
            f"protected external: {process_count} process(es) on {len(external)} GPU(s)"
        )
    return "\n".join(lines)


def format_health(result: Any) -> str:
    if not isinstance(result, dict) or not isinstance(result.get("health"), str):
        raise ProtocolError("health result fields are invalid")
    lines = [f"gpuq health={_display(result['health'], maximum=32)}"]
    capacity = _capacity_summary(result)
    if capacity:
        lines.append(capacity)
    if result.get("recovery_scans") is not None:
        lines.append(f"recovery_scans={_display(result['recovery_scans'], maximum=32)}")
    if result.get("error"):
        # The detailed probe error can contain host paths or command output.
        # Telegram only reports that diagnostics are available locally.
        lines.append("error_present=yes (inspect local service logs)")
    return "\n".join(lines)


def format_job(result: Any) -> str:
    if not isinstance(result, dict) or not isinstance(result.get("job"), dict):
        raise ProtocolError("show result fields are invalid")
    job = result["job"]
    attempts = result.get("attempts", [])
    leases = result.get("leases", [])
    if not isinstance(attempts, list) or not isinstance(leases, list):
        raise ProtocolError("show result fields are invalid")
    priority = job.get("priority_name")
    if priority is None and job.get("priority") is not None:
        priority = f"P{job['priority']}"
    lines = [
        f"{_display(job.get('id'), maximum=32)} {_display(job.get('name'), maximum=100)}",
        f"submitter={_display(job.get('owner'), maximum=64)} state={_display(job.get('state'), maximum=32)}",
        f"priority={_display(priority, maximum=8)} mode={_display(job.get('dispatch_mode'), maximum=32)} placement={_display(job.get('placement'), maximum=32)}",
        f"requested_gpu={_display(job.get('min_gpu_count'), maximum=12)}-{_display(job.get('gpu_count'), maximum=12)} active_leases={len(leases)}",
    ]
    if job.get("state_reason"):
        lines.append("state_reason_present=yes (inspect with local gpu show)")
    if attempts:
        latest = attempts[0]
        if not isinstance(latest, dict):
            raise ProtocolError("show contains an invalid attempt")
        assigned = latest.get("gpu_indices", [])
        gpu_text = ",".join(map(str, assigned)) if isinstance(assigned, list) else "?"
        lines.append(
            f"latest_attempt={_display(latest.get('id'), maximum=64)} "
            f"state={_display(latest.get('state'), maximum=32)} gpu={gpu_text or '-'}"
        )
    return "\n".join(lines)


HELP_TEXT = (
    "只读 GPU 调度查询：\n"
    "/q 或 /queue - 查看队列\n"
    "/health - 查看调度器健康状态\n"
    "/job JOB_ID - 查看单项任务\n"
    "/help - 查看帮助"
)


class TelegramBot:
    def __init__(
        self,
        config: TelegramConfig,
        transport: TelegramTransport,
        rpc: RpcClient,
        *,
        state: BotState | None = None,
        event_reader: EventReader | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        send_interval_seconds: float = 1.0,
        group_send_interval_seconds: float = 3.1,
        global_send_interval_seconds: float = 0.04,
    ) -> None:
        if (
            isinstance(send_interval_seconds, bool)
            or not isinstance(send_interval_seconds, (int, float))
            or not math.isfinite(float(send_interval_seconds))
            or send_interval_seconds < 1.0
        ):
            raise ValueError("send_interval_seconds must be at least 1 second")
        if (
            isinstance(group_send_interval_seconds, bool)
            or not isinstance(group_send_interval_seconds, (int, float))
            or not math.isfinite(float(group_send_interval_seconds))
            or group_send_interval_seconds < 3.1
        ):
            raise ValueError("group_send_interval_seconds must be at least 3.1 seconds")
        if (
            isinstance(global_send_interval_seconds, bool)
            or not isinstance(global_send_interval_seconds, (int, float))
            or not math.isfinite(float(global_send_interval_seconds))
            or global_send_interval_seconds < 0.04
        ):
            raise ValueError(
                "global_send_interval_seconds must be at least 0.04 seconds"
            )
        self.config = config
        self.transport = transport
        self.rpc = (
            rpc if isinstance(rpc, ReadOnlyGpuqClient) else ReadOnlyGpuqClient(rpc)
        )
        self.state = state if state is not None else BotState.load(config.state_path)
        self.event_reader = event_reader
        self.clock = clock
        self.sleeper = sleeper
        self.send_interval_seconds = float(send_interval_seconds)
        self.group_send_interval_seconds = float(group_send_interval_seconds)
        self.global_send_interval_seconds = float(global_send_interval_seconds)
        self._next_status_at = self.clock()
        self._bot_username: str | None = None
        self._last_send_at: dict[int, float] = {}
        self._last_global_send_at: float | None = None
        self._active_stop_event: threading.Event | None = None

    def startup(self) -> None:
        webhook = self.transport.get_webhook_info()
        if webhook["url"]:
            raise RuntimeError(
                "Telegram webhook is configured; refusing to start long polling"
            )
        identity = self.transport.get_me()
        bot_id_value = identity.get("id") if isinstance(identity, dict) else None
        username = identity.get("username") if isinstance(identity, dict) else None
        if (
            not _is_plain_int(bot_id_value)
            or not 1 <= cast(int, bot_id_value) <= MAX_TELEGRAM_ID
            or not isinstance(username, str)
            or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", username)
        ):
            raise TelegramApiError(
                "Telegram getMe result fields are invalid",
                retriable=True,
            )
        self._bot_username = username
        bot_id = cast(int, bot_id_value)
        if self.state.bot_id != bot_id:
            # getUpdates offsets belong to one bot token.  Reusing an offset
            # after rotating to a different bot could skip that bot's pending
            # commands, so pin the identity and restart its stream at offset 0.
            self.state.bot_id = bot_id
            self.state.next_update_id = None
            self.state.save(self.config.state_path)
        # Establish the durable event tail before the first potentially long
        # getUpdates call.  Events committed during that poll must be read on
        # this iteration, not mistaken for pre-existing history afterwards.
        if self.event_reader is not None and not self.state.event_state.initialized:
            initialize_from_reader(
                self.event_reader,
                self.state.event_state,
                self._persist_event_state,
            )

    def _persist_event_state(self, candidate: DurableEventState) -> None:
        if candidate is not self.state.event_state:
            raise EventStateError("event state persistence target changed")
        self.state.save(self.config.state_path)

    def _authorized_chat_id(self, update: Mapping[str, Any]) -> int | None:
        message = update.get("message")
        if not isinstance(message, dict):
            return None
        chat = message.get("chat")
        sender = message.get("from")
        if not isinstance(chat, dict) or not isinstance(sender, dict):
            return None
        chat_id = chat.get("id")
        user_id = sender.get("id")
        chat_type = chat.get("type")
        if (
            not _is_plain_int(chat_id)
            or not _is_plain_int(user_id)
            or chat_type not in _SUPPORTED_CHAT_TYPES
            or chat_id not in self.config.allowed_chat_ids
            or sender.get("is_bot") is not False
        ):
            return None
        authorized_chat_id: int = cast(int, chat_id)
        authorized_user_id: int = cast(int, user_id)
        if chat_type == "private" and authorized_chat_id != authorized_user_id:
            return None
        if self.config.allowed_user_ids is None:
            if chat_type != "private" or authorized_chat_id != authorized_user_id:
                return None
        elif authorized_user_id not in self.config.allowed_user_ids:
            return None
        return authorized_chat_id

    def _send_text(self, chat_id: int, text: str) -> None:
        for chunk in chunk_text(text):
            previous = self._last_send_at.get(chat_id)
            now = self.clock()
            not_before = now
            if previous is not None:
                interval = (
                    self.group_send_interval_seconds
                    if chat_id < 0
                    else self.send_interval_seconds
                )
                not_before = max(not_before, previous + interval)
            if self._last_global_send_at is not None:
                not_before = max(
                    not_before,
                    self._last_global_send_at + self.global_send_interval_seconds,
                )
            delay = not_before - now
            if delay > 0:
                if (
                    self._active_stop_event is not None
                    and self._active_stop_event.wait(delay)
                ):
                    raise _StopRequested
                if self._active_stop_event is None:
                    self.sleeper(delay)
            self.transport.send_message(chat_id, chunk)
            sent_at = self.clock()
            self._last_send_at[chat_id] = sent_at
            self._last_global_send_at = sent_at

    def _rpc_call(self, operation: str, arguments: dict[str, Any]) -> Any:
        if operation not in {"status", "show", "health"}:
            raise AssertionError("Telegram bot attempted a non-read-only RPC")
        return self.rpc.call(operation, arguments)

    def _command_response(self, text: str) -> str | None:
        if "\n" in text or "\r" in text:
            return "命令格式不正确。\n" + HELP_TEXT
        parts = text.strip().split()
        match = _COMMAND_RE.fullmatch(parts[0]) if parts else None
        if match is None:
            return "未知命令。\n" + HELP_TEXT
        suffix = match.group(2)
        if suffix is not None and (
            self._bot_username is None
            or suffix.casefold() != self._bot_username.casefold()
        ):
            # A group command explicitly addressed to another bot is ignored.
            return None
        command = "/" + match.group(1).lower()
        if command in {"/help", "/start"}:
            return HELP_TEXT if len(parts) == 1 else "用法：/help"
        if command in {"/q", "/queue"}:
            if len(parts) != 1:
                return "用法：/q"
            return format_queue(self._rpc_call("status", {"all": False, "limit": 100}))
        if command == "/health":
            if len(parts) != 1:
                return "用法：/health"
            return format_health(self._rpc_call("health", {}))
        if command == "/job":
            if len(parts) != 2 or not _JOB_ID_RE.fullmatch(parts[1]):
                return "用法：/job J0123456789ab"
            return format_job(self._rpc_call("show", {"job_id": parts[1]}))
        return "未知命令。\n" + HELP_TEXT

    def process_update(self, update: Mapping[str, Any]) -> None:
        chat_id = self._authorized_chat_id(update)
        if chat_id is None:
            return
        message = update.get("message")
        if not isinstance(message, dict):
            return
        text = message.get("text")
        if not isinstance(text, str):
            return
        try:
            response = self._command_response(text)
        except ProtocolError:
            # RPC errors can contain local socket paths or daemon diagnostics.
            response = "gpuq 查询暂时失败，请在服务器本地检查服务状态。"
        if response is not None:
            self._send_text(chat_id, response)

    def poll_once(self) -> int:
        requested_offset = self.state.next_update_id
        updates = self.transport.get_updates(
            offset=requested_offset,
            timeout_seconds=self.config.poll_timeout_seconds,
        )
        if not updates:
            if requested_offset is not None:
                # The offset-bearing call has now confirmed every older
                # update.  Persisting None keeps an idle bot ready for
                # Telegram's documented random update_id epoch after a week
                # without updates, without replaying an unconfirmed command.
                self.state.next_update_id = None
                self.state.save(self.config.state_path)
            return 0
        previous_update_id: int | None = None
        reset_epoch = False
        processed = 0
        for update in updates:
            update_id = update.get("update_id")
            if not _is_plain_int(update_id):
                raise TelegramApiError(
                    "Telegram update has an invalid update_id",
                    retriable=True,
                )
            update_id = cast(int, update_id)
            if update_id < 0 or update_id >= MAX_TELEGRAM_ID:
                raise TelegramApiError(
                    "Telegram update has an invalid update_id",
                    retriable=True,
                )
            if previous_update_id is not None and update_id <= previous_update_id:
                raise TelegramApiError(
                    "Telegram updates are not strictly ordered",
                    retriable=True,
                )
            if (
                previous_update_id is None
                and requested_offset is not None
                and update_id < requested_offset
            ):
                # Telegram may randomize the next update_id after at least a
                # week of silence.  A strictly increasing response beginning
                # below our requested offset is the new epoch, not stale data.
                reset_epoch = True
            previous_update_id = update_id
            if (
                not reset_epoch
                and self.state.next_update_id is not None
                and update_id < self.state.next_update_id
            ):
                continue
            self.process_update(update)
            # Persist after processing each individual update.  If handling or
            # sending fails, this update remains unacknowledged and is retried.
            self.state.next_update_id = update_id + 1
            self.state.save(self.config.state_path)
            processed += 1
        return processed

    def check_notifications(self) -> int:
        if self.event_reader is None:
            return 0
        event_state = self.state.event_state

        def notification_is_authorized(delivery: PendingDelivery) -> bool:
            return (
                delivery.chat_id in self.config.allowed_chat_ids
                and delivery.is_authorized(
                    self.config.notification_chat_ids,
                    self.config.owner_notification_chat_ids,
                )
            )

        def send_notification(chat_id: int, text: str) -> None:
            if (
                chat_id not in self.config.allowed_chat_ids
                or chat_id not in self.config.all_notification_chat_ids
            ):
                # A chat removed from the allowlist after enqueue must never
                # receive an older durable message.  Mark it as a permanent
                # dead letter through the normal outbox path.
                raise _RevokedNotificationDestination(
                    "queued notification is no longer authorized",
                    retriable=False,
                )
            self._send_text(chat_id, text)

        def is_permanent_chat_failure(error: Exception) -> bool:
            if isinstance(error, _RevokedNotificationDestination):
                return True
            # 400/403 from sendMessage are chat/message scoped for our fixed,
            # plain-text payload.  Authentication, endpoint, and long-poller
            # conflicts (401/404/409) are service-wide: retain the outbox and
            # fail so an operator can repair the credential/configuration.
            return isinstance(error, TelegramApiError) and error.status_code in {
                400,
                403,
            }

        if not event_state.initialized:
            initialize_from_reader(
                self.event_reader,
                event_state,
                self._persist_event_state,
            )
            return 0

        # Never read past an older unsent notification.  Cursor advancement and
        # all per-chat deliveries are atomically persisted by DurableEventState
        # before the first outbound Telegram call.
        first = event_state.drain(
            send_notification,
            self._persist_event_state,
            is_permanent=is_permanent_chat_failure,
            is_authorized=notification_is_authorized,
            max_deliveries=MAX_NOTIFICATION_DELIVERIES_PER_CHECK,
        )
        first_processed = first.sent + first.dead_lettered
        remaining_budget = MAX_NOTIFICATION_DELIVERIES_PER_CHECK - first_processed
        if event_state.pending_deliveries or remaining_budget == 0:
            return first.sent
        poll_event_batch(
            self.event_reader,
            event_state,
            self.config.notification_chat_ids,
            self._persist_event_state,
            owner_chat_ids=self.config.owner_notification_chat_ids,
        )
        second = event_state.drain(
            send_notification,
            self._persist_event_state,
            is_permanent=is_permanent_chat_failure,
            is_authorized=notification_is_authorized,
            max_deliveries=remaining_budget,
        )
        return first.sent + second.sent

    def close(self) -> None:
        reader = self.event_reader
        self.event_reader = None
        if reader is not None:
            reader.close()

    def _retry_delay(self, failures: int, error: TelegramApiError | None) -> float:
        if error is not None and error.retry_after is not None:
            # Telegram's retry_after is authoritative.  Sleeping less would
            # immediately trigger another 429 and worsen the rate limit.
            return max(1.0, error.retry_after)
        return min(60.0, float(2 ** min(failures, 5)))

    def run(
        self,
        *,
        stop_event: threading.Event | None = None,
        max_iterations: int | None = None,
    ) -> None:
        if max_iterations is not None and (
            not _is_plain_int(max_iterations) or max_iterations < 0
        ):
            raise ValueError("max_iterations must be a non-negative integer")
        failures = 0
        iterations = 0
        started = False
        self._active_stop_event = stop_event
        try:
            while stop_event is None or not stop_event.is_set():
                if max_iterations is not None and iterations >= max_iterations:
                    return
                iterations += 1
                try:
                    if not started:
                        self.startup()
                        started = True
                    self.poll_once()
                    now = self.clock()
                    if now >= self._next_status_at:
                        self.check_notifications()
                        self._next_status_at = now + self.config.status_interval_seconds
                    failures = 0
                except _StopRequested:
                    return
                except TelegramApiError as exc:
                    if not exc.retriable:
                        raise
                    failures += 1
                    delay = self._retry_delay(failures, exc)
                    if stop_event is not None:
                        stop_event.wait(delay)
                    else:
                        self.sleeper(delay)
                except (
                    EventSourceChangedError,
                    EventSchemaError,
                    EventCursorRollbackError,
                    EventDataError,
                    EventStateError,
                ):
                    # These are durable identity/integrity violations.  Retrying
                    # them forever could silently skip or misattribute events.
                    raise
                except EventReaderError:
                    failures += 1
                    delay = self._retry_delay(failures, None)
                    if stop_event is not None:
                        stop_event.wait(delay)
                    else:
                        self.sleeper(delay)
                except ProtocolError:
                    failures += 1
                    delay = self._retry_delay(failures, None)
                    if stop_event is not None:
                        stop_event.wait(delay)
                    else:
                        self.sleeper(delay)
        finally:
            self._active_stop_event = None


def _build_bot_from_config(telegram_config: TelegramConfig) -> TelegramBot:
    gpuq_config = Config.from_json(telegram_config.gpuq_config)
    event_reader = EventReader(gpuq_config)
    try:
        state = BotState.load_for_event_reader(
            telegram_config.state_path,
            event_reader,
        )
        rpc = Client(
            gpuq_config.socket_path,
            timeout=10.0,
            max_request_bytes=gpuq_config.max_request_bytes,
        )
        return TelegramBot(
            telegram_config,
            TelegramTransport(
                telegram_config.bot_token,
                https_proxy=telegram_config.https_proxy,
            ),
            rpc,
            state=state,
            event_reader=event_reader,
        )
    except BaseException:
        event_reader.close()
        raise


def build_bot(config_path: str | Path) -> TelegramBot:
    return _build_bot_from_config(TelegramConfig.from_json(config_path))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gpuq-telegram",
        description="Read-only Telegram interface for gpuq",
    )
    parser.add_argument("--config", required=True, help="0600 Telegram JSON config")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: FrameType | None) -> None:
        stop_event.set()

    bot: TelegramBot | None = None
    try:
        telegram_config = TelegramConfig.from_json(args.config)
        # The same single-instance lock protects state loading and any
        # schema-identity migration, not only the later polling loop.  Two
        # concurrent starts therefore cannot overwrite a newer cursor/outbox
        # with a stale pre-migration snapshot.
        with StateFileLock(telegram_config.state_path):
            bot = _build_bot_from_config(telegram_config)
            signal.signal(signal.SIGTERM, request_stop)
            signal.signal(signal.SIGINT, request_stop)
            bot.run(stop_event=stop_event)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"gpuq-telegram: {exc}", file=sys.stderr)
        return 1
    finally:
        if bot is not None:
            bot.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
