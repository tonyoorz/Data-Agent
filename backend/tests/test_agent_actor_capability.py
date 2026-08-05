from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from backend.analytics.agent_actor_capability import (
    ACTOR_CAPABILITY_HEADER,
    ActorCapabilityError,
    create_actor_capability,
    extract_actor_capability_header,
    get_agent_actor_capability_secret,
    verify_actor_capability,
    verify_actor_capability_header,
)


TEST_SECRET = "test-actor-capability-secret"
FIXED_NOW = 1_700_000_000
TEST_NONCE = "nonce-test-123456789"
STATIC_SECRET = "static-cross-language-secret"
STATIC_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":1700000000,\"expiresAt\":1700000060,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}"
STATIC_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzAwMDAwMDYwLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.EWB62IJ54BrSaLOefgcC1OnrNYPcyxzNlgo1bPKrVLQ"
EXPONENT_TIMESTAMP_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":1e3,\"expiresAt\":1060,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}"
EXPONENT_TIMESTAMP_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6MWUzLCJleHBpcmVzQXQiOjEwNjAsIm5vbmNlIjoibm9uY2Utc3RhdGljLTEyMzQ1Njc4IiwiYXVkaWVuY2UiOiJ2aXppb24tYW5hbHl0aWNzIn0.NGliSy8-EZ0XWDJ3ghJVjOZwllfdrQ1FTfT1_gV5cv4"

MAX_TIMESTAMP = 9_007_199_254_740_991
ABOVE_MAX_TIMESTAMP_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":9007199254740992,\"expiresAt\":9007199254740993,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}"
ABOVE_MAX_TIMESTAMP_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6OTAwNzE5OTI1NDc0MDk5MiwiZXhwaXJlc0F0Ijo5MDA3MTk5MjU0NzQwOTkzLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.PoKlEIv8pHrW_2cM6QJJAePa0mlywSkU52mlWUmF67k"
LONE_SURROGATE_SCOPE_PAYLOAD = r'{"actorId":"actor","scopeHash":"hash","scopes":{"workspaceIds":["\ud800"],"allowedObjectTypes":["thing"]},"issuedAt":1700000000,"expiresAt":1700000060,"nonce":"nonce-static-12345678","audience":"vizion-analytics"}'
LONE_SURROGATE_SCOPE_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3IiLCJzY29wZUhhc2giOiJoYXNoIiwic2NvcGVzIjp7IndvcmtzcGFjZUlkcyI6WyJcdWQ4MDAiXSwiYWxsb3dlZE9iamVjdFR5cGVzIjpbInRoaW5nIl19LCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzAwMDAwMDYwLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.KBByAZUhruVPg_03MzRj2ZC1jIYNbqXGXHNq4vyiyqg"
FORBIDDEN_EDGE_WHITESPACE = ("\u0085", "\ufeff")

ACTOR = {
    "actorId": "actor-test",
    "scopeHash": "scope-hash-test",
    "scopes": {
        "workspaceIds": ["workspace-a"],
        "projectIds": ["project-b", "project-a"],
        "teamIds": ["team-a"],
        "allowedObjectTypes": ["quality.defect"],
        "allowedPropertyIds": ["defect.status"],
        "rowPolicyIds": ["quality-readonly"],
        "sensitiveFieldPolicyIds": ["mask-reporter"],
    },
}


def sign_test_payload(payload: dict[str, object], secret: str = TEST_SECRET) -> str:
    payload_part = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    signing_input = f"v1.{payload_part}"
    signature_part = base64.urlsafe_b64encode(
        hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    return f"{signing_input}.{signature_part}"


def test_python_creator_round_trips_a_normalized_capability() -> None:
    token = create_actor_capability(
        ACTOR,
        secret=TEST_SECRET,
        now=FIXED_NOW,
        nonce=TEST_NONCE,
    )

    assert verify_actor_capability(token, secret=TEST_SECRET, now=FIXED_NOW + 1) == {
        **ACTOR,
        "scopes": {
            **ACTOR["scopes"],
            "projectIds": ["project-a", "project-b"],
        },
        "issuedAt": FIXED_NOW,
        "expiresAt": FIXED_NOW + 60,
        "nonce": TEST_NONCE,
        "audience": "vizion-analytics",
    }


def test_python_verifier_accepts_the_fixed_cross_language_wire_format_vector() -> None:
    assert verify_actor_capability(
        STATIC_TOKEN,
        secret=STATIC_SECRET,
        now=1_700_000_001,
    ) == json.loads(STATIC_PAYLOAD)


def test_python_verifier_rejects_the_fixed_cross_language_exponent_timestamp_vector() -> None:
    assert '"issuedAt":1e3' in EXPONENT_TIMESTAMP_PAYLOAD

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability(
            EXPONENT_TIMESTAMP_TOKEN,
            secret=STATIC_SECRET,
            now=1_001,
        )


def test_creator_rejects_a_timestamp_when_its_ttl_exceeds_the_shared_maximum() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        create_actor_capability(
            ACTOR,
            secret=TEST_SECRET,
            now=MAX_TIMESTAMP,
            ttl_seconds=1,
            nonce=TEST_NONCE,
        )


def test_verifier_rejects_the_hardcoded_cross_language_vector_with_timestamps_above_the_shared_maximum() -> None:
    assert '"issuedAt":9007199254740992' in ABOVE_MAX_TIMESTAMP_PAYLOAD

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability(
            ABOVE_MAX_TIMESTAMP_TOKEN,
            secret=STATIC_SECRET,
            now=MAX_TIMESTAMP,
        )


def test_header_extractor_reads_a_case_insensitive_mapping() -> None:
    assert extract_actor_capability_header({
        ACTOR_CAPABILITY_HEADER.lower(): STATIC_TOKEN,
    }) == STATIC_TOKEN


def test_header_extractor_accepts_ascii_space_and_horizontal_tab_padding() -> None:
    assert extract_actor_capability_header({
        ACTOR_CAPABILITY_HEADER: f" \t{STATIC_TOKEN}\t ",
    }) == STATIC_TOKEN


@pytest.mark.parametrize("edge_whitespace", FORBIDDEN_EDGE_WHITESPACE)
def test_header_extractor_rejects_non_ascii_padding(edge_whitespace: str) -> None:
    for malformed_header in (f"{edge_whitespace}{STATIC_TOKEN}", f"{STATIC_TOKEN}{edge_whitespace}"):
        with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
            extract_actor_capability_header({ACTOR_CAPABILITY_HEADER: malformed_header})


def test_header_verifier_rejects_a_missing_capability() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_MISSING"):
        verify_actor_capability_header({}, secret=STATIC_SECRET, now=1_700_000_001)


def test_header_verifier_rejects_a_malformed_capability() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability_header(
            {ACTOR_CAPABILITY_HEADER: "not-a-capability"},
            secret=STATIC_SECRET,
            now=1_700_000_001,
        )


def test_header_verifier_rejects_a_tampered_capability() -> None:
    tampered_token = f"{STATIC_TOKEN[:-1]}A"

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability_header(
            {ACTOR_CAPABILITY_HEADER: tampered_token},
            secret=STATIC_SECRET,
            now=1_700_000_001,
        )


def test_header_verifier_rejects_an_expired_capability() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_EXPIRED"):
        verify_actor_capability_header(
            {ACTOR_CAPABILITY_HEADER: STATIC_TOKEN},
            secret=STATIC_SECRET,
            now=1_700_000_061,
        )


def test_verifier_rejects_a_validly_signed_wrong_audience() -> None:
    payload = json.loads(STATIC_PAYLOAD)
    payload["audience"] = "other-service"

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability(
            sign_test_payload(payload, STATIC_SECRET),
            secret=STATIC_SECRET,
            now=1_700_000_001,
        )


def test_verifier_rejects_a_validly_signed_wildcard_object_type() -> None:
    payload = json.loads(STATIC_PAYLOAD)
    payload["scopes"]["allowedObjectTypes"] = ["*"]

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability(
            sign_test_payload(payload, STATIC_SECRET),
            secret=STATIC_SECRET,
            now=1_700_000_001,
        )


@pytest.mark.parametrize("edge_whitespace", FORBIDDEN_EDGE_WHITESPACE)
def test_creator_rejects_explicit_edge_whitespace_in_every_signed_text_input(edge_whitespace: str) -> None:
    malformed_actors = (
        {**ACTOR, "actorId": f"{edge_whitespace}actor-test"},
        {**ACTOR, "scopeHash": f"{edge_whitespace}scope-hash-test"},
        {
            **ACTOR,
            "scopes": {
                **ACTOR["scopes"],
                "workspaceIds": [f"{edge_whitespace}workspace-a"],
            },
        },
    )

    for malformed_actor in malformed_actors:
        with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
            create_actor_capability(
                malformed_actor,
                secret=TEST_SECRET,
                now=FIXED_NOW,
                nonce=TEST_NONCE,
            )

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        create_actor_capability(
            ACTOR,
            secret=TEST_SECRET,
            now=FIXED_NOW,
            nonce=f"{edge_whitespace}{TEST_NONCE}",
        )


def test_creator_rejects_a_lone_surrogate_before_signing() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        create_actor_capability(
            {**ACTOR, "actorId": "\ud800"},
            secret=TEST_SECRET,
            now=FIXED_NOW,
            nonce=TEST_NONCE,
        )


def test_verifier_rejects_the_hardcoded_signed_raw_vector_with_an_escaped_lone_surrogate_scope() -> None:
    version, payload_part, signature_part = LONE_SURROGATE_SCOPE_TOKEN.split(".")
    assert "\\ud800" in LONE_SURROGATE_SCOPE_PAYLOAD
    assert base64.urlsafe_b64decode(payload_part + "=" * (-len(payload_part) % 4)).decode("utf-8") == LONE_SURROGATE_SCOPE_PAYLOAD
    expected_signature = base64.urlsafe_b64encode(
        hmac.new(
            STATIC_SECRET.encode("utf-8"),
            f"{version}.{payload_part}".encode("ascii"),
            hashlib.sha256,
        ).digest()
    ).rstrip(b"=").decode("ascii")
    assert signature_part == expected_signature

    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        verify_actor_capability(
            LONE_SURROGATE_SCOPE_TOKEN,
            secret=STATIC_SECRET,
            now=FIXED_NOW + 1,
        )


def test_creator_uses_unicode_code_points_for_normalized_text_length_limits() -> None:
    at_limit = "\U0001F642" * 256
    unicode_actor = {
        "actorId": at_limit,
        "scopeHash": at_limit,
        "scopes": {
            "workspaceIds": [at_limit],
            "allowedObjectTypes": [at_limit],
        },
    }
    token = create_actor_capability(
        unicode_actor,
        secret=TEST_SECRET,
        now=FIXED_NOW,
        nonce=TEST_NONCE,
    )

    verified = verify_actor_capability(token, secret=TEST_SECRET, now=FIXED_NOW + 1)
    assert verified["actorId"] == at_limit
    assert verified["scopeHash"] == at_limit
    assert verified["scopes"] == unicode_actor["scopes"]
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_INVALID"):
        create_actor_capability(
            {**unicode_actor, "actorId": f"{at_limit}\U0001F642"},
            secret=TEST_SECRET,
            now=FIXED_NOW,
            nonce=TEST_NONCE,
        )


def test_missing_secret_is_a_server_configuration_error() -> None:
    with pytest.raises(ActorCapabilityError, match="ACTOR_CAPABILITY_CONFIGURATION_INVALID") as error:
        get_agent_actor_capability_secret({})

    assert error.value.status_code == 503