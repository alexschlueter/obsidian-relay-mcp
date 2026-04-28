# obsidian-relay-mcp

`obsidian-relay-mcp` is an MCP server and TypeScript client for working with
[Obsidian](https://obsidian.md/) notes that sync through system3's [Relay](https://relay.md/). It talks to the Relay server
directly, so an agent can read notes, patch Markdown, inspect attachments, and
collaborate in live edit sessions conflict-free and without a running Obsidian desktop instance.

This project is useful when your notes are already in a Relay shared folder and
you want an AI coding or writing agent to work with those notes through MCP.

## Features

- List Relay-backed Obsidian files by vault-relative path.
- Read Markdown notes and apply Codex-style `*** Update File` patches.
- Open live collaborative edit sessions with visible cursor/selection presence.
- Read attachment metadata and temporary download URLs.
- Optionally include text, image, or audio attachment content in MCP results.
- Run as a stdio MCP server, a Streamable HTTP MCP server, or a TypeScript library.

## Limitations

- Only github login for now
- The MCP server does not (yet) expose file creation, rename, delete operations
- Currently restricted to one configured relayId and folderId

## Requirements

- Node.js 22 or newer.
- Access to a Relay account and shared folder.
- A Relay bearer token, usually created by the GitHub login helper.

## Quick Start

Log in to Relay:

```bash
npx -y obsidian-relay-mcp login:github
```

Choose the Relay and shared folder to expose:

```bash
npx -y obsidian-relay-mcp choose-target
```

Run the stdio MCP server:

```bash
npx -y obsidian-relay-mcp
```

By default, credentials are stored in your user config directory, for example
`~/.config/obsidian-relay-mcp/config.json` on Linux. If a `.relay-client.json`
file already exists in the current directory, it is used for local development
compatibility. Set `RELAY_CLIENT_CONFIG` to force a specific config path.

## OpenClaw

OpenClaw stores MCP servers under `mcp.servers`. The easiest setup is to let
OpenClaw launch the package through `npx`:

```text
/mcp set obsidian={"command":"npx","args":["-y","obsidian-relay-mcp"]}
```

If you keep the Relay config in a custom path, pass it explicitly:

```text
/mcp set obsidian={"command":"npx","args":["-y","obsidian-relay-mcp"],"env":{"RELAY_CLIENT_CONFIG":"/absolute/path/to/config.json"}}
```

For local development from a clone:

```text
/mcp set obsidian={"command":"pnpm","args":["mcp:stdio"],"cwd":"/absolute/path/to/obsidian-relay-mcp"}
```

`read_attachment` can return image and audio content directly when content inclusion is
enabled in the server config, which works well with OpenClaw's media handling.
For all attachments, the tool returns metadata and a temporary URL from which the agent can download the file.

## Other MCP Clients

Use the package binary as a stdio server:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-relay-mcp"]
    }
  }
}
```

To run the Streamable HTTP server instead:

```bash
npx -y obsidian-relay-mcp http
```

The HTTP server defaults to `http://127.0.0.1:3333/mcp`.

Optional HTTP environment variables:

- `MCP_RELAY_HOST`
- `MCP_RELAY_PORT`
- `MCP_RELAY_ENDPOINT`
- `MCP_RELAY_ALLOWED_HOSTS`, comma-separated

## Configuration

The client loads configuration from environment variables first, then from the
config file.

Common environment variables:

- `RELAY_CLIENT_CONFIG`: explicit JSON config path.
- `RELAY_API_URL`: Relay control-plane API URL. Defaults to `https://api.system3.md`.
- `RELAY_AUTH_URL`: Relay auth URL. Usually inferred from `RELAY_API_URL`.
- `RELAY_BEARER_TOKEN`: Relay bearer token.
- `RELAY_ID`: default Relay id.
- `RELAY_FOLDER_ID`: default shared folder id.

The saved config may contain a bearer token and auth refresh record. The CLI
writes it with owner-only file permissions where the operating system supports
Unix-style modes.

Example config:

```json
{
  "apiUrl": "https://api.system3.md",
  "relayId": "00000000-0000-0000-0000-000000000000",
  "folderId": "11111111-1111-1111-1111-111111111111",
  "attachments": {
    "includeTextContent": true,
    "maxTextChars": 2000,
    "includeImageContent": true,
    "maxImageContentMB": 2,
    "includeAudioContent": false,
    "maxAudioContentMB": 2
  }
}
```

Attachment inline content is disabled by default. Enable only the content types
you want agents to receive directly. Use the `max...` options to prevent using too many tokens in context.

## MCP Tools

- `list_files`: list or search vault-relative paths.
- `read_text`: read a Markdown note and receive a short-lived `patchHandle`.
- `apply_patch`: apply one Codex-style update patch against a `patchHandle`.
- `read_attachment`: get attachment metadata, temporary download URL, and optional inline content.
- `open_edit_session`: open a live collaborative editing session.
- `close_edit_session`: close a live session and clear its presence.
- `get_cursor_context`: inspect the agent cursor or a collaborator cursor.
- `list_active_cursors`: list collaborator cursor states visible in the session.
- `search_text`: search live Markdown text and create match ids.
- `replace_matches`: replace stored live match ids.
- `place_cursor`: place the agent cursor at a stored match.
- `place_cursor_at_document_boundary`: place the cursor at the start or end.
- `select_text`: select a stored match.
- `select_current_block`: select the current Markdown block.
- `select_between_matches`: select a range between two matches.
- `clear_selection`: collapse the current selection.
- `insert_text`: insert Markdown at the current cursor or selection.
- `delete_selection`: delete the current selection.

Patch handles and live session ids are process-local and expire automatically.
The default patch handle TTL is 60 seconds. The default live session TTL in the
MCP server is 10 minutes.

## TypeScript API

```ts
import { RelayClient } from "obsidian-relay-mcp";

const relay = RelayClient.fromEnv();

const read = await relay.readText("Notes/Plan.md", {
  maxChars: 12000,
  ttlSeconds: 120,
});

const patch = [
  "*** Begin Patch",
  "*** Update File: Notes/Plan.md",
  "@@",
  "-old text",
  "+new text",
  "*** End Patch",
].join("\n");

await relay.applyPatch(read.patchHandle, patch);
```

Useful high-level methods:

- `listFiles(options?)`
- `readText(path, options?)`
- `readAttachment(path, options?)`
- `applyPatch(handle, patch, options?)`
- `patchText(handle, patch, options?)`
- `openEditSession(path, agentName, ttlSeconds?)`
- `searchText(sessionId, query, maxResults?)`
- `insertText(sessionId, text)`
- `closeEditSession(sessionId)`

`applyPatch` and `patchText` return `resultText` only when
`options.returnResult` is `true`.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm mcp:stdio
pnpm mcp:http
```

Live integration tests are skipped unless you provide live Relay test paths:

```bash
RELAY_LIVE_TEST_NOTE_PATH="Notes/Test.md" pnpm test:live
```

## Security Notes

- Treat the Relay config file like a password file.
- Attachment download URLs may be temporary bearer-style URLs; avoid pasting them
  into public logs.
- The HTTP MCP server binds to `127.0.0.1` by default. Be deliberate if you
  change the host or allowed-host settings.

## License

See [LICENSE](./LICENSE).

Non-binding summary:

- Do whatever you want non-commercially, as long as you attribute and include
  the license with substantial portions
- Companies may use internally
- No selling, even as small part in larger project

## Acknowledgements

Relay is made by [system3](https://system3.md/).

The live editing tool interface is inspired by [collaborative-ai-editor](https://github.com/electric-sql/collaborative-ai-editor).

Most of this was written by GPT 5.4 and 5.5.
