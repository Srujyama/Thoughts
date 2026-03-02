from fastapi import APIRouter, HTTPException, Depends
from models.schemas import ThoughtCreate, ThoughtResponse, ThoughtsListResponse
from dependencies.auth import get_current_user
from supabase import create_client
import os

router = APIRouter()


def get_supabase():
    return create_client(
        os.getenv("SUPABASE_URL"),
        os.getenv("SUPABASE_SERVICE_KEY"),
    )


@router.get("", response_model=ThoughtsListResponse)
async def get_thoughts(current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    user_id = current_user["user_id"]

    response = (
        supabase.table("thoughts")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )

    thoughts = response.data or []
    return ThoughtsListResponse(thoughts=thoughts, count=len(thoughts))


@router.post("", response_model=ThoughtResponse, status_code=201)
async def create_thought(
    body: ThoughtCreate,
    current_user: dict = Depends(get_current_user),
):
    supabase = get_supabase()
    user_id = current_user["user_id"]

    response = (
        supabase.table("thoughts")
        .insert({"text": body.text.strip(), "user_id": user_id})
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to save thought")

    return response.data[0]


@router.delete("/{thought_id}", status_code=204)
async def delete_thought(
    thought_id: str,
    current_user: dict = Depends(get_current_user),
):
    supabase = get_supabase()
    user_id = current_user["user_id"]

    # Verify ownership — service key bypasses RLS so we enforce it explicitly
    existing = (
        supabase.table("thoughts")
        .select("id")
        .eq("id", thought_id)
        .eq("user_id", user_id)
        .execute()
    )

    if not existing.data:
        raise HTTPException(
            status_code=404,
            detail="Thought not found or not owned by you",
        )

    supabase.table("thoughts").delete().eq("id", thought_id).execute()
    return None
