# mcp-relay

`mcp-relay` now contains a headless `relay-core` TypeScript package for reading and updating Relay-backed Obsidian notes without running Obsidian itself.

The first pass is intentionally narrow: it focuses on existing markdown notes inside a Relay shared folder, and it writes changes back as native Yjs updates so Relay and Obsidian peers receive them through the normal sync path.

## Current Scope

Implemented in this repo:

- control-plane token exchange through `POST /token`
- shared-folder loading through the folder Yjs document
- `filemeta_v0` parsing and path resolution
- reading existing markdown notes by path
- writing and patching existing markdown notes by path
- diff-based Yjs text mutations for less destructive updates
- focused tests for S3RN handling, folder parsing, and text patching

Explicitly not implemented yet:

- create, rename, or delete flows
- binary upload and download tooling
- background websocket subscriptions
- login flows or session refresh logic
- direct relay-server admin mode
- MCP server wrappers

## Background

This repo exists to support an MCP server that can operate on Obsidian documents from a machine other than the desktop where Obsidian is running.

Relevant local references:

- Relay plugin: `/home/alex/code/Relay`
- Relay server API notes: [server-api.md](/home/alex/code/mcp-relay/server-api.md)
- relay-core implementation plan: [relay-core-plan.md](/home/alex/code/mcp-relay/relay-core-plan.md)
- relay-server template: `/home/alex/code/relay-server-template`
- relay-server source: `/home/alex/code/relay-server`
- relay webhook client: `/home/alex/code/relay-git-sync`

## Project Layout

- [src/relay-core/auth.ts](/home/alex/code/mcp-relay/src/relay-core/auth.ts): control-plane token exchange and short-lived token caching
- [src/relay-core/folderIndex.ts](/home/alex/code/mcp-relay/src/relay-core/folderIndex.ts): `filemeta_v0` parsing, path normalization, and resource lookup
- [src/relay-core/docClient.ts](/home/alex/code/mcp-relay/src/relay-core/docClient.ts): fetch and push Yjs updates over Relay HTTP endpoints
- [src/relay-core/textPatch.ts](/home/alex/code/mcp-relay/src/relay-core/textPatch.ts): patch and replace helpers for `Y.Text`
- [src/relay-core/relayCore.ts](/home/alex/code/mcp-relay/src/relay-core/relayCore.ts): high-level API for loading folders and editing notes by path

## Configuration

Recommended v1 environment variables:

- `RELAY_API_URL`
- `RELAY_AUTH_URL` for GitHub login helpers or non-default auth domains
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`

`RELAY_ID` and `RELAY_FOLDER_ID` are optional if you always pass them explicitly to the API methods, but they make the default `readText`, `writeText`, and `patchText` calls much cleaner.

If `RELAY_API_URL` is not set, `relay-core` now defaults to `https://api.system3.md`.

If `.relay-core.json` exists in the current working directory, `RelayCore.fromEnv()` will also load settings from that file and use them as fallbacks for:

- `apiUrl`
- `authUrl`
- `bearerToken`
- `relayId`
- `folderId`

Environment variables still win over the config file.

## API

The main entry point is `RelayCore`.

```ts
import { RelayCore } from "mcp-relay";

const relay = RelayCore.fromEnv();

const markdown = await relay.readText("Notes/Plan.md");

await relay.patchText("Notes/Plan.md", (current) => {
  return `${current}\n- synced from relay-core`;
});

await relay.writeText("Notes/Scratch.md", "# Replaced\n\nThis note was rewritten.");
```

You can also pass the Relay coordinates explicitly:

```ts
const relay = RelayCore.fromEnv();

const markdown = await relay.readText(
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "Notes/Plan.md",
);
```

High-level methods currently available:

- `loadFolder()`
- `loadFolder(relayId, folderId)`
- `resolvePath(folder, path)`
- `readText(path)`
- `readText(relayId, folderId, path)`
- `writeText(path, nextText)`
- `writeText(relayId, folderId, path, nextText)`
- `patchText(path, transform)`
- `patchText(relayId, folderId, path, transform)`

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm login:github
pnpm choose:target
```

Verified in this workspace:

- `pnpm check`
- `pnpm vitest run`
- `pnpm build`

## Live Test

There is now a real integration test for a live Relay-backed note:

- [test/liveRelay.integration.test.ts](/home/alex/code/mcp-relay/test/liveRelay.integration.test.ts)

It stays skipped unless these env vars are set:

- `RELAY_API_URL`
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`
- `RELAY_LIVE_TEST_NOTE_PATH`

Run the read-only smoke test:

```bash
RELAY_API_URL=...
RELAY_BEARER_TOKEN=...
RELAY_ID=...
RELAY_FOLDER_ID=...
RELAY_LIVE_TEST_NOTE_PATH="Path/To/Safe-Test-Note.md" \
pnpm test:live
```

If you already saved credentials into `.relay-core.json`, you can omit `RELAY_API_URL` and `RELAY_BEARER_TOKEN`, and you can omit `RELAY_ID` / `RELAY_FOLDER_ID` too if those are also stored in the config.

If you want the test to verify the write path too, enable the reversible round-trip step:

```bash
RELAY_API_URL=...
RELAY_BEARER_TOKEN=...
RELAY_ID=...
RELAY_FOLDER_ID=...
RELAY_LIVE_TEST_NOTE_PATH="Path/To/Safe-Test-Note.md" \
RELAY_LIVE_TEST_WRITE=1 \
pnpm test:live
```

The write variant appends a unique marker, waits until it can read that marker back through Relay, then removes it again and checks that the note returns to its original contents. Use a disposable or low-risk scratch note while testing.

## GitHub Login

If you do not want to pull `RELAY_BEARER_TOKEN` out of Obsidian localStorage manually, you can now fetch a fresh Relay auth token through the same GitHub OAuth provider flow the plugin uses.

Run:

```bash
cd /home/alex/code/mcp-relay
pnpm login:github
```

If your Relay deployment uses a non-default auth host, set `RELAY_AUTH_URL` too:

```bash
cd /home/alex/code/mcp-relay
RELAY_API_URL=https://api.example.com \
RELAY_AUTH_URL=https://auth.example.com \
pnpm login:github
```

The command prints a GitHub login URL, waits for the OAuth callback to reach Relay, then prints shell `export` lines for `RELAY_BEARER_TOKEN` and the resolved auth settings.
It also saves the returned token and auth record into `.relay-core.json`, which `RelayCore.fromEnv()` will load automatically later.

## Choose Relay Target

Once you have a saved or env-provided bearer token, you can fetch the relays and shared folders available to that account, choose one interactively, and save the selected GUIDs into `.relay-core.json`:

```bash
cd /home/alex/code/mcp-relay
pnpm choose:target
```

The chooser:

- loads auth from env or `.relay-core.json`
- refreshes the saved bearer token if needed
- lists available `relays`
- lists shared folders for the selected relay
- saves the selected `RELAY_ID` and `RELAY_FOLDER_ID` back into `.relay-core.json`

This makes the later `RelayCore.fromEnv()` and `pnpm test:live` flows simpler because they can pick up the saved target automatically.

## Notes

- `relay-core` uses the control-plane-compatible `/token` flow, not privileged direct relay-server auth.
- Folder entries inside `filemeta_v0` are treated as metadata within the shared folder, not as standalone Relay document resources.
- Text writes are sent back as Yjs deltas generated from the loaded document state, so Relay peers should receive them like normal collaborative edits.
- Relay bearer tokens do expire. The saved GitHub login config includes the auth record, and `relay-core` will attempt a PocketBase `authRefresh()` automatically when the bearer token is close to expiry.
