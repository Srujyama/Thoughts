"""
One-time migration: Supabase  →  Firebase.

Copies:
  1. Auth users  → Firebase Authentication (email + same uid, NO password —
                   users reset their password on first login).
  2. Storage     → Cloud Storage for Firebase (vault/{uid}/path → {uid}/path).
  3. thoughts    → Firestore "thoughts" collection (preserving id + created_at).

Run locally with BOTH sets of credentials available:

  Supabase (read side) — set in the environment or backend/.env.supabase:
    SUPABASE_URL, SUPABASE_SERVICE_KEY

  Firebase (write side) — set in the environment or backend/.env:
    FIREBASE_SERVICE_ACCOUNT_PATH (or FIREBASE_SERVICE_ACCOUNT), FIREBASE_STORAGE_BUCKET

Usage:
    python migrate_to_firebase.py --dry-run        # report what would happen
    python migrate_to_firebase.py --users          # migrate auth users only
    python migrate_to_firebase.py --storage        # migrate vault files only
    python migrate_to_firebase.py --thoughts       # migrate thoughts table only
    python migrate_to_firebase.py --all            # everything (default)

Idempotent: re-running skips users that already exist and overwrites files /
re-imports thoughts by their original id, so a second run is safe.
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Load Firebase env from backend/.env and optional Supabase env from .env.supabase
HERE = Path(__file__).parent
load_dotenv(HERE / ".env")
load_dotenv(HERE / ".env.supabase")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BUCKET = "vault"


def _require_supabase():
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (read side).")


def _sb_headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


# ── Firebase init (lazy, so --dry-run on Supabase alone still works) ──────────
def _fb():
    from dependencies.firebase import get_app
    from firebase_admin import storage, firestore, auth
    get_app()
    return storage.bucket(), firestore.client(), auth


# ── 1. Users ─────────────────────────────────────────────────────────────────
def migrate_users(dry_run: bool):
    _require_supabase()
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # GoTrue admin list is paginated.
    users = []
    page = 1
    while True:
        resp = sb.auth.admin.list_users(page=page, per_page=1000)
        batch = resp if isinstance(resp, list) else getattr(resp, "users", [])
        if not batch:
            break
        users.extend(batch)
        if len(batch) < 1000:
            break
        page += 1

    print(f"[users] found {len(users)} Supabase users")
    if dry_run:
        for u in users[:10]:
            print(f"  would import uid={u.id} email={u.email}")
        if len(users) > 10:
            print(f"  ... and {len(users) - 10} more")
        return

    _, _, auth = _fb()
    records = [
        auth.ImportUserRecord(uid=u.id, email=u.email, email_verified=True)
        for u in users if u.email
    ]
    imported = 0
    for i in range(0, len(records), 1000):  # 1000/call max
        chunk = records[i:i + 1000]
        result = auth.import_users(chunk)
        imported += result.success_count
        for err in result.errors:
            print(f"  [users] import error at #{err.index}: {err.reason}")
    print(f"[users] imported {imported}/{len(records)} (no passwords — users reset on first login)")


# ── 2. Storage ───────────────────────────────────────────────────────────────
def _sb_list(prefix: str):
    """List a single Supabase Storage level (caps at 100, paginates)."""
    out, offset = [], 0
    while True:
        with httpx.Client() as c:
            r = c.post(
                f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}",
                headers={**_sb_headers(), "Content-Type": "application/json"},
                json={"prefix": prefix, "limit": 100, "offset": offset,
                      "sortBy": {"column": "name", "order": "asc"}},
            )
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < 100:
            break
        offset += 100
    return out


def _sb_download(path: str) -> bytes:
    with httpx.Client() as c:
        r = c.get(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}", headers=_sb_headers())
    r.raise_for_status()
    return r.content


def migrate_storage(dry_run: bool):
    _require_supabase()
    bucket = None if dry_run else _fb()[0]
    copied = [0]

    def walk(prefix: str):
        for e in _sb_list(prefix):
            name = e.get("name")
            if not name:
                continue
            full = f"{prefix}{name}" if prefix.endswith("/") or prefix == "" else f"{prefix}/{name}"
            is_folder = e.get("id") is None and e.get("metadata") is None
            if is_folder:
                walk(f"{full}/")
            else:
                if dry_run:
                    print(f"  would copy {full}")
                else:
                    data = _sb_download(full)
                    bucket.blob(full).upload_from_string(data, content_type="text/markdown")
                copied[0] += 1

    walk("")
    print(f"[storage] {'would copy' if dry_run else 'copied'} {copied[0]} files")


# ── 3. Thoughts ──────────────────────────────────────────────────────────────
def migrate_thoughts(dry_run: bool):
    _require_supabase()
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    rows, start = [], 0
    while True:
        resp = sb.table("thoughts").select("*").range(start, start + 999).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        start += 1000

    print(f"[thoughts] found {len(rows)} rows")
    if dry_run:
        for r in rows[:5]:
            print(f"  would write id={r['id']} user={r['user_id']} created={r['created_at']}")
        return

    _, db, _ = _fb()
    written = 0
    for r in rows:
        created = datetime.fromisoformat(r["created_at"])  # tz-aware
        # Preserve the original id as the Firestore document id.
        db.collection("thoughts").document(str(r["id"])).set({
            "text": r["text"],
            "user_id": str(r["user_id"]),
            "created_at": created,
        })
        written += 1
    print(f"[thoughts] wrote {written} documents (original ids + created_at preserved)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--users", action="store_true")
    ap.add_argument("--storage", action="store_true")
    ap.add_argument("--thoughts", action="store_true")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    do_all = args.all or not (args.users or args.storage or args.thoughts)
    if args.users or do_all:
        migrate_users(args.dry_run)
    if args.storage or do_all:
        migrate_storage(args.dry_run)
    if args.thoughts or do_all:
        migrate_thoughts(args.dry_run)
    print("done.")


if __name__ == "__main__":
    main()
