# evc-team-relay and evc-team-relay-openclaw-skill

## Why these repos are relevant

These repos are especially valuable because they are not just another Yjs demo. They are an actual agent-facing integration for the Relay ecosystem.

Important distinction:

- `evc-team-relay` is not the same repo as the `relay-server` we are actually connecting to in `/home/alex/code/relay-server`.
- `/home/alex/code/relay-server` is the collaboration engine repo itself. Its README says it is a fork of `jamsocket/y-sweet` and integrates with Relay's Control Plane for auth and permissions. See `/home/alex/code/relay-server/README.md:3-5`.
- `evc-team-relay` is a broader product stack around that kind of server: control plane, web publishing, docs, deployment, and agent integrations. Its README describes live editing as "via y-sweet", and its compose stack runs a separate `relay-server` service. See `README.md:23-30` and `infra/docker-compose.yml:173-185`.
- So this repo pair should be read as evidence about the broader Relay ecosystem and API/product design, not as a 1:1 description of the exact `relay-server` repo we are using.

My best read is:

- not a clone of `/home/alex/code/relay-server`
- but clearly the same technical lineage and product family
- and very possibly a rebrand / repackaging of the wider Relay stack around the same underlying server core

So the most interesting question here is:

"When this Relay-like stack exposes agent tools, what abstraction does it choose?"

The answer is: high-level file tools, not raw CRDT primitives.

## How the agent-facing API is shaped

- `docs/ai-agent-integration.md` recommends an MCP server for Claude Code, Codex CLI, and OpenCode, and a bash-based OpenClaw skill as the fallback path. See `docs/ai-agent-integration.md:43-160`.
- The published MCP tool surface is:
  - `authenticate`
  - `list_shares`
  - `list_files`
  - `read_file`
  - `upsert_file`
  - `read_document`
  - `write_document`
  - `delete_file`
  See `docs/ai-agent-integration.md:143-160`.
- The recommended workflow is discovery first:
  `list_shares -> list_files -> read_file / upsert_file`
  See `docs/ai-agent-integration.md:158-160`.
- The OpenClaw skill mirrors the same design. `SKILL.md` marks `read-file.sh` and `upsert-file.sh` as the recommended tools, while `read.sh` and `write.sh` are low-level doc-id tools. See `evc-team-relay-openclaw-skill/SKILL.md:67-95`.

## How writing is actually implemented

- `upsert-file.sh` is the most instructive script:
  - it lists folder files first
  - resolves `file_path` to an existing `doc_id` if present
  - if the file exists, it does `PUT /v1/documents/{doc_id}/content`
  - if it does not exist, it does `POST /v1/documents/{folder_share_id}/files`
  This is exactly the right behavior for folder shares because file metadata must stay in sync with content.
  See `scripts/upsert-file.sh:36-68`.
- `write.sh` contains an explicit safety check and refuses to write when the user is accidentally treating a folder share like a doc share. The error explains why that would be wrong: the content would update, but Obsidian would never see the file because folder metadata would not be registered correctly. See `scripts/write.sh:32-49`.
- This is a very good guardrail. They did not just document the pitfall; they encoded it in the tool.

## How authentication is handled

- `auth.sh` is intentionally simple: login and print the access token. See `scripts/auth.sh:1-23`.
- The skill docs explain that login returns both `access_token` and `refresh_token`, and that access tokens expire after one hour. See `references/api.md:11-43` and `SKILL.md:97-125`.
- The AI-agent integration doc says the MCP server refreshes tokens automatically, while the shell skill expects re-auth or manual refresh. See `docs/ai-agent-integration.md:160` and `285-291`.

## How the lower-level Relay auth model works

- The control plane exposes `POST /tokens/relay`. See `apps/control-plane/app/api/routers/tokens.py:18-26`.
- `token_service.py` checks share access, then issues an Ed25519-signed CWT relay token scoped to a specific `doc_id` and mode. See `apps/control-plane/app/services/token_service.py:15-78`.
- That means there are really two auth layers: JWT for control-plane REST, and short-lived CWT for relay-server document access.
- The config docs also explain the WebSocket case: browser clients cannot set `Authorization` headers on native WebSocket connections, so the reverse proxy maps `?token=` to `Authorization: Bearer`. See `docs/configuration.md:206-233`.

This also lines up closely with `/home/alex/code/relay-server`, which already has explicit CWT support and audience validation on the server side. See `/home/alex/code/relay-server/crates/relay/src/main.rs:494-498`.

## Comparison to current mcp-relay

Current `mcp-relay` is lower-level and more CRDT-aware:

- it works directly with Yjs document state
- `readText()` returns text plus a local editing handle
- `applyPatch()` edits the handle-local replica and pushes a Yjs delta
- it exposes `staleHandle` to tell the caller when remote peers changed the doc since the read

See `src/relay-core/relayCore.ts:104-205`.

By contrast, the published Team Relay / OpenClaw integration chooses not to expose Yjs directly. It exposes file operations and keeps the CRDT machinery behind the boundary.

That is a strong design signal.

## What looks especially good

- Path-based file access is the default, not an afterthought.
- Folder shares and doc shares are treated as meaningfully different workflows.
- Misuse is prevented with hard tool-level guardrails, not just documentation.
- The MCP server is clearly the "safe, typed, long-lived" path.
- The shell skill is clearly the "simple, transparent, lower-level" path.
- Token refresh is handled in the long-lived server, not reimplemented in every write path.

## What I would borrow for mcp-relay

- Keep high-level path-based tools as the default UX for normal note work.
- Keep low-level document or handle tools as an advanced layer.
- Add guardrails when a low-level operation is semantically wrong for the share type or path context.
- Treat token refresh as a client/session responsibility, not an editing primitive.

Most importantly:

- do not assume that "Relay uses Yjs internally" implies "agents should see raw Yjs operations"

These repos are good evidence for the opposite approach:

- high-level file tools for most workflows
- CRDT-aware internals hidden unless the caller needs something more advanced

## Bottom line

This pair is still a strong external data point for our API design, even though it is not the exact same repo as `/home/alex/code/relay-server`. Its agent-facing integration does not expose raw CRDT methods. It exposes file-level read/upsert/list tools, with strong safety rails, and keeps Yjs internal. That argues for a layered `mcp-relay` API:

- default layer: high-level note/file tools
- advanced layer: handle-based or anchor-based CRDT-aware editing
