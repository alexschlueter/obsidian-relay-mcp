#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  DEFAULT_RELAY_API_URL,
  loadRelayCoreFileConfig,
  saveRelayCoreFileConfig,
} from "../relay-core/config";
import {
  RelayDirectoryClient,
  type RelayFolderSummary,
  type RelaySummary,
} from "../relay-core/directory";

async function main(): Promise<void> {
  const loaded = loadRelayCoreFileConfig();
  const config = loaded.config;
  const apiUrl = process.env.RELAY_API_URL ?? config?.apiUrl ?? DEFAULT_RELAY_API_URL;
  const authUrl = process.env.RELAY_AUTH_URL ?? config?.authUrl;
  const bearerToken = process.env.RELAY_BEARER_TOKEN ?? config?.bearerToken;

  if (!bearerToken) {
    throw new Error(
      `Missing Relay bearer token. Run pnpm login:github first or set RELAY_BEARER_TOKEN. Expected config path: ${loaded.path}`,
    );
  }

  const client = new RelayDirectoryClient({
    apiUrl,
    authUrl,
    authRecord: config?.authRecord,
    bearerToken,
    configPath: loaded.path,
  });

  const directory = await client.listDirectory();
  if (directory.relays.length === 0) {
    throw new Error("No relays are available for the current Relay account.");
  }

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const relay = await promptForChoice(
      rl,
      "Select a Relay",
      directory.relays,
      (item) =>
        item.providerName ? `${item.name} (${item.providerName}) [${item.guid}]` : `${item.name} [${item.guid}]`,
      config?.relayId,
      (item) => item.guid,
    );

    const relayFolders = directory.folders.filter((folder) => folder.relayGuid === relay.guid);
    if (relayFolders.length === 0) {
      throw new Error(`Relay "${relay.name}" has no available shared folders.`);
    }

    const folder = await promptForChoice(
      rl,
      `Select a shared folder for Relay "${relay.name}"`,
      relayFolders,
      (item) => {
        const privacy = item.private ? "private" : "shared";
        return item.creatorName
          ? `${item.name} (${privacy}, creator: ${item.creatorName}) [${item.guid}]`
          : `${item.name} (${privacy}) [${item.guid}]`;
      },
      config?.folderId,
      (item) => item.guid,
    );

    const authState = client.getAuthState();
    const saved = saveRelayCoreFileConfig(
      {
        apiUrl,
        authUrl: authState.authUrl,
        authRecord: authState.authRecord,
        bearerToken: authState.bearerToken,
        folderId: folder.guid,
        relayId: relay.guid,
        tokenExpiresAt: authState.tokenExpiresAt,
      },
      { configPath: loaded.path },
    );

    console.log("");
    console.log(`[relay-choose] Saved Relay target to ${saved.path}`);
    console.log(`[relay-choose] RELAY_ID=${relay.guid}`);
    console.log(`[relay-choose] RELAY_FOLDER_ID=${folder.guid}`);
    console.log(`[relay-choose] Selected relay: ${relay.name}`);
    console.log(`[relay-choose] Selected folder: ${folder.name}`);
    console.log("");
  } finally {
    rl.close();
  }
}

async function promptForChoice<T>(
  rl: ReturnType<typeof createInterface>,
  label: string,
  items: T[],
  render: (item: T) => string,
  defaultValue: string | undefined,
  getValue: (item: T) => string,
): Promise<T> {
  console.log("");
  console.log(`[relay-choose] ${label}`);
  items.forEach((item, index) => {
    const marker = defaultValue && getValue(item) === defaultValue ? " (current)" : "";
    console.log(`  ${index + 1}. ${render(item)}${marker}`);
  });

  while (true) {
    const promptLabel =
      defaultValue && items.some((item) => getValue(item) === defaultValue)
        ? `Enter a number (press Enter to keep the current selection): `
        : `Enter a number: `;
    const raw = (await rl.question(promptLabel)).trim();

    if (raw === "") {
      const current = defaultValue ? items.find((item) => getValue(item) === defaultValue) : undefined;
      if (current) {
        return current;
      }
    }

    const index = Number.parseInt(raw, 10);
    if (Number.isFinite(index) && index >= 1 && index <= items.length) {
      return items[index - 1]!;
    }

    console.log(`[relay-choose] Please enter a number between 1 and ${items.length}.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[relay-choose] ${message}`);
  process.exitCode = 1;
});
