# proof-sdk

## Why this repo is relevant

`proof-sdk` is a strong reference for the next stage after a simple Yjs prototype works: how to expose collaborative state to agents without hiding degraded reads, stale mutation bases, or fallback behavior.

For `mcp-relay`, the most useful part is not a specific edit algorithm. It is the API contract around:

- what an agent is reading
- whether that read is safe to mutate against
- how the agent should identify the exact base state for a write

## Top-down model

The clean mental model in Proof is:

1. `/state` is the whole-document read surface.
2. `/snapshot` is the block-oriented read surface for `edit/v2`.
3. Reads carry explicit freshness and mutability signals.
4. Writes use optimistic concurrency with either `baseRevision` or, preferably, `baseToken`.

That separation is the main design idea worth borrowing.

## Read surfaces

### `/state`

`/api/agent/:slug/state` is the general-purpose read for agents. It returns the whole document plus marks, and it also tells the agent which mutation routes and precondition styles are currently available.

Important details:

- It exposes `mutationBase` when the server can resolve an authoritative base.
- It advertises supported preconditions and a preferred one.
- It links to `/snapshot` and `edit/v2` when that path is enabled.

Key code:

- `server/agent-routes.ts:1974-2083`

### `/snapshot`

`/api/agent/:slug/snapshot` is not just another text read. It is a structured top-level-block view built specifically for block-oriented `edit/v2`.

Each block has:

- `ref`: snapshot-local address like `b1`, `b2`
- `id`: a more stable block identity from `document_blocks`
- `type`
- `markdown`
- optional `textPreview`

The snapshot also returns document-level state such as `revision`, `readSource`, `projectionFresh`, `repairPending`, `mutationReady`, `mutationBase`, and `generatedAt`.

Key code:

- `server/agent-snapshot.ts:94-228`

## Read quality model

Proof does not pretend every successful read is equally trustworthy. The snapshot/state payload makes that explicit.

Important fields:

- `readSource`: where the read came from
  - usually `projection`
  - sometimes `canonical_row`
  - sometimes `yjs_fallback`
- `projectionFresh`: whether the projection is current
- `repairPending`: whether projection repair is still needed/in progress
- `mutationReady`: whether this read is safe to use as the normal base for mutation routes

This is the important idea: a read can succeed while still being marked as degraded.

Examples from the read pipeline:

- healthy projection: `projection_fresh = true`, `mutation_ready = true`, `repair_pending = false`
- canonical-row fallback: `projection_fresh = false`, `mutation_ready = true`, `repair_pending = true`
- Yjs fallback: often `projection_fresh = false`, `repair_pending = true`, and sometimes `mutation_ready = false`

Key code:

- `server/canonical-document.ts:238-280`
- `server/collab.ts:6564-6617`

## Mutation base model

Proof distinguishes two different ways to identify "the version I based my edit on":

### `baseRevision`

This is the coarse version counter. It means:

"Only apply my write if the document revision is still N."

### `baseToken`

This is the stronger optimistic concurrency token. It is derived from:

- normalized markdown
- normalized marks
- `accessEpoch`

So it identifies the authoritative document state more precisely than a plain revision number.

Key code:

- token construction: `server/collab.ts:2580-2611`

### How the API chooses between them

The state route explicitly tells the agent what it prefers:

- prefer `baseToken` when an authoritative mutation base is available
- otherwise fall back to `baseRevision`

Key code:

- `server/agent-routes.ts:2002-2010`

`edit/v2` accepts either `baseToken` or `baseRevision`, but not both. It rejects stale writes with explicit errors and usually includes a fresh snapshot to help the caller recover.

Key code:

- `server/agent-edit-v2.ts:706-900`

## Block model

The most important distinction in the snapshot block payload is:

### `ref` vs `id`

- `ref` is the block address inside one specific snapshot, for example `b3`
- `id` is the more stable block identity stored in `document_blocks`

`edit/v2` operates on `ref`, not `id`.

`id` exists so the system can preserve block identity across revisions when possible.

Key code:

- snapshot block payload: `server/agent-snapshot.ts:118-139`
- stable block ids in storage: `server/db.ts:1216-1227`
- block-id preservation/reuse: `server/db.ts:2058-2138`
- `edit/v2` operation shapes: `server/agent-edit-v2.ts:48-69`

### `markdown` vs `textPreview`

- `markdown` is the real serialized block content
- `textPreview` is a simplified plain-text summary for scanning/disambiguation

That is a good design for agents: one field for exact edits, one field for quick inspection.

## Marks model

Proof splits mark data into:

1. inline anchors in markdown via `<span data-proof="...">...`
2. rich structured metadata in the marks store / Yjs marks map

That means comments and suggestions are not "just markdown syntax." The inline spans mainly anchor marks to content, while richer data such as comment text, suggestion status, replacement content, and proposal metadata lives separately.

This is a useful distinction for `mcp-relay`: text and review metadata should not be forced into one representation.

## Comparison to current `mcp-relay`

`mcp-relay` is currently much simpler and more local:

- `readText()` returns a short-lived in-memory handle plus text
- `applyPatch()` applies a Codex-style patch against the handle's stored text/Yjs state
- stale remote changes are surfaced as `staleHandle`

Proof is broader. It adds:

- explicit degraded-read states
- separate whole-doc and block-doc read surfaces
- an authoritative mutation base token
- a stable block model for structured edits
- recovery guidance when mutations go stale

## What looks especially good

- The API tells the agent whether a read is safe to mutate against instead of making that implicit.
- `/state` and `/snapshot` have clearly different jobs.
- `baseToken` is a stronger and more honest concurrency primitive than revision alone.
- Block `ref` versus persistent block `id` is a clean split.
- Degraded reads are surfaced as part of the public contract, not hidden as implementation detail.

## What I would borrow for `mcp-relay`

- Keep the simple handle model for now, but preserve the same honesty about degraded state.
- If we add richer read APIs later, split whole-document reads from block-oriented edit reads.
- Add a stronger structured stale-state contract instead of just a boolean warning.
- If we ever introduce a server-side canonical layer, make "safe to mutate against" an explicit field like `mutationReady`.
- If we add more than revision-style concurrency, Proof's `mutationBase` / `baseToken` split is a good reference.

## Bottom line

The main lesson from `proof-sdk` is not "use these exact tools." It is:

agent-facing collaboration APIs should say exactly what state the agent is looking at, how trustworthy that read is, and what precise base the next mutation must use.
