#!/usr/bin/env python3
"""
vault_sync.py — Two-way sync between your local Obsidian vault and the cloud.

Usage:
    python vault_sync.py --vault ~/path/to/your/obsidian/vault --token YOUR_JWT_TOKEN

What it does:
  1. On startup: uploads all local .md files that are newer than their cloud version
  2. Every POLL_INTERVAL seconds: downloads any cloud files newer than local
  3. Watches local file system: uploads changes immediately when you save in Obsidian

Dependencies:
    pip install watchdog requests
"""

import os
import sys
import time
import argparse
import requests
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_API = "http://localhost:8000"  # Change to your Railway URL after deploying
POLL_INTERVAL = 30   # seconds — how often to check cloud for changes
WATCHED_EXTENSIONS = {".md", ".txt"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def rel_path(vault_root: Path, file_path: Path) -> str:
    return str(file_path.relative_to(vault_root)).replace("\\", "/")


def upload_file(api: str, token: str, vault_root: Path, file_path: Path):
    path = rel_path(vault_root, file_path)
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"  [skip] Cannot read {path}: {e}")
        return

    resp = requests.put(
        f"{api}/vault/files/{path}",
        json={"path": path, "content": content},
        headers=headers(token),
        timeout=15,
    )
    if resp.ok:
        print(f"  [up]   {path}")
    else:
        print(f"  [ERR]  Upload {path}: {resp.status_code} {resp.text[:100]}")


def download_file(api: str, token: str, vault_root: Path, path: str):
    resp = requests.get(
        f"{api}/vault/files/{path}",
        headers=headers(token),
        timeout=15,
    )
    if not resp.ok:
        print(f"  [ERR]  Download {path}: {resp.status_code}")
        return

    dest = vault_root / path
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Only overwrite if content actually changed (avoid triggering watchdog loop)
    new_content = resp.content
    if dest.exists() and dest.read_bytes() == new_content:
        return

    dest.write_bytes(new_content)
    print(f"  [down] {path}")


def list_cloud_files(api: str, token: str) -> list[dict]:
    resp = requests.get(f"{api}/vault/files", headers=headers(token), timeout=15)
    if not resp.ok:
        print(f"  [ERR]  List files: {resp.status_code} {resp.text[:100]}")
        return []
    return resp.json()


def initial_upload(api: str, token: str, vault_root: Path):
    """Upload all local .md files to cloud on first run."""
    print("── Initial upload ──────────────────────────")
    for f in vault_root.rglob("*"):
        if f.is_file() and f.suffix in WATCHED_EXTENSIONS:
            upload_file(api, token, vault_root, f)
    print("── Done ────────────────────────────────────\n")


def poll_cloud(api: str, token: str, vault_root: Path):
    """Download any cloud files that don't exist locally or differ."""
    files = list_cloud_files(api, token)
    for item in files:
        path = item["path"]
        if not any(path.endswith(ext) for ext in WATCHED_EXTENSIONS):
            continue
        download_file(api, token, vault_root, path)


# ── Watchdog handler ──────────────────────────────────────────────────────────

class VaultHandler(FileSystemEventHandler):
    def __init__(self, api: str, token: str, vault_root: Path):
        self.api = api
        self.token = token
        self.vault_root = vault_root
        self._recently_downloaded: set[str] = set()  # prevent upload loops

    def _should_skip(self, file_path: str) -> bool:
        p = Path(file_path)
        if p.suffix not in WATCHED_EXTENSIONS:
            return True
        if ".obsidian" in p.parts:
            return True
        rel = rel_path(self.vault_root, p)
        if rel in self._recently_downloaded:
            self._recently_downloaded.discard(rel)
            return True
        return False

    def on_modified(self, event):
        if event.is_directory or self._should_skip(event.src_path):
            return
        upload_file(self.api, self.token, self.vault_root, Path(event.src_path))

    def on_created(self, event):
        if event.is_directory or self._should_skip(event.src_path):
            return
        upload_file(self.api, self.token, self.vault_root, Path(event.src_path))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Obsidian vault two-way sync")
    parser.add_argument("--vault", required=True, help="Path to your Obsidian vault folder")
    parser.add_argument("--token", required=True, help="Your JWT access token (from login)")
    parser.add_argument("--api", default=DEFAULT_API, help=f"API base URL (default: {DEFAULT_API})")
    parser.add_argument("--no-initial-upload", action="store_true", help="Skip uploading local files on start")
    args = parser.parse_args()

    vault_root = Path(args.vault).expanduser().resolve()
    if not vault_root.is_dir():
        print(f"Error: vault path does not exist: {vault_root}")
        sys.exit(1)

    print(f"Vault:  {vault_root}")
    print(f"API:    {args.api}")
    print()

    # 1. Upload local files to cloud
    if not args.no_initial_upload:
        initial_upload(args.api, args.token, vault_root)

    # 2. Download any cloud-only files
    print("── Initial download ────────────────────────")
    poll_cloud(args.api, args.token, vault_root)
    print("── Done ────────────────────────────────────\n")

    # 3. Watch local for changes
    handler = VaultHandler(args.api, args.token, vault_root)
    observer = Observer()
    observer.schedule(handler, str(vault_root), recursive=True)
    observer.start()
    print(f"Watching {vault_root} for changes...")
    print(f"Polling cloud every {POLL_INTERVAL}s. Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(POLL_INTERVAL)
            print("── Polling cloud ───────────────────────────")
            poll_cloud(args.api, args.token, vault_root)
    except KeyboardInterrupt:
        observer.stop()
        print("\nSync stopped.")
    observer.join()


if __name__ == "__main__":
    main()
