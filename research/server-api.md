# Relay server API overview

This file captures the architecture split that matters for `relay-client`.

## TL;DR

There are two different APIs in a normal Relay setup:

- the Relay control plane API
- the self-hosted `relay-server` API

The Obsidian plugin talks to both, but it relies on the control plane for login, permissions, host registration, and resource-to-token translation.

For `relay-client`, the recommended v1 path is:

- use the control-plane-compatible `/token` flow
- treat the bare relay-server as the low-level Yjs transport behind that

## 1. Relay control plane API

This is the higher-level API the plugin is written around.

Responsibilities seen in the code and docs:

- login and user session management
- tenant/license validation
- relay and shared-folder metadata
- self-host registration
- host health checks
- feature flags
- whoami
- minting client tokens for concrete Relay resources

Observed plugin-facing endpoints:

- `POST /token`
- `POST /file-token`
- `GET /relay/{relay_guid}/check-host`
- `GET /flags`
- `GET /whoami`
- `POST /api/collections/relays/self-host`
- `GET /templates/relay.toml`
- `GET /api/collections/relays/records/{id}/relay.toml`

Important behavior:

- the plugin sends logical Relay coordinates such as `{ docId, relay, folder }`
- the control plane decides whether the user may access that resource
- the control plane returns a client token with the actual document connection info

## 2. Self-hosted `relay-server` API

This is the lower-level document server.

Responsibilities:

- verify signed bearer tokens
- mint document-scoped client tokens from `/doc/{docId}/auth`
- serve Yjs update endpoints
- serve websocket transport
- serve file upload/download endpoints
- emit webhooks

Observed endpoints:

- `POST /doc/new`
- `POST /doc/{docId}/auth`
- `GET /d/{docId}/as-update`
- `POST /d/{docId}/update`
- `GET /d/{docId}/ws/{docId2}`
- file endpoints under `/f/...`

Important behavior:

- this API is document-oriented, not Relay-resource-oriented
- it expects a concrete server-side `docId`
- `/doc/{docId}/auth` expects a privileged bearer token
- it does not implement user login or Relay permission logic by itself

## 3. Why the split exists

The server template states this directly:

- the control plane handles login and permissions
- the self-hosted server trusts tokens signed by the control plane

The template TOML also shows this:

- the relay-server is configured with Relay public keys
- that means it verifies tokens
- the issuer lives elsewhere

So the relay-server is not the whole product surface. It is the document backend.

## 4. Ids: logical resource ids vs server doc ids

Internally, the useful business identifiers are:

- `relayId`
- `folderId`
- `documentId` or `canvasId` or `fileId`

At the Yjs transport boundary, there is evidence of a compound document id convention such as:

- folder doc: `relayId-folderId`
- document doc: `relayId-documentId`

`relay-git-sync` explicitly treats this compound id as an I/O boundary detail, not a business-logic type.

Implementation rule:

- inside `relay-client`, keep resource ids separate
- only build compound ids at the transport boundary when needed

## 5. What the plugin expects

The plugin does not just call `/doc/{docId}/auth` directly.

Instead it:

- logs into a separate auth service
- resolves `apiUrl` and `authUrl`
- posts to `/token` with `{ docId, relay, folder }`
- receives a `ClientToken`
- uses `clientToken.url`, `clientToken.baseUrl`, `clientToken.docId`, and `clientToken.token`

That means the plugin-facing `/token` API is doing more than the bare relay-server route:

- permission check
- host/provider selection
- logical-resource to concrete-doc translation
- token minting

## 6. What `relay-client` should implement

### Recommended v1: control-plane mode

Inputs:

- `RELAY_API_URL`
- `RELAY_BEARER_TOKEN`
- `RELAY_ID`
- `RELAY_FOLDER_ID`

Behavior:

- ask `/token` for a folder token
- read folder `filemeta_v0`
- resolve path to document resource
- ask `/token` again for the target document
- fetch and update the document through the returned Yjs endpoints

Why this is best:

- closest to existing plugin behavior
- preserves normal Relay permission checks
- should work the same way with self-hosted providers
- avoids recreating login and host lookup logic

### Optional later: direct-server mode

Inputs:

- `RELAY_SERVER_URL`
- privileged server token or API key

Behavior:

- construct the concrete server-side doc id yourself
- call `/doc/{docId}/auth`
- then use `/d/{docId}/as-update` and `/d/{docId}/update`

Why this is not the default:

- it is more admin-oriented
- it assumes you possess privileged server credentials
- it bypasses the higher-level control-plane surface the plugin already uses

## 7. Webhooks

Webhooks belong to the self-hosted server side and are only notifications.

Use them for:

- cache invalidation
- wakeups
- noticing external changes

Do not use them as the source of truth for document contents or path metadata.

## 8. Fresh-session implementation checklist

A fresh agent should assume:

- do not build login first
- do not port PocketBase first
- do not port large Obsidian classes
- implement env-driven control-plane mode first
- use `filemeta_v0` as the source of path mapping
- use Yjs update fetch/apply/send for actual document edits

The companion file `relay-client-plan.md` is the implementation plan. This file is the architectural boundary map that explains which API each step should talk to.
