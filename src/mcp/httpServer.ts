import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { RelayClient } from "../relay-client/relayClient";
import { createRelayClientFromEnvForMcp, createRelayMcpServer } from "./relayMcpServer";

type TransportRequest = Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
type TransportResponse = Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];

interface ExpressRequestLike {
  body?: unknown;
}

interface ExpressResponseLike {
  headersSent: boolean;
  status(code: number): ExpressResponseLike;
  set(field: string, value: string): ExpressResponseLike;
  json(body: unknown): ExpressResponseLike;
}

export interface RelayMcpHttpServerOptions {
  client?: RelayClient;
  env?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  endpoint?: string;
  allowedHosts?: string[];
}

export interface RelayMcpHttpServerHandle {
  host: string;
  port: number;
  endpoint: string;
  url: string;
  close(): Promise<void>;
}

export async function startRelayMcpHttpServer(
  options: RelayMcpHttpServerOptions = {},
): Promise<RelayMcpHttpServerHandle> {
  const client = options.client ?? createRelayClientFromEnvForMcp(options.env);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3333;
  const endpoint = normalizeEndpoint(options.endpoint ?? "/mcp");
  const app = createMcpExpressApp({
    host,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  });

  app.post(endpoint, async (req: ExpressRequestLike, res: ExpressResponseLike) => {
    const server = createRelayMcpServer({ client });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(
        req as TransportRequest,
        res as unknown as TransportResponse,
        req.body,
      );
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  app.get(endpoint, (_req: ExpressRequestLike, res: ExpressResponseLike) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.delete(endpoint, (_req: ExpressRequestLike, res: ExpressResponseLike) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });

  return {
    host,
    port,
    endpoint,
    url: `http://${host}:${port}${endpoint}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return "/mcp";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
