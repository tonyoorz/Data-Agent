from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections.abc import Callable, Mapping
from typing import Any


ACTOR_CAPABILITY_HEADER = "X-Vizion-Agent-Actor-Capability"
ACTOR_CAPABILITY_VERSION = "v1"
ACTOR_CAPABILITY_AUDIENCE = "vizion-analytics"
DEFAULT_ACTOR_CAPABILITY_TTL_SECONDS = 60
MAX_ACTOR_CAPABILITY_TTL_SECONDS = 300
MAX_ACTOR_CAPABILITY_CLOCK_SKEW_SECONDS = 5
MAX_TIMESTAMP = 9_007_199_254_740_991
ACTOR_CAPABILITY_SCOPE_KEYS = (
    "workspaceIds",
    "projectIds",
    "teamIds",
    "allowedObjectTypes",
    "allowedPropertyIds",
    "rowPolicyIds",
    "sensitiveFieldPolicyIds",
)

_CAPABILITY_PAYLOAD_KEYS = frozenset({
    "actorId",
    "scopeHash",
    "scopes",
    "issuedAt",
    "expiresAt",
    "nonce",
    "audience",
})
_SCOPE_KEY_SET = frozenset(ACTOR_CAPABILITY_SCOPE_KEYS)
_BASE64URL_PART = re.compile(r"^[A-Za-z0-9_-]+$")
_NONCE_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_CANONICAL_JSON_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_EDGE_WHITESPACE_CODE_POINTS = frozenset({
    *range(0x0009, 0x000E),
    0x0020,
    0x0085,
    0x00A0,
    0x1680,
    *range(0x2000, 0x200B),
    0x2028,
    0x2029,
    0x202F,
    0x205F,
    0x3000,
    0xFEFF,
})


class ActorCapabilityError(ValueError):
    def __init__(self, code: str, status_code: int = 403) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _invalid_capability() -> ActorCapabilityError:
    return ActorCapabilityError("ACTOR_CAPABILITY_INVALID")


def _expired_capability() -> ActorCapabilityError:
    return ActorCapabilityError("ACTOR_CAPABILITY_EXPIRED")


def _configuration_error() -> ActorCapabilityError:
    return ActorCapabilityError("ACTOR_CAPABILITY_CONFIGURATION_INVALID", 503)


def _is_ascii_http_ows(character: str) -> bool:
    return character == " " or character == "\t"


def _normalize_actor_capability_header_value(value: Any) -> str:
    if not isinstance(value, str):
        raise _invalid_capability()

    start = 0
    end = len(value)
    while start < end and _is_ascii_http_ows(value[start]):
        start += 1
    while end > start and _is_ascii_http_ows(value[end - 1]):
        end -= 1

    normalized = value[start:end]
    if (
        not normalized
        or not 0x21 <= ord(normalized[0]) <= 0x7E
        or not 0x21 <= ord(normalized[-1]) <= 0x7E
    ):
        raise _invalid_capability()
    return normalized


def _has_code_point_length_in_range(value: str, minimum: int, maximum: int) -> bool:
    return minimum <= len(value) <= maximum


def _has_only_unicode_scalars(value: str) -> bool:
    return not any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def _has_forbidden_edge_whitespace(value: str) -> bool:
    return bool(value) and (
        ord(value[0]) in _EDGE_WHITESPACE_CODE_POINTS
        or ord(value[-1]) in _EDGE_WHITESPACE_CODE_POINTS
    )


def _is_normalized_text(value: Any) -> bool:
    return (
        isinstance(value, str)
        and _has_only_unicode_scalars(value)
        and _has_code_point_length_in_range(value, 1, 256)
        and not _has_forbidden_edge_whitespace(value)
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _require_normalized_text(value: Any) -> str:
    if not _is_normalized_text(value):
        raise _invalid_capability()
    return value


def _normalize_scopes(scopes: Any, *, require_normalized: bool) -> dict[str, list[str]]:
    if not isinstance(scopes, dict):
        raise _invalid_capability()
    scope_keys = set(scopes)
    if "allowedObjectTypes" not in scope_keys or not scope_keys <= _SCOPE_KEY_SET:
        raise _invalid_capability()

    normalized_scopes: dict[str, list[str]] = {}
    for key in ACTOR_CAPABILITY_SCOPE_KEYS:
        if key not in scopes:
            continue
        values = scopes[key]
        if not isinstance(values, list) or not values:
            raise _invalid_capability()

        try:
            normalized_values = sorted(
                (_require_normalized_text(value) for value in values),
                key=lambda value: value.encode("utf-8"),
            )
        except UnicodeEncodeError:
            raise _invalid_capability() from None
        if len(set(normalized_values)) != len(normalized_values):
            raise _invalid_capability()
        if key == "allowedObjectTypes" and any("*" in value for value in normalized_values):
            raise _invalid_capability()
        if require_normalized and values != normalized_values:
            raise _invalid_capability()

        normalized_scopes[key] = normalized_values
    return normalized_scopes


def _normalize_actor(actor: Any) -> dict[str, Any]:
    if not isinstance(actor, Mapping):
        raise _invalid_capability()
    return {
        "actorId": _require_normalized_text(actor.get("actorId")),
        "scopeHash": _require_normalized_text(actor.get("scopeHash")),
        "scopes": _normalize_scopes(actor.get("scopes"), require_normalized=False),
    }


def _resolve_now(now: int | Callable[[], int] | None) -> int:
    resolved_now = now() if callable(now) else now
    if resolved_now is None:
        resolved_now = int(time.time())
    if (
        isinstance(resolved_now, bool)
        or not isinstance(resolved_now, int)
        or resolved_now < 0
        or resolved_now > MAX_TIMESTAMP
    ):
        raise _invalid_capability()
    return resolved_now


def _resolve_ttl_seconds(ttl_seconds: int | None) -> int:
    resolved_ttl = DEFAULT_ACTOR_CAPABILITY_TTL_SECONDS if ttl_seconds is None else ttl_seconds
    if (
        isinstance(resolved_ttl, bool)
        or not isinstance(resolved_ttl, int)
        or resolved_ttl < 1
        or resolved_ttl > MAX_ACTOR_CAPABILITY_TTL_SECONDS
    ):
        raise _configuration_error()
    return resolved_ttl


def _require_secret(secret: Any) -> str:
    if not isinstance(secret, str) or not secret.strip():
        raise _configuration_error()
    return secret


def _resolve_secret(secret: str | None, env: Mapping[str, str] | None) -> str:
    return _require_secret(secret) if secret is not None else get_agent_actor_capability_secret(env)


def _require_nonce(nonce: Any) -> str:
    if (
        not _is_normalized_text(nonce)
        or _NONCE_PATTERN.fullmatch(nonce) is None
        or not _has_code_point_length_in_range(nonce, 16, 128)
    ):
        raise _invalid_capability()
    return nonce


def _resolve_nonce(nonce: str | None, nonce_factory: Callable[[], str] | None) -> str:
    if nonce is not None:
        return _require_nonce(nonce)
    if nonce_factory is not None:
        if not callable(nonce_factory):
            raise _configuration_error()
        return _require_nonce(nonce_factory())
    return _require_nonce(secrets.token_urlsafe(18))


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_base64url(part: Any) -> bytes:
    if not isinstance(part, str) or _BASE64URL_PART.fullmatch(part) is None or len(part) % 4 == 1:
        raise _invalid_capability()
    try:
        decoded = base64.b64decode(
            part + "=" * (-len(part) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, binascii.Error):
        raise _invalid_capability() from None
    if not hmac.compare_digest(_encode_base64url(decoded), part):
        raise _invalid_capability()
    return decoded


def _sign(signing_input: str, secret: str) -> bytes:
    try:
        return hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    except UnicodeEncodeError:
        raise _invalid_capability() from None


def _parse_canonical_json_integer(token: str) -> int:
    if _CANONICAL_JSON_INTEGER.fullmatch(token) is None:
        raise ValueError("noncanonical JSON integer")
    return int(token)


def _reject_noncanonical_json_number(token: str) -> Any:
    raise ValueError(f"noncanonical JSON number: {token}")


def _parse_payload(payload_bytes: bytes, now: int) -> dict[str, Any]:
    if payload_bytes.startswith(b"\xef\xbb\xbf"):
        raise _invalid_capability()
    try:
        payload = json.loads(
            payload_bytes.decode("utf-8"),
            parse_int=_parse_canonical_json_integer,
            parse_float=_reject_noncanonical_json_number,
            parse_constant=_reject_noncanonical_json_number,
        )
    except (UnicodeDecodeError, ValueError):
        raise _invalid_capability() from None
    if not isinstance(payload, dict) or set(payload) != _CAPABILITY_PAYLOAD_KEYS:
        raise _invalid_capability()

    actor_id = _require_normalized_text(payload.get("actorId"))
    scope_hash = _require_normalized_text(payload.get("scopeHash"))
    scopes = _normalize_scopes(payload.get("scopes"), require_normalized=True)
    if payload.get("audience") != ACTOR_CAPABILITY_AUDIENCE:
        raise _invalid_capability()

    issued_at = payload.get("issuedAt")
    expires_at = payload.get("expiresAt")
    if (
        isinstance(issued_at, bool)
        or isinstance(expires_at, bool)
        or not isinstance(issued_at, int)
        or not isinstance(expires_at, int)
        or issued_at < 0
        or issued_at > MAX_TIMESTAMP
        or expires_at > MAX_TIMESTAMP
        or expires_at <= issued_at
        or expires_at - issued_at > MAX_ACTOR_CAPABILITY_TTL_SECONDS
    ):
        raise _invalid_capability()
    if issued_at > now + MAX_ACTOR_CAPABILITY_CLOCK_SKEW_SECONDS:
        raise _invalid_capability()
    if expires_at <= now:
        raise _expired_capability()

    nonce = _require_nonce(payload.get("nonce"))
    return {
        "actorId": actor_id,
        "scopeHash": scope_hash,
        "scopes": scopes,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "nonce": nonce,
        "audience": ACTOR_CAPABILITY_AUDIENCE,
    }


def get_agent_actor_capability_secret(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    return _require_secret(source.get("VIZION_AGENT_ACTOR_CAPABILITY_SECRET"))


def create_actor_capability(
    actor: Mapping[str, Any],
    *,
    secret: str | None = None,
    env: Mapping[str, str] | None = None,
    now: int | Callable[[], int] | None = None,
    nonce: str | None = None,
    nonce_factory: Callable[[], str] | None = None,
    ttl_seconds: int | None = None,
) -> str:
    resolved_secret = _resolve_secret(secret, env)
    issued_at = _resolve_now(now)
    normalized_actor = _normalize_actor(actor)
    resolved_ttl = _resolve_ttl_seconds(ttl_seconds)
    if issued_at > MAX_TIMESTAMP - resolved_ttl:
        raise _invalid_capability()
    resolved_nonce = _resolve_nonce(nonce, nonce_factory)
    payload = {
        "actorId": normalized_actor["actorId"],
        "scopeHash": normalized_actor["scopeHash"],
        "scopes": normalized_actor["scopes"],
        "issuedAt": issued_at,
        "expiresAt": issued_at + resolved_ttl,
        "nonce": resolved_nonce,
        "audience": ACTOR_CAPABILITY_AUDIENCE,
    }
    try:
        payload_part = _encode_base64url(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
    except UnicodeEncodeError:
        raise _invalid_capability() from None
    signing_input = f"{ACTOR_CAPABILITY_VERSION}.{payload_part}"
    return f"{signing_input}.{_encode_base64url(_sign(signing_input, resolved_secret))}"


def verify_actor_capability(
    token: str,
    *,
    secret: str | None = None,
    env: Mapping[str, str] | None = None,
    now: int | Callable[[], int] | None = None,
) -> dict[str, Any]:
    resolved_secret = _resolve_secret(secret, env)
    resolved_now = _resolve_now(now)
    if not isinstance(token, str):
        raise _invalid_capability()
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != ACTOR_CAPABILITY_VERSION:
        raise _invalid_capability()

    _, payload_part, signature_part = parts
    payload_bytes = _decode_base64url(payload_part)
    received_signature = _decode_base64url(signature_part)
    expected_signature = _sign(f"{ACTOR_CAPABILITY_VERSION}.{payload_part}", resolved_secret)
    if len(received_signature) != len(expected_signature) or not hmac.compare_digest(received_signature, expected_signature):
        raise _invalid_capability()
    return _parse_payload(payload_bytes, resolved_now)


def extract_actor_capability_header(headers: Mapping[str, Any]) -> str:
    if not isinstance(headers, Mapping):
        raise ActorCapabilityError("ACTOR_CAPABILITY_MISSING", 401)
    values = [
        value
        for key, value in headers.items()
        if isinstance(key, str) and key.lower() == ACTOR_CAPABILITY_HEADER.lower()
    ]
    if not values:
        raise ActorCapabilityError("ACTOR_CAPABILITY_MISSING", 401)
    if len(values) != 1:
        raise _invalid_capability()
    return _normalize_actor_capability_header_value(values[0])


def verify_actor_capability_header(
    headers: Mapping[str, Any],
    *,
    secret: str | None = None,
    env: Mapping[str, str] | None = None,
    now: int | Callable[[], int] | None = None,
) -> dict[str, Any]:
    return verify_actor_capability(
        extract_actor_capability_header(headers),
        secret=secret,
        env=env,
        now=now,
    )


_DEFECT_OBJECT_TYPE_ALIASES = frozenset({"quality.defect", "defect", "quality-defect"})
_TESTING_TEAM_OBJECT_TYPE_ALIASES = frozenset({"quality.defect", "defect", "quality-defect", "testing.manual_run", "manual_run"})


def _normalize_defect_scope_team(value: str) -> str:
    return "DTSV_China" if value.casefold() in {"dtsv", "dtsv_china"} else value


def _normalize_defect_filter_values(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_values = value.split(",")
    elif isinstance(value, list):
        raw_values = value
    else:
        raise ActorCapabilityError("AGENT_DEFECT_QUERY_INVALID", 400)

    normalized = [_require_normalized_text(item) for item in raw_values]
    if not normalized:
        raise ActorCapabilityError("AGENT_DEFECT_QUERY_INVALID", 400)
    return normalized


def _merge_defect_scope_filter(
    filters: dict[str, Any],
    *,
    field_name: str,
    allowed_values: list[str],
) -> None:
    if not allowed_values:
        return
    if field_name not in filters:
        filters[field_name] = list(allowed_values)
        return

    requested_values = _normalize_defect_filter_values(filters[field_name])
    if any(value not in allowed_values for value in requested_values):
        raise ActorCapabilityError("ACTOR_CAPABILITY_SCOPE_DENIED", 403)
    filters[field_name] = requested_values


def enforce_defect_query_scope(raw_payload: Any, actor: Mapping[str, Any]) -> dict[str, Any]:
    """Inject mandatory defect row filters from a verified actor capability."""

    if not isinstance(raw_payload, Mapping):
        raise ActorCapabilityError("AGENT_DEFECT_QUERY_INVALID", 400)
    if {"agent_actor_scope_hash", "agent_drilldown_secret"} & set(raw_payload):
        raise ActorCapabilityError("AGENT_DEFECT_QUERY_INVALID", 400)
    scopes = actor.get("scopes")
    if not isinstance(scopes, Mapping):
        raise _invalid_capability()

    allowed_object_types = scopes.get("allowedObjectTypes")
    if not isinstance(allowed_object_types, list) or not {
        str(value).casefold() for value in allowed_object_types
    } & _DEFECT_OBJECT_TYPE_ALIASES:
        raise ActorCapabilityError("ACTOR_CAPABILITY_OBJECT_SCOPE_DENIED", 403)

    raw_filters = raw_payload.get("filters", {})
    if not isinstance(raw_filters, Mapping):
        raise ActorCapabilityError("AGENT_DEFECT_QUERY_INVALID", 400)
    filters = dict(raw_filters)

    team_values = scopes.get("teamIds") or scopes.get("workspaceIds") or []
    project_values = scopes.get("projectIds") or []
    if not isinstance(team_values, list) or not isinstance(project_values, list):
        raise _invalid_capability()

    normalized_teams = [_normalize_defect_scope_team(_require_normalized_text(value)) for value in team_values]
    normalized_projects = [_require_normalized_text(value) for value in project_values]
    if not normalized_teams and not normalized_projects:
        raise ActorCapabilityError("ACTOR_CAPABILITY_ROW_SCOPE_REQUIRED", 403)

    _merge_defect_scope_filter(
        filters,
        field_name="problem_finder_teams",
        allowed_values=normalized_teams,
    )
    _merge_defect_scope_filter(
        filters,
        field_name="projects",
        allowed_values=normalized_projects,
    )

    payload = dict(raw_payload)
    payload["filters"] = filters
    return payload


def _normalize_team_analysis_values(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_values = [value]
    elif isinstance(value, list):
        raw_values = value
    else:
        raise ActorCapabilityError("AGENT_TESTING_TEAM_QUERY_INVALID", 400)
    return [_require_normalized_text(item) for item in raw_values]


def enforce_testing_team_fv_analysis_scope(raw_payload: Any, actor: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a team-FV analysis request against the verified actor capability."""

    if not isinstance(raw_payload, Mapping) or set(raw_payload) - {"team", "years", "test_weeks"}:
        raise ActorCapabilityError("AGENT_TESTING_TEAM_QUERY_INVALID", 400)

    scopes = actor.get("scopes")
    if not isinstance(scopes, Mapping):
        raise _invalid_capability()

    allowed_object_types = scopes.get("allowedObjectTypes")
    if not isinstance(allowed_object_types, list) or not {
        str(value).casefold() for value in allowed_object_types
    } & _TESTING_TEAM_OBJECT_TYPE_ALIASES:
        raise ActorCapabilityError("ACTOR_CAPABILITY_OBJECT_SCOPE_DENIED", 403)

    team = _normalize_defect_scope_team(_require_normalized_text(raw_payload.get("team")))
    team_values = scopes.get("teamIds") or scopes.get("workspaceIds") or []
    if not isinstance(team_values, list):
        raise _invalid_capability()
    allowed_teams = [_normalize_defect_scope_team(_require_normalized_text(value)) for value in team_values]
    if not allowed_teams:
        raise ActorCapabilityError("ACTOR_CAPABILITY_ROW_SCOPE_REQUIRED", 403)
    if team not in allowed_teams:
        raise ActorCapabilityError("ACTOR_CAPABILITY_SCOPE_DENIED", 403)

    payload: dict[str, Any] = {"team": team}
    for field_name in ("years", "test_weeks"):
        if field_name in raw_payload:
            payload[field_name] = _normalize_team_analysis_values(raw_payload[field_name])
    return payload