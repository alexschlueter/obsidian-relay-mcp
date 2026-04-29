#!/usr/bin/env node

import { startRelayMcpHttpServer } from "../mcp/httpServer";
import { runRelayMcpStdio } from "../mcp/stdioServer";

const HELP_TEXT = `obsidian-relay-mcp

Usage:
  obsidian-relay-mcp [stdio]
  obsidian-relay-mcp http
  obsidian-relay-mcp login [--print-env]
  obsidian-relay-mcp login:<provider> [--print-env]
  obsidian-relay-mcp login --list-providers
  obsidian-relay-mcp choose-target

Commands:
  stdio          Run the MCP server over stdio. This is the default.
  http           Run the MCP server over Streamable HTTP.
  login          Choose a Relay login provider interactively and save .relay-client.json.
  login:<provider>  Log in with a specific provider without prompting.
  choose-target  Choose the Relay and shared folder saved in .relay-client.json.
`;

async function main(): Promise<void> {
  const [rawCommand] = process.argv.slice(2);
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "help":
      console.log(HELP_TEXT);
      return;
    case "stdio":
      await runRelayMcpStdio();
      return;
    case "http": {
      const server = await startRelayMcpHttpServer({
        host: process.env.MCP_RELAY_HOST,
        port: parsePositiveInteger(process.env.MCP_RELAY_PORT, 3333),
        endpoint: process.env.MCP_RELAY_ENDPOINT,
        allowedHosts: parseCsv(process.env.MCP_RELAY_ALLOWED_HOSTS),
      });
      console.error(`obsidian-relay-mcp Streamable HTTP listening at ${server.url}`);
      return;
    }
    case "login":
      await (await import("./relay-login")).runRelayLogin();
      return;
    case "choose-target":
      await (await import("./relay-choose-target")).runRelayChooseTarget();
      return;
    default:
      if (command.startsWith("login:")) {
        await (await import("./relay-login")).runRelayLogin();
        return;
      }
      throw new Error(`Unknown command "${rawCommand}". Run obsidian-relay-mcp --help.`);
  }
}

function normalizeCommand(command: string | undefined): string {
  if (!command || command === "stdio") {
    return "stdio";
  }
  if (command === "-h" || command === "--help" || command === "help") {
    return "help";
  }
  if (command === "login") {
    return "login";
  }
  if (command === "choose" || command === "target") {
    return "choose-target";
  }
  return command;
}

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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[obsidian-relay-mcp] ${message}`);
  process.exitCode = 1;
});
