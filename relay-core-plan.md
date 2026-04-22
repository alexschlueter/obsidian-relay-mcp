# relay-core plan

## Goal

Build a small headless `relay-core` inside `mcp-relay` that can talk to Relay directly, without Obsidian, so an MCP server can:

- resolve a vault path inside a Relay shared folder
- read the current markdown contents from Relay
- apply markdown edits as Yjs updates
- let Relay/Obsidian peers receive those changes normally
- avoid filesystem-watcher misses and Obsidian merge dialogs

This is for private use, so the plan should optimize for "works reliably" over "generic library for everyone."

## What already exists

From the current repos, the useful pieces are already pretty clear:

- `Relay/src/LiveTokenStore.ts` shows the plugin-compatible token exchange. It posts to `/token` with `{ docId, relay, folder }` and gets back a client token for a concrete Relay resource.
- `Relay/src/S3RN.ts` defines the resource identity model we should keep: relay, folder, document, canvas, file.
- `Relay/src/SharedFolder.ts` and `Relay/src/SyncStore.ts` show that path mapping is not a filesystem trick. The folder itself is a shared Yjs document, and create/rename/delete are represented there.
- `Relay/src/SharedFolder.ts` also shows that rename/delete mostly happen by mutating the shared folder metadata, not by calling some special Obsidian API.
- `relay-server/python/src/relay_sdk/connection.py` shows the raw document surface once you already know a doc id: `GET /d/{docId}/as-update`, `POST /d/{docId}/update`, and websocket access.
- `relay-git-sync/relay_client.py` and `relay-git-sync/sync_engine.py` show the simplest useful way to resolve paths from Relay itself: load the folder doc and read `filemeta_v0`.
- `relay-server/crates/y-sweet-core/src/webhook.rs` shows webhooks are notifications only. They tell you a document changed, but they do not replace reading the actual Yjs document.
- `relay-server-template/README.md` makes the deployment split explicit: the Relay control plane handles login and permissions, while the self-hosted relay-server only serves documents and verifies signed tokens.

## Critical architecture note

There are two different API surfaces involved in a normal Relay deployment.

### 1. Relay control plane API

This is the API the Obsidian plugin is primarily written against.

Observed responsibilities:

- login and user session management
- relay/folder/host metadata
- self-host registration
- host health checks
- config/template endpoints
- minting short-lived client tokens for a specific Relay resource via `/token` and `/file-token`

Observed plugin-facing routes:

- `POST /token`
- `POST /file-token`
- `GET /relay/{relay_guid}/check-host`
- `GET /flags`
- `GET /whoami`
- `POST /api/collections/relays/self-host`
- `GET /templates/relay.toml`
- `GET /api/collections/relays/records/{id}/relay.toml`

### 2. Self-hosted relay-server API

This is the lower-level document server.

Observed responsibilities:

- verify signed server/doc/file tokens
- return document-scoped client tokens from `/doc/{docId}/auth`
- serve Yjs update endpoints
- serve websocket transport
- serve file upload/download endpoints
- emit webhooks

Observed direct routes:

- `POST /doc/new`
- `POST /doc/{docId}/auth`
- `GET /d/{docId}/as-update`
- `POST /d/{docId}/update`
- `GET /d/{docId}/ws/{docId2}`
- file endpoints under `/f/...`

### Why this matters for `relay-core`

The plugin asks for access using logical Relay coordinates:

- `relayId`
- `folderId`
- resource id such as `documentId`

The bare relay-server does not know that higher-level request shape. It deals in concrete server-side document ids and signed bearer tokens.

There is also an id translation layer:

- business logic should use Relay resource ids and S3RN values
- at the Yjs I/O boundary, the actual document id may be a compound id such as `relayId-documentId`
- `relay-git-sync` explicitly treats compound ids as an I/O detail only

Fresh-session implementation rule:

- keep resource ids and path metadata separate internally
- only construct compound doc ids at the transport boundary
- do not leak compound ids through the internal API unless direct-server mode truly requires it

## Recommendation

Do not try to extract half of the Obsidian plugin into a library.

For `relay-core`, the cheaper and safer move is:

- copy or lightly adapt the stable protocol/data-model pieces
- reimplement a very small headless path index around `filemeta_v0`
- use raw Yjs document fetch/update for actual edits
- leave Obsidian-only classes out completely

That means:

- keep `S3RN` or a near-copy of it
- do not port `LoginManager`, `EndpointManager`, `RelayManager`, `LocalStorage`, `customFetch`, `SharedFolder`, `Document`, or `HasProvider` wholesale
- do not depend on Obsidian events, disk buffers, IndexedDB, or Electron request helpers

The recommended v1 stance is:

- default to a small control-plane-compatible mode
- accept explicit config/env instead of recreating PocketBase login or tenant-license validation
- treat direct relay-server mode as optional and secondary

## Target shape

`relay-core` should be a small TypeScript package inside `mcp-relay`, because:

- the existing Relay plugin code is TypeScript
- the MCP server will likely also be TypeScript/Node
- it is easier to reuse or port small pieces from `Relay` than to bridge two runtimes

Suggested modules:

- `src/relay-core/s3rn.ts`
- `src/relay-core/auth.ts`
- `src/relay-core/folderIndex.ts`
- `src/relay-core/docClient.ts`
- `src/relay-core/textPatch.ts`
- `src/relay-core/relayCore.ts`

## Minimal responsibilities

### 1. `auth.ts`

Purpose:

- hold credentials supplied by config/env
- default to control-plane token minting for Relay resources
- optionally support direct relay-server access later
- return short-lived client tokens for folder/docs/files

Keep it simple:

- no browser login flow
- no PocketBase integration
- no tenant-license validation in v1
- no persistent token cache at first
- maybe a tiny in-memory cache keyed by S3RN with expiry

Recommended modes:

- `control-plane` mode, recommended for v1:
  - inputs: `RELAY_API_URL`, `RELAY_BEARER_TOKEN`
  - use `/token` and `/file-token`
  - this is the closest match to how the plugin already works
  - this should preserve normal Relay permission checks and host selection
- `direct-server` mode, optional later:
  - inputs: `RELAY_SERVER_URL`, privileged server token or API key
  - use `/doc/{docId}/auth` and then `/d/{docId}/...`
  - this is more admin-oriented and bypasses the normal higher-level control-plane surface

Important notes:

- the Obsidian plugin talks to a Relay API surface that knows `relay` + `folder` + `docId`
- the bare `relay-server` repo exposes direct doc auth by `docId`
- `/doc/{docId}/auth` on relay-server expects a privileged bearer token, not a normal plugin user session
- `relay-core` v1 should assume control-plane mode unless there is a concrete need to run without it

### 2. `s3rn.ts`

Purpose:

- represent Relay resources in a stable way
- encode and decode resource ids
- keep relay id, folder id, and document id together

This can be almost a straight copy from `Relay/src/S3RN.ts`.

### 3. `folderIndex.ts`

Purpose:

- load the folder Yjs document
- read `filemeta_v0`
- expose path-to-resource and resource-to-path lookup

Implementation idea:

- do not port the full `SyncStore`
- instead, reimplement the tiny subset we need for server-side use:
- read `filemeta_v0`
- normalize paths
- store `{ path, id, type, hash, mimetype }`
- build `byPath` and `byId` maps

`relay-git-sync` is the best reference for this smaller model.

### 4. `docClient.ts`

Purpose:

- fetch a document as a Yjs update
- materialize it into a local `Y.Doc`
- mutate it
- send a Yjs delta back

For markdown docs:

- the content lives in `ydoc.getText("contents")`

Recommended initial transport:

- use plain HTTP `as-update` and `update`
- do not build a long-lived websocket provider first

Why:

- it is simpler in a server/MCP environment
- it is enough for request/response edits
- it still produces Relay-native Yjs updates

Important mode-specific behavior:

- in control-plane mode:
  - ask `/token` for a client token using resource coordinates
  - use the returned `clientToken.docId`, `clientToken.url`, and `clientToken.baseUrl`
- in direct-server mode:
  - call `/doc/{docId}/auth` on the relay-server
  - this assumes you already know the correct server-side doc id

### 5. `textPatch.ts`

Purpose:

- apply edits to a Yjs text node in a way that is less destructive than "delete all, insert all"

Recommendation:

- support both `replaceText` and `patchText`
- make MCP tools prefer patch-style edits
- use a diff-based text mutation so concurrent edits merge more sensibly

This matters because Yjs will merge concurrent updates, but blind full-document replacement can produce ugly interleavings.

### 6. `relayCore.ts`

Purpose:

- give the rest of the app one small API

Suggested API:

- `loadFolder(relayId, folderId)`
- `resolvePath(folder, path)`
- `readText(relayId, folderId, path)`
- `writeText(relayId, folderId, path, newText)`
- `patchText(relayId, folderId, path, transform)`
- later: `createText`, `renamePath`, `deletePath`

## MVP scope

The MVP should only handle:

- one configured Relay deployment
- one or a few known shared folders
- existing markdown files
- read, write, and patch by path
- control-plane mode by default

The MVP should explicitly not try to handle:

- binary file uploads
- canvas
- full folder tree sync
- background websocket subscriptions
- fancy auth/session refresh
- PocketBase login flows
- tenant-license validation
- multiple concurrent agents with lock orchestration
- a generic public SDK

## Configuration for v1

Prefer explicit config over discovery logic.

Required in recommended mode:

- `RELAY_API_URL`
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`

Optional later:

- `RELAY_SERVER_URL`
- `RELAY_SERVER_TOKEN`

Fresh-session rule:

- a fresh agent should not begin by implementing login
- it should begin with env/config-driven access and only add discovery/login if that later becomes necessary

## How write operations should work

For `patchText(relayId, folderId, path, ...)`:

1. Request a client token for the folder resource.
2. Fetch the folder Yjs doc and read `filemeta_v0`.
3. Resolve the target path to a resource id and type.
4. Request a client token for that document resource.
5. Fetch the current Yjs update bytes.
6. Create a local `Y.Doc` and apply the remote update.
7. Read `contents` as the current markdown string.
8. Apply a text patch or replace operation locally.
9. Encode only the local delta.
10. Send that delta with `POST /d/{docId}/update`.
11. Invalidate the cached folder/doc entry.

Why this is the right path:

- the edit enters Relay as a real Yjs update
- Relay should distribute it to connected Obsidian clients the same way it distributes human edits
- no filesystem watcher is involved
- no Obsidian disk merge dialog should be needed for this path

## How path mutations should work later

For rename/delete/create, the source of truth is the shared folder document, not the local filesystem.

### Rename and delete

The plugin code strongly suggests these are mostly folder-doc mutations:

- `deleteFile` removes the path from shared folder state
- `renameFile` moves the path inside shared folder state

So phase 2 should implement:

- load folder doc
- mutate `filemeta_v0` or the minimal equivalent shared map
- send the Yjs update back through Relay

### Create

Create is the only part I would treat as "test before assuming."

The plugin flow uses placeholders and then creates/uploads the actual doc object. That means create may need:

- a new document id
- a new filemeta entry in the folder doc
- an initialized markdown Yjs document with `contents`

I would not over-design this before testing. For private use, the best plan is:

- get read/write on existing notes working first
- then port the smallest possible create flow from `SharedFolder.placeHold`, `createDoc`, and `uploadDoc`

## Webhooks

Webhooks are useful, but not required for v1.

Use them only for:

- cache invalidation
- waking up a background process
- noticing that the folder doc changed elsewhere

Do not treat them as the source of truth. The payload only tells you that a document changed.

## Practical implementation order

### Phase 1: core read path

- scaffold `mcp-relay` as a small TS project
- port `S3RN`
- implement control-plane token exchange
- implement folder-doc loading
- parse `filemeta_v0`
- resolve a markdown path and read its contents

Success condition:

- given a Relay id, folder id, and path, the tool prints the exact current markdown from Relay

### Phase 2: core write path

- implement Yjs fetch/update helpers
- implement `replaceText`
- implement `patchText`
- test edits while an Obsidian client is open on another machine

Success condition:

- the remote Obsidian client receives the update as a normal Relay edit, with no manual conflict step

### Phase 3: MCP wrapper

- add a thin MCP server around `relay-core`
- expose a tiny tool surface

Suggested first tools:

- `relay_read_note`
- `relay_patch_note`
- `relay_write_note`

### Phase 4: path mutations

- add `rename`
- add `delete`
- add `create`

Only do this after phase 2 is working reliably.

## Testing checklist

Manual tests are enough at first:

- read an existing note by path
- patch an existing note while Obsidian is closed
- patch an existing note while Obsidian is open elsewhere
- make a human edit in Obsidian, then patch again from MCP
- verify no filesystem-based merge dialog appears
- verify Relay sends the change to another machine without waiting for disk rescans

Small automated tests worth adding:

- S3RN encode/decode round-trip
- folder `filemeta_v0` parser
- path normalization
- Yjs text patch application

## Assumptions I would use unless you want to change them

- private-use only
- TypeScript/Node implementation
- env-supplied control-plane bearer token in v1
- markdown-only for v1
- existing notes first, create/rename/delete second
- no attempt to support direct disk edits
- no attempt to reproduce the plugin login UX
- direct relay-server mode is optional, not the default implementation path

## Main open question

The only decision I think materially changes the first implementation is this:

- should v1 stop at editing existing markdown notes by path
- or do you want create/rename/delete in the first pass too

My recommendation is to stop at existing-note read/write first. That is the smallest thing that solves your actual reliability problem.
