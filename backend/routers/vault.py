"""
Vault router — two-way sync between Supabase Storage and local Obsidian vault.

Supabase Storage bucket: "vault"
Files are stored at: vault/{user_id}/{relative_path}
"""

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response
from pydantic import BaseModel
from dependencies.auth import get_current_user
from supabase import create_client
import os

router = APIRouter()

BUCKET = "vault"


def get_supabase():
    return create_client(
        os.getenv("SUPABASE_URL"),
        os.getenv("SUPABASE_SERVICE_KEY"),
    )


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
    supabase = get_supabase()
    user_id = current_user["user_id"]
    root_prefix = f"{user_id}/"

    def list_recursive(prefix: str) -> list[FileListItem]:
        """List all files recursively under prefix, returning paths relative to root_prefix."""
        try:
            items = supabase.storage.from_(BUCKET).list(prefix, {"limit": 1000, "offset": 0})
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Storage error: {e}")

        result = []
        for item in items:
            name = item.get("name", "")
            if not name:
                continue
            full_path = f"{prefix}{name}"
            # Supabase returns folders as items with id=None and no metadata
            is_folder = item.get("id") is None and item.get("metadata") is None
            if is_folder:
                # Recurse into subfolder
                result.extend(list_recursive(f"{full_path}/"))
            else:
                result.append(FileListItem(
                    path=full_path.removeprefix(root_prefix),
                    updated_at=item.get("updated_at"),
                    size=item.get("metadata", {}).get("size") if item.get("metadata") else None,
                ))
        return result

    return list_recursive(root_prefix)


# ── Read a single file ────────────────────────────────────────────────────────

@router.get("/files/{file_path:path}")
async def read_file(file_path: str, current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    user_id = current_user["user_id"]
    storage_path = f"{user_id}/{file_path}"

    try:
        data = supabase.storage.from_(BUCKET).download(storage_path)
    except Exception:
        raise HTTPException(status_code=404, detail="File not found")

    return Response(content=data, media_type="text/markdown; charset=utf-8")


# ── Write / upsert a file (used by local watcher and web editor) ──────────────

@router.put("/files/{file_path:path}", status_code=200)
async def write_file(
    file_path: str,
    body: FileContent,
    current_user: dict = Depends(get_current_user),
):
    supabase = get_supabase()
    user_id = current_user["user_id"]
    storage_path = f"{user_id}/{file_path}"
    encoded = body.content.encode("utf-8")

    try:
        # upsert: upload with overwrite
        supabase.storage.from_(BUCKET).upload(
            storage_path,
            encoded,
            {"content-type": "text/markdown", "upsert": "true"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    return {"path": file_path, "bytes": len(encoded)}


# ── Delete a file ─────────────────────────────────────────────────────────────

@router.delete("/files/{file_path:path}", status_code=204)
async def delete_file(file_path: str, current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    user_id = current_user["user_id"]
    storage_path = f"{user_id}/{file_path}"

    try:
        supabase.storage.from_(BUCKET).remove([storage_path])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")

    return None
