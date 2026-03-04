from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, thoughts, vault
from dotenv import load_dotenv
from pathlib import Path
import os

# Always load .env from the same directory as this file, regardless of cwd
load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="Thoughts API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(thoughts.router, prefix="/thoughts", tags=["thoughts"])
app.include_router(vault.router, prefix="/vault", tags=["vault"])


@app.get("/health")
def health_check():
    return {"status": "online", "message": "NIGHT CITY ONLINE"}
