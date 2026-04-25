# mcp-relay

`mcp-relay` now contains a headless `relay-client` TypeScript package for reading and updating Relay-backed Obsidian notes without running Obsidian itself.

The first pass is intentionally narrow: it focuses on existing markdown notes inside a Relay shared folder, and it writes changes back as native Yjs updates so Relay and Obsidian peers receive them through the normal sync path.

## Current Scope

Implemented in this repo:

- control-plane token exchange through `POST /token`
- shared-folder loading through the folder Yjs document
- `filemeta_v0` parsing and path resolution
- reading existing markdown notes by path while creating in-memory edit handles
- applying Codex-style `*** Update File` patches against stored Yjs handle state
- opening live edit sessions over the Relay websocket provider
- reading and publishing awareness cursor/selection state
- markdown-source cursor, selection, search, and edit helpers for live sessions
- MCP server wrappers for stdio and Streamable HTTP
- writing existing markdown notes by path
- diff-based Yjs text mutations for less destructive updates under the hood
- focused tests for S3RN handling, folder parsing, and text patching

Explicitly not implemented yet:

- create, rename, or delete flows
- binary upload and download tooling
- direct relay-server admin mode

## Background

This repo exists to support an MCP server that can operate on Obsidian documents from a machine other than the desktop where Obsidian is running.

Relevant local references:

- Relay plugin: `/home/alex/code/Relay`
- Relay server API notes: [server-api.md](/home/alex/code/mcp-relay/server-api.md)
- relay-client implementation plan: [relay-client-plan.md](/home/alex/code/mcp-relay/relay-client-plan.md)
- relay-server template: `/home/alex/code/relay-server-template`
- relay-server source: `/home/alex/code/relay-server`
- relay webhook client: `/home/alex/code/relay-git-sync`

## Project Layout

- [src/relay-client/auth.ts](/home/alex/code/mcp-relay/src/relay-client/auth.ts): control-plane token exchange and short-lived token caching
- [src/relay-client/folderIndex.ts](/home/alex/code/mcp-relay/src/relay-client/folderIndex.ts): `filemeta_v0` parsing, path normalization, and resource lookup
- [src/relay-client/docClient.ts](/home/alex/code/mcp-relay/src/relay-client/docClient.ts): fetch and push Yjs updates over Relay HTTP endpoints
- [src/relay-client/liveProvider.ts](/home/alex/code/mcp-relay/src/relay-client/liveProvider.ts): headless websocket sync and awareness provider
- [src/relay-client/liveSession.ts](/home/alex/code/mcp-relay/src/relay-client/liveSession.ts): markdown-source live edit session tools
- [src/relay-client/codexPatch.ts](/home/alex/code/mcp-relay/src/relay-client/codexPatch.ts): restricted Codex `*** Update File` patch parsing and application
- [src/relay-client/textPatch.ts](/home/alex/code/mcp-relay/src/relay-client/textPatch.ts): diff and replace helpers for `Y.Text`
- [src/relay-client/relayClient.ts](/home/alex/code/mcp-relay/src/relay-client/relayClient.ts): high-level API for loading folders, minting edit handles, and applying handle-based patches
- [src/mcp/relayMcpServer.ts](/home/alex/code/mcp-relay/src/mcp/relayMcpServer.ts): MCP tool registration with snake_case tool names and camelCase arguments
- [src/mcp/stdioServer.ts](/home/alex/code/mcp-relay/src/mcp/stdioServer.ts): stdio MCP transport entrypoint
- [src/mcp/httpServer.ts](/home/alex/code/mcp-relay/src/mcp/httpServer.ts): Streamable HTTP MCP endpoint

## Configuration

Recommended v1 environment variables:

- `RELAY_API_URL`
- `RELAY_AUTH_URL` for GitHub login helpers or non-default auth domains
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`
- `RELAY_CLIENT_CONFIG` optional path to the local JSON config file

`RELAY_ID` and `RELAY_FOLDER_ID` are optional if you always pass them explicitly to the API methods, but they make the default `readText`, `writeText`, and `applyPatch` calls much cleaner.

If `RELAY_API_URL` is not set, `relay-client` now defaults to `https://api.system3.md`.

If `.relay-client.json` exists in the current working directory, `RelayClient.fromEnv()` will also load settings from that file and use them as fallbacks for:

- `apiUrl`
- `authUrl`
- `bearerToken`
- `relayId`
- `folderId`

Environment variables still win over the config file.

## API

The main entry point is `RelayClient`.

```ts
import { RelayClient } from "mcp-relay";

const relay = RelayClient.fromEnv();

const { text, patchHandle } = await relay.readText("Notes/Plan.md");
const nextText = `${text}\n- synced from relay-client`;

const patch = [
  "*** Begin Patch",
  "*** Update File: Notes/Plan.md",
  "@@",
  ...toPatchLines(text, "-"),
  ...toPatchLines(nextText, "+"),
  "*** End Patch",
].join("\n");

const result = await relay.applyPatch(patchHandle, patch);

await relay.writeText("Notes/Scratch.md", "# Replaced\n\nThis note was rewritten.");

function toPatchLines(value: string, prefix: "+" | "-"): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (value.endsWith("\n")) {
    lines.pop();
  }
  return lines.map((line) => `${prefix}${line}`);
}
```

You can also pass the Relay coordinates explicitly:

```ts
const relay = RelayClient.fromEnv();

const opened = await relay.readText(
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "Notes/Plan.md",
);
```

`readText(...)` now returns:

- `text`: the current markdown string
- `patchHandle`: a fresh in-memory edit handle tied to the full Yjs state that was read
- `handle`: deprecated compatibility alias for `patchHandle`
- `totalChars`, `startChar`, `endChar`, and `truncated`: window metadata for partial reads

Handles are process-local and in-memory only. Every `readText(...)` call returns a new 5-character `patchHandle`, even for the same note. The default handle TTL is 60 seconds. You can override it or request a text window with an options object:

```ts
const windowed = await relay.readText("Notes/Plan.md", {
  startChar: 1000,
  maxChars: 2000,
  ttlSeconds: 120,
});
```

`applyPatch(...)` accepts a Codex-style patch with exactly one `*** Update File:` operation. The patch path is required inside the patch text. You may also pass the path as a separate argument, and `relay-client` will validate that both paths match the handle's stored document path.

`applyPatch(...)` and `patchText(...)` accept `options.returnResult`, which defaults to `true`. Set it to `false` if you only need the `changed` / `staleHandle` flags and want to skip returning the local post-patch text.

If remote peers changed the note after the handle was created, `applyPatch(...)` still applies your patch against the handle's local Yjs state and returns `staleHandle: true`. In that case, the returned `resultText` is the handle's local post-patch text, not necessarily a fully refreshed merged server snapshot.

High-level methods currently available:

- `loadFolder()`
- `loadFolder(relayId, folderId)`
- `resolvePath(folder, path)`
- `listFiles(options?)`
- `readText(path, optionsOrTtlSeconds?)`
- `readText(relayId, folderId, path, optionsOrTtlSeconds?)`
- `applyPatch(handle, patch, options?)`
- `applyPatch(handle, path, patch, options?)`
- `patchText(handle, patch, options?)`
- `patchText(handle, path, patch, options?)`
- `writeText(path, nextText)`
- `writeText(relayId, folderId, path, nextText)`

Live collaboration methods are separate from patch handles. `openEditSession(...)` creates a live websocket-backed Yjs session, publishes the agent cursor to Obsidian collaborator presence, and returns a 5-character `sessionId`. Live tools mutate the live `Y.Text` immediately. Match-consuming methods can omit `sessionId` when all match ids come from one known live session.

```ts
const { sessionId } = await relay.openEditSession("Notes/Plan.md", "Codex");

const matches = await relay.searchText(sessionId, "TODO");
await relay.selectText(sessionId, matches.matches[0].matchId);
await relay.insertText(sessionId, "DONE");

const cursors = await relay.listActiveCursors(sessionId);
```

Live-session methods:

- `openEditSession(path, agentName, ttlSeconds?)`
- `openEditSession(relayId, folderId, path, agentName, ttlSeconds?)`
- `closeEditSession(sessionId)`
- `getCursorContext(sessionId, options?)`
- `listActiveCursors(sessionId)`
- `searchText(sessionId, query, maxResults?)`
- `replaceMatches(sessionId, matchIds, text)`
- `placeCursor(sessionId, matchId, edge?)`
- `placeCursorAtDocumentBoundary(sessionId, boundary)`
- `selectText(sessionId, matchId)`
- `selectCurrentBlock(sessionId)`
- `selectBetweenMatches(sessionId, startMatchId, endMatchId, startEdge?, endEdge?)`
- `clearSelection(sessionId)`
- `insertText(sessionId, text)`
- `deleteSelection(sessionId)`

## MCP Server

The MCP server exposes the configured Obsidian note folder only. It loads auth and target settings through `RelayClient.fromEnv()`, then requires `RELAY_ID` and `RELAY_FOLDER_ID` to be present through env or `.relay-client.json`. Tool calls take vault-relative `path` values; agents do not choose sync targets.

Run over stdio for local MCP clients:

```bash
cd /home/alex/code/mcp-relay
pnpm mcp:stdio
```

Run over Streamable HTTP:

```bash
cd /home/alex/code/mcp-relay
pnpm mcp:http
```

The HTTP server defaults to `http://127.0.0.1:3333/mcp`. Optional env vars:

- `MCP_RELAY_HOST`
- `MCP_RELAY_PORT`
- `MCP_RELAY_ENDPOINT`
- `MCP_RELAY_ALLOWED_HOSTS`, comma-separated

MCP tools:

- `list_files`: discover vault-relative Obsidian paths. Optional `query`, `pathPrefix`, `maxResults`, `offset`.
- `read_text`: read markdown by `path`; returns `text`, window metadata, and `patchHandle`. Optional `ttlSeconds`, `startChar`, `maxChars`.
- `apply_patch`: apply a Codex-style update patch by `patchHandle`. Optional `path` guard and `returnResult`.
- `open_edit_session`: open a live edit session by `path` and required `agentName`. Optional `ttlSeconds`, default 600.
- `close_edit_session`: close a live edit session.
- `get_cursor_context`: inspect the agent cursor or an Obsidian collaborator cursor by `userId`, `userName`, or `clientId`.
- `list_active_cursors`: list visible Obsidian collaborator cursors for a live session.
- `search_text`: search live Markdown text and return short match ids plus context.
- `replace_matches`: replace stored live match ids.
- `place_cursor`: place the agent cursor at a stored match.
- `place_cursor_at_document_boundary`: place the agent cursor at document start or end.
- `select_text`: select a stored match.
- `select_current_block`: select the current Markdown source block.
- `select_between_matches`: select a range between two stored matches.
- `clear_selection`: collapse the current selection.
- `insert_text`: insert raw Markdown at the agent cursor or replace the current selection.
- `delete_selection`: delete the current selection.

The MCP server intentionally does not expose `writeText`, create/rename/delete file operations, arbitrary range deletion, or sync target selection arguments.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm login:github
pnpm choose:target
pnpm mcp:stdio
pnpm mcp:http
```

Verified in this workspace:

- `pnpm check`
- `pnpm vitest run`
- `pnpm build`

## Live Test

There is now a real integration test for a live Relay-backed note, with an optional read-only attachment check:

- [test/liveRelay.integration.test.ts](/home/alex/code/obsidian-relay-mcp/test/liveRelay.integration.test.ts)

The live test file needs credentials and a sync target from saved config or env:

- `RELAY_API_URL`
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`

The note tests additionally need `RELAY_LIVE_TEST_NOTE_PATH`.

Run the read-only note smoke test:

```bash
RELAY_API_URL=...
RELAY_BEARER_TOKEN=...
RELAY_ID=...
RELAY_FOLDER_ID=...
RELAY_LIVE_TEST_NOTE_PATH="Path/To/Safe-Test-Note.md" \
pnpm test:live
```

To verify only attachment downloads, point the test at a small attachment in the same vault:

```bash
RELAY_API_URL=...
RELAY_BEARER_TOKEN=...
RELAY_ID=...
RELAY_FOLDER_ID=...
RELAY_LIVE_TEST_ATTACHMENT_PATH="Path/To/Image.png" \
pnpm vitest run test/liveRelay.integration.test.ts -t "reads a configured attachment"
```

`RELAY_LIVE_TEST_ATTACHMENT_MAX_BYTES` defaults to `5000000`.

If you already saved credentials into `.relay-client.json`, you can omit `RELAY_API_URL` and `RELAY_BEARER_TOKEN`, and you can omit `RELAY_ID` / `RELAY_FOLDER_ID` too if those are also stored in the config.

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
It also saves the returned token and auth record into `.relay-client.json`, which `RelayClient.fromEnv()` will load automatically later.

## Choose Relay Target

Once you have a saved or env-provided bearer token, you can fetch the relays and shared folders available to that account, choose one interactively, and save the selected GUIDs into `.relay-client.json`:

```bash
cd /home/alex/code/mcp-relay
pnpm choose:target
```

The chooser:

- loads auth from env or `.relay-client.json`
- refreshes the saved bearer token if needed
- lists available `relays`
- lists shared folders for the selected relay
- saves the selected `RELAY_ID` and `RELAY_FOLDER_ID` back into `.relay-client.json`

This makes the later `RelayClient.fromEnv()` and `pnpm test:live` flows simpler because they can pick up the saved target automatically.

## Notes

- `relay-client` uses the control-plane-compatible `/token` flow, not privileged direct relay-server auth.
- Folder entries inside `filemeta_v0` are treated as metadata within the shared folder, not as standalone Relay document resources.
- `readText(...)` stores the fetched Yjs document state behind a random in-memory handle; the handle itself does not embed auth.
- `openEditSession(...)` stores a live local Yjs replica and awareness state behind a random in-memory session id; the session id itself does not embed auth.
- `applyPatch(...)` validates and applies only `*** Update File` patches, and it matches them against the handle's stored text exactly.
- Successful handle patches are sent back as Yjs deltas generated from the stored handle state, so Relay peers should receive them like normal collaborative edits.
- Failed handle pushes do not persist the local handle mutation.
- Live search match ids are also 5 characters. Anchors remain internal; tool responses return match ids, source positions, and context snippets.
- Live match-consuming tools validate that the text at the anchored position still matches before editing. If not, they return a structured stale-match result instead of editing.
- Relay bearer tokens do expire. The saved GitHub login config includes the auth record, and `relay-client` will attempt a PocketBase `authRefresh()` automatically when the bearer token is close to expiry.
