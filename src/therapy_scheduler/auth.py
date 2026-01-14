from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Iterable, Optional


class AuthError(RuntimeError):
    pass


@dataclass(frozen=True)
class UserRecord:
    user_id: str
    email: str
    password_hash: str
    disabled: bool = False


@dataclass(frozen=True)
class AuthSettings:
    require_auth: bool
    secret: Optional[str]
    token_ttl_seconds: int
    users_path: str


def load_auth_settings() -> AuthSettings:
    require_auth = os.getenv("SCHEDULER_REQUIRE_AUTH", "false").lower() in {"1", "true", "yes"}
    secret = os.getenv("SCHEDULER_AUTH_SECRET")
    token_ttl_seconds = int(os.getenv("SCHEDULER_TOKEN_TTL_SECONDS", "3600"))
    users_path = os.getenv("SCHEDULER_USERS_PATH", "users/users.csv")
    return AuthSettings(
        require_auth=require_auth,
        secret=secret,
        token_ttl_seconds=token_ttl_seconds,
        users_path=users_path,
    )


def parse_users_csv(text: str) -> list[UserRecord]:
    reader = csv.DictReader(text.splitlines())
    users: list[UserRecord] = []
    for row in reader:
        if not row:
            continue
        user_id = (row.get("user_id") or "").strip()
        email = (row.get("email") or "").strip().lower()
        password_hash = (row.get("password_hash") or "").strip()
        disabled_raw = (row.get("disabled") or "").strip().lower()
        disabled = disabled_raw in {"true", "1", "yes"}
        if not user_id or not email or not password_hash:
            continue
        users.append(
            UserRecord(
                user_id=user_id,
                email=email,
                password_hash=password_hash,
                disabled=disabled,
            )
        )
    return users


def find_user(users: Iterable[UserRecord], email: str) -> Optional[UserRecord]:
    target = email.strip().lower()
    return next((u for u in users if u.email == target), None)


def hash_password(password: str, iterations: int = 240_000) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return _format_hash(iterations, salt, dk)


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, iter_str, salt_b64, hash_b64 = stored_hash.split("$", 3)
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    try:
        iterations = int(iter_str)
    except ValueError:
        return False
    salt = _b64decode(salt_b64)
    expected = _b64decode(hash_b64)
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


def issue_token(user_id: str, email: str, secret: str, ttl_seconds: int) -> tuple[str, int]:
    now = int(time.time())
    payload = {"sub": user_id, "email": email, "iat": now, "exp": now + ttl_seconds}
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _b64encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    token = f"{header_b64}.{payload_b64}.{_b64encode(signature)}"
    return token, payload["exp"]


def verify_token(token: str, secret: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthError("Invalid token format.")
    header_b64, payload_b64, signature_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    expected_sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature = _b64decode(signature_b64)
    if not hmac.compare_digest(signature, expected_sig):
        raise AuthError("Invalid token signature.")
    payload = json.loads(_b64decode(payload_b64))
    if int(payload.get("exp", 0)) < int(time.time()):
        raise AuthError("Token expired.")
    return payload


def parse_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    prefix = "bearer "
    if authorization.lower().startswith(prefix):
        return authorization[len(prefix) :].strip()
    return None


def _format_hash(iterations: int, salt: bytes, derived_key: bytes) -> str:
    return "$".join(
        [
            "pbkdf2_sha256",
            str(iterations),
            _b64encode(salt),
            _b64encode(derived_key),
        ]
    )


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)
