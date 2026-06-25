from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from firebase_admin import auth as fb_auth

from dependencies.firebase import get_app

security = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Verify a Firebase ID token and return {user_id, email}.

    Token signature/expiry/audience are checked locally against Google's cached
    public certs (no per-request network round-trip).
    """
    get_app()  # ensure the Admin SDK is initialized
    token = credentials.credentials

    try:
        decoded = fb_auth.verify_id_token(token)
    except fb_auth.ExpiredIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except (fb_auth.RevokedIdTokenError, fb_auth.InvalidIdTokenError) as e:
        # InvalidIdTokenError is the base class for malformed/bad-signature tokens.
        print(f"[FIREBASE AUTH] {type(e).__name__}: {e}", flush=True)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except ValueError as e:
        # Raised when the token is None / not a string.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = decoded.get("uid")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing subject",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return {"user_id": user_id, "email": decoded.get("email")}
