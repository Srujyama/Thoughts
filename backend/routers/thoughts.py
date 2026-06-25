from fastapi import APIRouter, HTTPException, Depends
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from models.schemas import ThoughtCreate, ThoughtResponse, ThoughtsListResponse
from dependencies.auth import get_current_user
from dependencies.firebase import get_app

router = APIRouter()

COLLECTION = "thoughts"


def _db():
    get_app()
    return firestore.client()


def _to_response(doc_id: str, data: dict) -> dict:
    return {
        "id": doc_id,
        "text": data.get("text", ""),
        "created_at": data.get("created_at"),
        "user_id": data.get("user_id", ""),
    }


@router.get("", response_model=ThoughtsListResponse)
async def get_thoughts(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    query = (
        _db().collection(COLLECTION)
        .where(filter=FieldFilter("user_id", "==", user_id))
        .order_by("created_at", direction=firestore.Query.DESCENDING)
    )
    thoughts = [_to_response(doc.id, doc.to_dict()) for doc in query.stream()]
    return ThoughtsListResponse(thoughts=thoughts, count=len(thoughts))


@router.post("", response_model=ThoughtResponse, status_code=201)
async def create_thought(
    body: ThoughtCreate,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["user_id"]
    _, doc_ref = _db().collection(COLLECTION).add({
        "text": body.text.strip(),
        "user_id": user_id,
        "created_at": firestore.SERVER_TIMESTAMP,
    })
    snap = doc_ref.get()  # read back to resolve the server timestamp
    if not snap.exists:
        raise HTTPException(status_code=500, detail="Failed to save thought")
    return _to_response(doc_ref.id, snap.to_dict())


@router.delete("/{thought_id}", status_code=204)
async def delete_thought(
    thought_id: str,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["user_id"]
    doc_ref = _db().collection(COLLECTION).document(thought_id)
    snap = doc_ref.get()

    # Enforce ownership explicitly (the Admin SDK bypasses security rules).
    if not snap.exists or snap.get("user_id") != user_id:
        raise HTTPException(
            status_code=404,
            detail="Thought not found or not owned by you",
        )

    doc_ref.delete()
    return None
