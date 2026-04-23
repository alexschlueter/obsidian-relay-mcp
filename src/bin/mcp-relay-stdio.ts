#!/usr/bin/env node
import { runRelayMcpStdio } from "../mcp/stdioServer";

runRelayMcpStdio().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
