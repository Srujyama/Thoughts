from fastapi import APIRouter, HTTPException
from models.schemas import SignupRequest, LoginRequest, AuthResponse
from supabase import create_client
import os
import httpx

router = APIRouter()

SUPABASE_URL = lambda: os.getenv("SUPABASE_URL")
SUPABASE_KEY = lambda: os.getenv("SUPABASE_SERVICE_KEY")


def get_supabase():
    return create_client(SUPABASE_URL(), SUPABASE_KEY())


def _auth_headers():
    return {
        "apikey": SUPABASE_KEY(),
        "Authorization": f"Bearer {SUPABASE_KEY()}",
        "Content-Type": "application/json",
    }


@router.post("/signup", response_model=AuthResponse, status_code=201)
async def signup(body: SignupRequest):
    url = SUPABASE_URL()
    headers = _auth_headers()

    # Create user via admin API (auto-confirms email)
    async with httpx.AsyncClient() as client:
        create = await client.post(
            f"{url}/auth/v1/admin/users",
            headers=headers,
            json={"email": body.email, "password": body.password, "email_confirm": True},
        )

    if create.status_code == 422:
        detail = create.json().get("msg", create.text)
        if "already" in detail.lower() or "registered" in detail.lower():
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        raise HTTPException(status_code=400, detail=detail)

    if create.status_code not in (200, 201):
        detail = create.json().get("message") or create.json().get("msg") or create.text
        if "already" in detail.lower():
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        raise HTTPException(status_code=400, detail=detail)

    # Sign in to get a session token
    async with httpx.AsyncClient() as client:
        login = await client.post(
            f"{url}/auth/v1/token?grant_type=password",
            headers=headers,
            json={"email": body.email, "password": body.password},
        )

    if login.status_code != 200:
        raise HTTPException(status_code=400, detail="Account created but sign-in failed")

    data = login.json()
    return AuthResponse(
        access_token=data["access_token"],
        user_id=data["user"]["id"],
        email=data["user"]["email"],
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest):
    url = SUPABASE_URL()
    headers = _auth_headers()

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{url}/auth/v1/token?grant_type=password",
            headers=headers,
            json={"email": body.email, "password": body.password},
        )

    if res.status_code != 200:
        detail = res.json().get("error_description") or res.json().get("message") or "Invalid email or password"
        raise HTTPException(status_code=401, detail=detail)

    data = res.json()
    return AuthResponse(
        access_token=data["access_token"],
        user_id=data["user"]["id"],
        email=data["user"]["email"],
    )


@router.post("/logout", status_code=204)
async def logout():
    return None
