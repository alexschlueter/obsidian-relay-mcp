#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { DEFAULT_RELAY_API_URL, loadRelayClientFileConfig, saveRelayClientFileConfig } from "../relay-client/config";
import { buildRelayBearerTokenExports, RelayLoginClient } from "../relay-client/login";

export interface RelayLoginCliOptions {
  defaultProvider?: string;
}

export async function runRelayLogin(
  argv: string[] = process.argv,
  options: RelayLoginCliOptions = {},
): Promise<void> {
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

  if (argv.includes("--list-providers")) {
    const providers = await loginClient.listOAuthProviders();
    console.log(`[relay-login] Providers available at ${loginClient.authUrl}:`);
    for (const provider of providers) {
      console.log(`  ${provider}`);
    }
    return;
  }

  const provider = await resolveProvider(argv, loginClient, options.defaultProvider);
  if (!provider) {
    throw new Error(
      "Missing Relay login provider. Use login to choose interactively, login:<provider>, or login --list-providers.",
    );
  }

  console.log(`[relay-login] Using auth URL: ${loginClient.authUrl}`);

  const result = await loginClient.loginWithOAuth(provider, {
    timeoutMs,
    pollIntervalMs,
    onAuthUrl(loginUrl) {
      console.log("");
      console.log(`[relay-login] Open this URL in your browser and finish the ${formatProvider(provider)} login:`);
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

export function parseRelayLoginProvider(argv: string[], fallback?: string): string | undefined {
  return parseProvider(argv, fallback);
}

export function parseRelayProviderSelection(rawSelection: string, providers: string[]): string | undefined {
  const selection = rawSelection.trim();
  if (!selection) {
    return undefined;
  }

  const selectedIndex = Number.parseInt(selection, 10);
  if (Number.isInteger(selectedIndex) && String(selectedIndex) === selection) {
    return providers[selectedIndex - 1];
  }

  const selectedProvider = providers.find((provider) => provider.toLowerCase() === selection.toLowerCase());
  return selectedProvider;
}

async function resolveProvider(
  argv: string[],
  loginClient: RelayLoginClient,
  fallback?: string,
): Promise<string | undefined> {
  const provider = parseProvider(argv, fallback);
  if (provider) {
    return provider;
  }

  const providers = await loginClient.listOAuthProviders();
  return promptForProvider(providers, loginClient.authUrl);
}

async function promptForProvider(providers: string[], authUrl: string): Promise<string> {
  if (providers.length === 0) {
    throw new Error(`Relay auth gateway at ${authUrl} did not return any OAuth providers`);
  }

  console.log(`[relay-login] Providers available at ${authUrl}:`);
  providers.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider}`);
  });
  console.log("");

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question("[relay-login] Choose a provider by number or name: ");
      const provider = parseRelayProviderSelection(answer, providers);
      if (provider) {
        return provider;
      }
      console.log("[relay-login] Please enter one of the listed numbers or provider names.");
    }
  } finally {
    rl.close();
  }
}

function parseProvider(argv: string[], fallback?: string): string | undefined {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("login:")) {
      const provider = arg.slice("login:".length).trim();
      if (provider) {
        return provider;
      }
    }
    if (arg === "--provider" || arg === "-p") {
      const provider = args[index + 1]?.trim();
      if (provider) {
        return provider;
      }
    }
    if (arg.startsWith("--provider=")) {
      const provider = arg.slice("--provider=".length).trim();
      if (provider) {
        return provider;
      }
    }
  }

  const positionalProvider = args.find((arg) => {
    return (
      arg &&
      !arg.startsWith("-") &&
      arg !== "login" &&
      !arg.startsWith("login:")
    );
  });
  return positionalProvider ?? fallback;
}

function formatProvider(provider: string): string {
  const lower = provider.toLowerCase();
  const displayNames: Record<string, string> = {
    discord: "Discord",
    github: "GitHub",
    google: "Google",
    microsoft: "Microsoft",
    oidc: "OIDC",
  };
  const displayName = displayNames[lower];
  if (displayName) {
    return displayName;
  }
  return provider;
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
  runRelayLogin().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[relay-login] ${message}`);
    process.exitCode = 1;
  });
}
