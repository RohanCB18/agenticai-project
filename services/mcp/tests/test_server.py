from fastmcp import Client

from munshi_mcp.server import mcp


async def test_health_tool_is_listed_and_callable():
    async with Client(mcp) as client:
        names = {t.name for t in await client.list_tools()}
        assert "health" in names

        result = await client.call_tool("health", {})
        assert result.data == {"status": "ok", "service": "munshi-mcp"}
