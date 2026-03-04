from pydantic import BaseModel, field_validator
from datetime import datetime
from uuid import UUID


class SignupRequest(BaseModel):
    email: str
    password: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str


class ThoughtCreate(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def text_not_empty(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Thought cannot be empty")
        if len(v) > 5000:
            raise ValueError("Thought cannot exceed 5000 characters")
        return v


class ThoughtResponse(BaseModel):
    id: UUID
    text: str
    created_at: datetime
    user_id: UUID


class ThoughtsListResponse(BaseModel):
    thoughts: list[ThoughtResponse]
    count: int
