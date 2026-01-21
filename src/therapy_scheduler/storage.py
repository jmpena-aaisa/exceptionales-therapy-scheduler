from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


class StorageError(RuntimeError):
    pass


_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class StorageSettings:
    backend: str
    local_root: Path
    gcs_bucket: Optional[str]
    gcs_prefix: str


def load_storage_settings() -> StorageSettings:
    backend = os.getenv("SCHEDULER_STORAGE_BACKEND", "local").lower().strip()
    local_root = Path(os.getenv("SCHEDULER_STORAGE_ROOT", "output"))
    gcs_bucket = os.getenv("SCHEDULER_GCS_BUCKET")
    gcs_prefix = os.getenv("SCHEDULER_GCS_PREFIX", "").strip("/")
    return StorageSettings(
        backend=backend,
        local_root=local_root,
        gcs_bucket=gcs_bucket,
        gcs_prefix=gcs_prefix,
    )


def validate_id(value: str, label: str) -> str:
    if not _ID_RE.match(value):
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def session_prefix(user_id: str, session_id: str) -> str:
    safe_user = validate_id(user_id, "user_id")
    safe_session = validate_id(session_id, "session_id")
    return f"sessions/{safe_user}/{safe_session}"


class BaseStorage:
    def write_text(self, key: str, text: str, content_type: Optional[str] = None) -> None:
        raise NotImplementedError

    def read_text(self, key: str) -> str:
        raise NotImplementedError

    def write_bytes(self, key: str, data: bytes, content_type: Optional[str] = None) -> None:
        raise NotImplementedError

    def read_bytes(self, key: str) -> bytes:
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def list_prefix(self, prefix: str) -> List[str]:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError

    def write_json(self, key: str, payload: object) -> None:
        self.write_text(key, json.dumps(payload, indent=2), content_type="application/json")

    def read_json(self, key: str) -> object:
        return json.loads(self.read_text(key))


class LocalStorage(BaseStorage):
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        path = Path(key)
        if path.is_absolute() or ".." in path.parts:
            raise StorageError(f"Invalid storage key: {key}")
        return self.root / path

    def write_text(self, key: str, text: str, content_type: Optional[str] = None) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def read_text(self, key: str) -> str:
        return self._path(key).read_text()

    def write_bytes(self, key: str, data: bytes, content_type: Optional[str] = None) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def read_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def list_prefix(self, prefix: str) -> List[str]:
        root = self._path(prefix)
        if not root.exists():
            return []
        if root.is_file():
            return [str(root.relative_to(self.root))]
        keys: List[str] = []
        for path in root.rglob("*"):
            if path.is_file():
                keys.append(str(path.relative_to(self.root)))
        return keys

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.exists():
            path.unlink()


class GCSStorage(BaseStorage):
    def __init__(self, bucket_name: str, prefix: str = "") -> None:
        from google.cloud import storage

        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket_name)
        self.prefix = prefix.strip("/")

    def _blob_name(self, key: str) -> str:
        if key.startswith("/"):
            raise StorageError(f"Invalid storage key: {key}")
        if self.prefix:
            return f"{self.prefix}/{key}"
        return key

    def write_text(self, key: str, text: str, content_type: Optional[str] = None) -> None:
        blob = self.bucket.blob(self._blob_name(key))
        blob.upload_from_string(text, content_type=content_type)

    def read_text(self, key: str) -> str:
        blob = self.bucket.blob(self._blob_name(key))
        return blob.download_as_text()

    def write_bytes(self, key: str, data: bytes, content_type: Optional[str] = None) -> None:
        blob = self.bucket.blob(self._blob_name(key))
        blob.upload_from_string(data, content_type=content_type)

    def read_bytes(self, key: str) -> bytes:
        blob = self.bucket.blob(self._blob_name(key))
        return blob.download_as_bytes()

    def exists(self, key: str) -> bool:
        blob = self.bucket.blob(self._blob_name(key))
        return blob.exists()

    def list_prefix(self, prefix: str) -> List[str]:
        if prefix.startswith("/"):
            raise StorageError(f"Invalid storage key: {prefix}")
        blob_prefix = self._blob_name(prefix)
        keys: List[str] = []
        for blob in self.client.list_blobs(self.bucket, prefix=blob_prefix):
            name = blob.name
            if self.prefix:
                prefix_root = f"{self.prefix}/"
                if not name.startswith(prefix_root):
                    continue
                name = name[len(prefix_root) :]
            keys.append(name)
        return keys

    def delete(self, key: str) -> None:
        from google.api_core.exceptions import NotFound

        blob = self.bucket.blob(self._blob_name(key))
        try:
            blob.delete()
        except NotFound:
            return


def get_storage(settings: Optional[StorageSettings] = None) -> BaseStorage:
    settings = settings or load_storage_settings()
    if settings.backend == "local":
        return LocalStorage(settings.local_root)
    if settings.backend == "gcs":
        if not settings.gcs_bucket:
            raise StorageError("SCHEDULER_GCS_BUCKET is required for gcs storage backend.")
        return GCSStorage(settings.gcs_bucket, settings.gcs_prefix)
    raise StorageError(f"Unknown storage backend: {settings.backend}")
