"""
Vault router — two-way sync between Cloud Storage for Firebase and the local vault.

Storage layout: files live at "{user_id}/{relative_path}" in the default bucket.
The HTTP contract is unchanged from the Supabase version, so the frontend and the
local watcher (vault_sync.py) need no changes.
"""

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response
from pydantic import BaseModel
from firebase_admin import storage
from google.cloud.exceptions import NotFound

from dependencies.auth import get_current_user
from dependencies.firebase import get_app

router = APIRouter()


def _bucket():
    get_app()  # ensure init (sets default storageBucket)
    return storage.bucket()


class FileContent(BaseModel):
    path: str        # relative path e.g. "folder/note.md"
    content: str     # UTF-8 text content


class FileListItem(BaseModel):
    path: str
    updated_at: str | None = None
    size: int | None = None


# ── List all files for the current user (recursive) ──────────────────────────

@router.get("/files", response_model=list[FileListItem])
async def list_files(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    root_prefix = f"{user_id}/"

    try:
        # list_blobs(prefix=...) with no delimiter lists every nested object.
        blobs = _bucket().list_blobs(prefix=root_prefix)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    result = []
    for blob in blobs:
        rel = blob.name[len(root_prefix):]
        if not rel:
            continue  # the prefix "folder placeholder" object, if any
        result.append(FileListItem(
            path=rel,
            updated_at=blob.updated.isoformat() if blob.updated else None,
            size=blob.size,
        ))
    return result


# ── Read a single file ────────────────────────────────────────────────────────

@router.get("/files/{file_path:path}")
async def read_file(file_path: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    blob = _bucket().blob(f"{user_id}/{file_path}")

    try:
        data = blob.download_as_bytes()
    except NotFound:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Download failed: {e}")

    return Response(content=data, media_type="text/markdown; charset=utf-8")


# ── Write / upsert a file (used by local watcher and web editor) ──────────────

@router.put("/files/{file_path:path}", status_code=200)
async def write_file(
    file_path: str,
    body: FileContent,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["user_id"]
    blob = _bucket().blob(f"{user_id}/{file_path}")
    encoded = body.content.encode("utf-8")

    try:
        # Cloud Storage objects are immutable; an upload to an existing name
        # replaces it — i.e. upsert semantics, no special flag needed.
        blob.upload_from_string(encoded, content_type="text/markdown")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    return {"path": file_path, "bytes": len(encoded)}


# ── Delete a file ─────────────────────────────────────────────────────────────

@router.delete("/files/{file_path:path}", status_code=204)
async def delete_file(file_path: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    blob = _bucket().blob(f"{user_id}/{file_path}")

    try:
        blob.delete()
    except NotFound:
        # Already gone — treat delete as idempotent.
        return None
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")

    return None
