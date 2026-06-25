"""
Firebase Admin SDK initialization — shared singleton.

Credentials are loaded from a service-account JSON, located via either:
  • FIREBASE_SERVICE_ACCOUNT  — the JSON *contents* (handy for env-only deploys), or
  • GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_PATH — a path to the file.

The default Storage bucket is taken from FIREBASE_STORAGE_BUCKET (no gs:// prefix).
"""

import json
import os
import threading

import firebase_admin
from firebase_admin import credentials

_LOCK = threading.Lock()
_APP = None


def _load_credentials() -> credentials.Base:
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT")
    if raw:
        return credentials.Certificate(json.loads(raw))

    path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH") or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if path and os.path.exists(path):
        return credentials.Certificate(path)

    raise RuntimeError(
        "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT (JSON contents) "
        "or FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS (path to the file)."
    )


def get_app() -> firebase_admin.App:
    """Initialize (once) and return the Firebase Admin app."""
    global _APP
    if _APP is not None:
        return _APP
    with _LOCK:
        if _APP is None:
            options = {}
            bucket = os.getenv("FIREBASE_STORAGE_BUCKET")
            if bucket:
                options["storageBucket"] = bucket
            _APP = firebase_admin.initialize_app(_load_credentials(), options)
    return _APP


def web_api_key() -> str:
    """The Firebase Web API key — used for the email/password REST auth endpoints."""
    key = os.getenv("FIREBASE_WEB_API_KEY")
    if not key:
        raise RuntimeError("FIREBASE_WEB_API_KEY is not set")
    return key
