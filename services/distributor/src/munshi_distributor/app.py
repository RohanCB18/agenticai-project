"""Distributor agent service.

Phase 0 publishes the A2A Agent Card so other agents can discover it. Phase 5 adds the
LangGraph negotiation graph and the A2A task endpoints (via the official a2a-sdk).
"""

from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DISTRIBUTOR_", env_file=".env", extra="ignore")
    public_url: str = "http://127.0.0.1:8102"
    name: str = "Sharma Traders Wholesale Agent"


settings = Settings()
app = FastAPI(title="Munshi distributor agent")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "munshi-distributor"}


@app.get("/.well-known/agent-card.json")
def agent_card() -> dict:
    return {
        "name": settings.name,
        "description": "Takes FMCG reorders from retail shops, quotes prices and confirms delivery slots.",
        "url": settings.public_url,
        "version": "0.1.0",
        "capabilities": {"streaming": False},
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {
                "id": "quote_reorder",
                "name": "Quote a reorder",
                "description": "Given items and quantities, return unit prices, total and the earliest delivery slot.",
                "tags": ["ordering", "pricing", "fmcg"],
            }
        ],
    }


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8102)
