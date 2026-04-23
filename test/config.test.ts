import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RELAY_API_URL, loadRelayClientFileConfig, saveRelayClientFileConfig } from "../src/relay-client/config";
import { RelayClient } from "../src/relay-client/relayClient";
import { S3RemoteFolder } from "../src/relay-client/s3rn";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("relay-client config", () => {
  it("saves and loads the local config file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-config-"));
    tempDirs.push(tempDir);

    const env = {
      ...process.env,
      RELAY_CLIENT_CONFIG: path.join(tempDir, "relay-config.json"),
    };

    saveRelayClientFileConfig(
      {
        bearerToken: "token-123",
        relayId: "relay-guid",
      },
      { env },
    );

    const loaded = loadRelayClientFileConfig({ env });

    expect(loaded.config).toMatchObject({
      bearerToken: "token-123",
      relayId: "relay-guid",
    });
  });

  it("uses the saved config plus the default Relay API url when env vars are absent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-runtime-"));
    tempDirs.push(tempDir);

    const env = {
      ...process.env,
      RELAY_CLIENT_CONFIG: path.join(tempDir, "relay-config.json"),
    };

    saveRelayClientFileConfig(
      {
        bearerToken: "saved-token",
        relayId: "11111111-1111-1111-1111-111111111111",
        folderId: "22222222-2222-2222-2222-222222222222",
      },
      { env },
    );

    const requests: Array<{ headers?: HeadersInit; url: string }> = [];
    const relay = RelayClient.fromEnv(env, {
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: init?.headers,
        });

        return new Response(
          JSON.stringify({
            url: "wss://example.test/doc/ws/doc-1",
            docId: "doc-1",
            folder: "22222222-2222-2222-2222-222222222222",
            token: "client-token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      },
    });

    await relay.auth.issueToken(
      new S3RemoteFolder(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    );

    expect(requests[0]?.url).toBe(`${DEFAULT_RELAY_API_URL}/token`);
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer saved-token",
    });
  });
});
