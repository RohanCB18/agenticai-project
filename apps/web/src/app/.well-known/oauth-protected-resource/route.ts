import { protectedResourceMetadata } from "@/lib/mcp/auth";

// RFC 9728 metadata for /api/mcp. Hosts look here (or under .../api/mcp) after the first 401.
export function GET(request: Request) {
  return Response.json(protectedResourceMetadata(new URL(request.url).origin), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });
}
