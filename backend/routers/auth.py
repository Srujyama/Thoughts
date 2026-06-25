from fastapi import APIRouter, HTTPException
from models.schemas import SignupRequest, LoginRequest, AuthResponse
from pydantic import BaseModel
import httpx

from dependencies.firebase import web_api_key

router = APIRouter()

IDENTITY_URL = "https://identitytoolkit.googleapis.com/v1/accounts"
SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token"


def _error_message(resp: httpx.Response) -> str:
    try:
        return resp.json().get("error", {}).get("message", resp.text)
    except Exception:
        return resp.text


@router.post("/signup", response_model=AuthResponse, status_code=201)
async def signup(body: SignupRequest):
    key = web_api_key()
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{IDENTITY_URL}:signUp?key={key}",
            json={"email": body.email, "password": body.password, "returnSecureToken": True},
        )

    if res.status_code != 200:
        msg = _error_message(res)
        if "EMAIL_EXISTS" in msg:
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        if "WEAK_PASSWORD" in msg:
            raise HTTPException(status_code=400, detail="Password is too weak (minimum 6 characters)")
        raise HTTPException(status_code=400, detail=msg)

    data = res.json()
    return AuthResponse(
        access_token=data["idToken"],
        refresh_token=data.get("refreshToken", ""),
        user_id=data["localId"],
        email=data["email"],
    )


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest):
    key = web_api_key()
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{IDENTITY_URL}:signInWithPassword?key={key}",
            json={"email": body.email, "password": body.password, "returnSecureToken": True},
        )

    if res.status_code != 200:
        msg = _error_message(res)
        # Email-enumeration protection collapses bad email/password into one code.
        if any(c in msg for c in ("INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND")):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        if "USER_DISABLED" in msg:
            raise HTTPException(status_code=403, detail="This account has been disabled")
        raise HTTPException(status_code=401, detail=msg)

    data = res.json()
    return AuthResponse(
        access_token=data["idToken"],
        refresh_token=data.get("refreshToken", ""),
        user_id=data["localId"],
        email=data["email"],
    )


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=AuthResponse)
async def refresh(body: RefreshRequest):
    key = web_api_key()
    async with httpx.AsyncClient() as client:
        # The secure-token endpoint is form-encoded and returns snake_case fields.
        res = await client.post(
            f"{SECURE_TOKEN_URL}?key={key}",
            data={"grant_type": "refresh_token", "refresh_token": body.refresh_token},
        )

    if res.status_code != 200:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")

    data = res.json()
    # The refresh response carries id_token / refresh_token / user_id but NOT email.
    return AuthResponse(
        access_token=data["id_token"],
        refresh_token=data.get("refresh_token", ""),
        user_id=data["user_id"],
        email="",
    )


@router.post("/logout", status_code=204)
async def logout():
    return None
