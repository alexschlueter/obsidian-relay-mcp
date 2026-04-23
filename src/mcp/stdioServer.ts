import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelayMcpServer, RelayMcpServerOptions } from "./relayMcpServer";

export interface RelayMcpStdioHandle {
  close(): Promise<void>;
}

export async function runRelayMcpStdio(
  options: RelayMcpServerOptions = {},
): Promise<RelayMcpStdioHandle> {
  const server = createRelayMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    async close() {
      await server.close();
    },
  };
}
