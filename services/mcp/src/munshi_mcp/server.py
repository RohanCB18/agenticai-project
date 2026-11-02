"""Munshi MCP server.

Phase 0 ships the skeleton and a health tool. Phase 5 adds the khata/inventory tools
and MCP Apps widgets (ledger card, payout approval card).
"""

from fastmcp import FastMCP
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MUNSHI_MCP_", env_file=".env", extra="ignore")
    host: str = "127.0.0.1"
    port: int = 8101


settings = Settings()
mcp = FastMCP("munshi")


@mcp.tool
def health() -> dict[str, str]:
    """Report that the Munshi MCP server is reachable."""
    return {"status": "ok", "service": "munshi-mcp"}


def main() -> None:
    mcp.run(transport="http", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
