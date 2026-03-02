from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import auth, thoughts
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Thoughts API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:4173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(thoughts.router, prefix="/thoughts", tags=["thoughts"])


@app.get("/health")
def health_check():
    return {"status": "online", "message": "NIGHT CITY ONLINE"}
