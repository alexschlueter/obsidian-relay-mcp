import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG,
  DEFAULT_RELAY_API_URL,
  DEFAULT_RELAY_CLIENT_CONFIG_FILENAME,
  getDefaultRelayClientUserConfigPath,
  loadRelayClientFileConfig,
  RELAY_CLIENT_CONFIG_FILE_MODE,
  resolveRelayClientConfigPath,
  saveRelayClientFileConfig,
} from "../src/relay-client/config";
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
  it("prefers an existing local config and otherwise falls back to the user config path", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-config-path-"));
    tempDirs.push(tempDir);

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tempDir, "xdg"),
    };
    const cwd = path.join(tempDir, "project");
    fs.mkdirSync(cwd);

    expect(resolveRelayClientConfigPath({ cwd, env })).toBe(
      path.join(tempDir, "xdg", "obsidian-relay-mcp", "config.json"),
    );
    expect(getDefaultRelayClientUserConfigPath(env)).toBe(
      path.join(tempDir, "xdg", "obsidian-relay-mcp", "config.json"),
    );

    const localConfigPath = path.join(cwd, DEFAULT_RELAY_CLIENT_CONFIG_FILENAME);
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");

    expect(resolveRelayClientConfigPath({ cwd, env })).toBe(localConfigPath);
  });

  it("saves and loads the local config file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-config-"));
    tempDirs.push(tempDir);

    const configPath = path.join(tempDir, "relay-config.json");
    const env = {
      ...process.env,
      RELAY_CLIENT_CONFIG: configPath,
    };

    saveRelayClientFileConfig(
      {
        attachments: {
          includeImageContent: true,
          maxImageContentMB: 2,
        },
        bearerToken: "token-123",
        relayId: "relay-guid",
      },
      { env },
    );

    const loaded = loadRelayClientFileConfig({ env });

    expect(loaded.config).toMatchObject({
      attachments: {
        includeImageContent: true,
        maxImageContentMB: 2,
      },
      bearerToken: "token-123",
      relayId: "relay-guid",
    });
    expect(fs.statSync(configPath).mode & 0o777).toBe(RELAY_CLIENT_CONFIG_FILE_MODE);
  });

  it("populates attachment defaults when saving config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-config-defaults-"));
    tempDirs.push(tempDir);

    const env = {
      ...process.env,
      RELAY_CLIENT_CONFIG: path.join(tempDir, "relay-config.json"),
    };

    const saved = saveRelayClientFileConfig(
      {
        bearerToken: "token-123",
      },
      { env },
    );

    expect(saved.config?.attachments).toEqual(DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG);
    expect(loadRelayClientFileConfig({ env }).config?.attachments).toEqual(
      DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG,
    );
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

  it("rejects fractional attachment text character limits from saved config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relay-config-"));
    tempDirs.push(tempDir);

    const env = {
      ...process.env,
      RELAY_CLIENT_CONFIG: path.join(tempDir, "relay-config.json"),
    };

    saveRelayClientFileConfig(
      {
        bearerToken: "token-123",
        attachments: {
          maxTextChars: 1.5,
        },
      },
      { env },
    );

    expect(() => RelayClient.fromEnv(env)).toThrow(
      "Expected a positive integer attachment config value, received 1.5",
    );
  });
});
