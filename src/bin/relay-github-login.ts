#!/usr/bin/env node

import { DEFAULT_RELAY_API_URL, loadRelayClientFileConfig, saveRelayClientFileConfig } from "../relay-client/config";
import { buildRelayBearerTokenExports, RelayLoginClient } from "../relay-client/login";

export async function runRelayGithubLogin(argv: string[] = process.argv): Promise<void> {
  const loadedConfig = loadRelayClientFileConfig();
  const apiUrl = process.env.RELAY_API_URL ?? loadedConfig.config?.apiUrl ?? DEFAULT_RELAY_API_URL;
  const authUrl = process.env.RELAY_AUTH_URL ?? loadedConfig.config?.authUrl;
  const timeoutMs = parsePositiveInt(process.env.RELAY_LOGIN_TIMEOUT_MS, 120_000);
  const pollIntervalMs = parsePositiveInt(process.env.RELAY_LOGIN_POLL_MS, 1_000);
  const printEnv = argv.includes("--print-env");

  const loginClient = new RelayLoginClient({
    apiUrl,
    authUrl,
  });

  console.log(`[relay-login] Using auth URL: ${loginClient.authUrl}`);

  const result = await loginClient.loginWithOAuth("github", {
    timeoutMs,
    pollIntervalMs,
    onAuthUrl(loginUrl) {
      console.log("");
      console.log("[relay-login] Open this URL in your browser and finish the GitHub login:");
      console.log(loginUrl);
      console.log("");
      console.log("[relay-login] Waiting for Relay to receive the OAuth callback...");
    },
  });

  console.log("");
  console.log(`[relay-login] Logged in as ${formatUser(result)}`);
  const saved = saveRelayClientFileConfig({
    apiUrl,
    authRecord: result.record as Record<string, unknown>,
    authUrl: result.authUrl,
    bearerToken: result.token,
    folderId: process.env.RELAY_FOLDER_ID ?? loadedConfig.config?.folderId,
    provider: result.provider,
    relayId: process.env.RELAY_ID ?? loadedConfig.config?.relayId,
    tokenExpiresAt: result.tokenExpiresAt,
  });
  console.log(`[relay-login] Saved credentials to ${saved.path}`);
  if (result.tokenExpiresAt) {
    console.log(`[relay-login] Token expires at ${result.tokenExpiresAt}`);
  }
  if (printEnv) {
    console.log("[relay-login] Export these values into your shell:");
    console.log("");
    console.log(
      buildRelayBearerTokenExports({
        apiUrl,
        authUrl: result.authUrl,
        bearerToken: result.token,
      }),
    );
    console.log("");
  } else {
    console.log("[relay-login] Bearer token saved. Re-run with --print-env only if you need shell export lines.");
  }
  console.log("[relay-login] obsidian-relay-mcp will load the saved config automatically on the next run.");
  console.log("");
}

function formatUser(result: { user: { id: string; email?: string; name?: string } }): string {
  const name = result.user.name?.trim();
  const email = result.user.email?.trim();
  if (name && email) {
    return `${name} <${email}>`;
  }
  if (email) {
    return email;
  }
  if (name) {
    return name;
  }
  return result.user.id;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (require.main === module) {
  runRelayGithubLogin().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[relay-login] ${message}`);
    process.exitCode = 1;
  });
}
