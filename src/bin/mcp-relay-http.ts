#!/usr/bin/env node
import { startRelayMcpHttpServer } from "../mcp/httpServer";

startRelayMcpHttpServer({
  host: process.env.MCP_RELAY_HOST,
  port: parsePositiveInteger(process.env.MCP_RELAY_PORT, 3333),
  endpoint: process.env.MCP_RELAY_ENDPOINT,
  allowedHosts: parseCsv(process.env.MCP_RELAY_ALLOWED_HOSTS),
})
  .then((server) => {
    console.error(`mcp-relay Streamable HTTP listening at ${server.url}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
