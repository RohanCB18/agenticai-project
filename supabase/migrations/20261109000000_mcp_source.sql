-- Entries made from an MCP host (Claude, ChatGPT, an IDE) through /api/mcp, so the khata shows
-- which ones came from outside Munshi's own chats.
alter type public.entry_source add value if not exists 'mcp';
