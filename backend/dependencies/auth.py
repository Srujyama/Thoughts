from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import base64
import jwt
import os

security = HTTPBearer()

# Supabase JWKS endpoint (ES256). We also keep HS256 as a fallback using
# SUPABASE_JWT_SECRET so a transient JWKS fetch failure doesn't wedge auth.
_JWKS_CLIENT: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    # Rebuild on every miss — PyJWKClient caches failure state internally,
    # so a single SSL blip otherwise poisons the process until restart.
    global _JWKS_CLIENT
    if _JWKS_CLIENT is None:
        url = os.getenv("SUPABASE_URL")
        _JWKS_CLIENT = jwt.PyJWKClient(
            f"{url}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
            timeout=5,
        )
    return _JWKS_CLIENT


def _hs256_key() -> bytes | None:
    secret = os.getenv("SUPABASE_JWT_SECRET")
    if not secret:
        return None
    # Supabase stores the HS256 secret base64-encoded; fall back to raw if decode fails.
    try:
        return base64.b64decode(secret)
    except Exception:
        return secret.encode("utf-8")


def _decode_token(token: str) -> dict:
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "")

    if alg == "HS256":
        key = _hs256_key()
        if not key:
            raise jwt.InvalidTokenError("HS256 token but SUPABASE_JWT_SECRET not set")
        return jwt.decode(
            token, key, algorithms=["HS256"], options={"verify_aud": False}
        )

    # ES256 (current Supabase default) — verify via JWKS, fall back to HS256 on fetch failure.
    try:
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            options={"verify_aud": False},
        )
    except jwt.PyJWKClientError as e:
        # Drop the cached (possibly broken) client so the next request retries fresh.
        global _JWKS_CLIENT
        _JWKS_CLIENT = None
        key = _hs256_key()
        if not key:
            raise jwt.InvalidTokenError(f"JWKS unreachable and no HS256 fallback: {e}")
        # HS256 fallback will only succeed if the project is on the legacy HS256 secret —
        # on ES256-only projects this correctly surfaces as an invalid signature.
        return jwt.decode(
            token, key, algorithms=["HS256"], options={"verify_aud": False}
        )


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    token = credentials.credentials

    try:
        payload = _decode_token(token)
        user_id: str = payload.get("sub")
        email: str = payload.get("email")

        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing subject",
                headers={"WWW-Authenticate": "Bearer"},
            )

        return {"user_id": user_id, "email": email}

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as e:
        print(f"[JWT ERROR] {type(e).__name__}: {e}", flush=True)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )
