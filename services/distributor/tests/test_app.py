from fastapi.testclient import TestClient

from munshi_distributor.app import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_agent_card_advertises_reorder_skill():
    card = client.get("/.well-known/agent-card.json").json()
    assert card["name"]
    assert any(skill["id"] == "quote_reorder" for skill in card["skills"])
