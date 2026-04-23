# collaborative-ai-editor

## Why this repo is relevant

This repo is the strongest example of an agent editing a live collaborative document by operating on the live replica, not by shipping whole-document rewrites around.

For our use case, the important question is not "does it use Yjs?" but "what agent-facing tools does it expose on top of Yjs?" Their answer is: stable search handles, cursor/selection tools, semantic edits, and streaming insertion.

## How they implemented the editing model

- `DocumentToolRuntime` is a per-session in-memory runtime that stores cursor state, selection state, search matches, and any active streaming edit. See `src/lib/agent/documentToolRuntime.ts:314-357`.
- The runtime keeps agent-local state as encoded anchors:
  - `cursorAnchorBytes`
  - `selectionStartBytes`
  - `selectionEndBytes`
  - a `matches` map keyed by `matchId`
  See `documentToolRuntime.ts:315-320`.
- Search is handle-based, not offset-based. `searchText()` walks text blocks, finds exact matches, and stores:
  - `matchId`
  - preview context
  - `startAnchorB64`
  - `endAnchorB64`
  See `documentToolRuntime.ts:495-529`.
- Those anchors are Yjs relative positions encoded to base64 via `Y.encodeRelativePosition` / `Y.decodeRelativePosition`. See `src/lib/agent/relativeAnchors.ts:11-67`.
- The public tool surface is intentionally semantic. `documentTools.ts` defines:
  - `get_document_snapshot`
  - `get_selection_snapshot`
  - `get_cursor_context`
  - `search_text`
  - `replace_matches`
  - `place_cursor`
  - `place_cursor_at_document_boundary`
  - `insert_paragraph_break`
  - `select_text`
  - `select_current_block`
  - `select_between_matches`
  - `clear_selection`
  - `set_format`
  - `insert_text`
  - `delete_selection`
  - `start_streaming_edit`
  - `stop_streaming_edit`
  See `src/lib/agent/documentTools.ts:7-268`.


- Concise tool reference:
  - `get_document_snapshot(startChar?, maxChars?)` - Read a plain-text slice of the current document. Args: `startChar` absolute char offset, `maxChars` max returned chars.
  - `get_selection_snapshot()` - Read the current selection if one exists. Args: none.
  - `get_cursor_context(maxCharsBefore?, maxCharsAfter?)` - Read nearby plain-text context around the current cursor. Args: chars before / after the cursor to include.
  - `search_text(query, maxResults?)` - Find exact text and return stable match handles plus preview context. Args: `query` exact search string, `maxResults` cap on matches.
  - `replace_matches(matchIds, text, contentFormat?)` - Replace several previously found matches in one operation. Args: `matchIds` handle list, `text` replacement, `contentFormat` = `plain_text` or `markdown`.
  - `place_cursor(matchId, edge?)` - Move the agent cursor to a match boundary. Args: `matchId`, `edge` = `start` or `end`.
  - `place_cursor_at_document_boundary(boundary)` - Move the cursor to the document start or end. Args: `boundary` = `start` or `end`.
  - `insert_paragraph_break()` - Insert a new empty paragraph block at the current cursor. Args: none.
  - `select_text(matchId)` - Select the exact range represented by a match handle. Args: `matchId`.
  - `select_current_block()` - Select the whole current text block around the cursor. Args: none.
  - `select_between_matches(startMatchId, endMatchId, startEdge?, endEdge?)` - Create a selection from one match boundary to another. Args: start / end match handles plus optional edges.
  - `clear_selection()` - Clear the current selection while keeping cursor state. Args: none.
  - `set_format(kind, format, action?, level?)` - Apply or toggle formatting on the current selection. Args: `kind` = `mark` or `block`; `format` = `bold|italic|code|paragraph|heading|bullet_list|ordered_list`; `action` = `add|remove|toggle|set`; `level` for headings.
  - `insert_text(text, contentFormat?)` - Insert or replace at the current cursor / selection. Args: `text`, `contentFormat` = `plain_text` or `markdown`.
  - `delete_selection()` - Delete the current selection if present. Args: none.
  - `start_streaming_edit(mode, contentFormat?)` - Arm a streaming prose insertion / rewrite session. Args: `mode` = `continue|insert|rewrite`, `contentFormat` = `plain_text` or `markdown`.
  - `stop_streaming_edit()` - Stop an active streaming edit session. Args: none.
- Actual edits happen against the live Yjs-backed ProseMirror document. `insertText()` and `replaceMatches()` resolve anchors back into current positions and mutate the session directly. See `documentToolRuntime.ts:798-897`.

## How they handle concurrency

- Concurrency is handled by anchoring agent intent to Yjs relative positions, not to raw string offsets.
- The clearest proof is the test `continue writing while a collaborator edits nearby keeps the insertion semantically anchored`. A collaborator inserts text nearby after the agent placed the cursor, and the agent's streamed insertion still lands in the intended place. See `tests/agent/naturalPromptScenarios.test.ts:235-249`.
- This is the "full CRDT power" path: edits are attached to a live replica plus relocatable anchors, not reconstructed later from a plain-text patch.

## Comparison to current mcp-relay

Our current `mcp-relay` is similar in one important way: it also keeps per-session local state in memory. `readText()` stores a handle with:

- Yjs state update
- stored plain text
- TTL
- one lock per handle

See `src/relay-client/relayClient.ts:104-127`.

The big difference is what the handle means:

- In `collaborative-ai-editor`, the handle-like objects are semantic anchors inside a live collaborative session.
- In `mcp-relay`, the handle is a frozen local replica plus stored text, and `applyPatch()` applies a Codex `*** Update File` patch against that stored text exactly. See `src/relay-client/relayClient.ts:145-205` and `src/relay-client/codexPatch.ts:22-167`.

So today:

- they expose anchor-based semantic tools on top of CRDT state
- we expose patch-based text editing on top of CRDT state

That means our current design is simpler and more generic, but it is not using the most interesting Yjs primitive yet.

## What looks especially good

- Search returns stable handles instead of asking the model to reason about raw indices.
- `replace_matches` lets the model do repeated exact replacements in one operation.
- Cursor and selection are explicit first-class state, which is much easier for an agent than manufacturing diff syntax.
- Streaming edit is a very good fit for generated prose.
- Their tests are excellent. They do not just test happy-path edits; they test edits under collaborator interference.

## What I would borrow for mcp-relay

- Add `searchText(handle, query)` that returns `matchId`s backed by Yjs-relative anchors.
- Add targeted edit tools on top of a handle:
  - `replaceMatches(handle, matchIds, text)`
  - `insertAtMatch(handle, matchId, edge, text)`
  - maybe `selectBetweenMatches(handle, ...)`
- Keep `applyPatch()` for generic Codex/code-style editing.
- Treat semantic anchor tools as the advanced CRDT-native layer.

## Bottom line

This repo is good evidence that "use Yjs well" does not mean "expose raw `Y.Text.insert/delete` methods." It means: keep the replica local, anchor intent to that replica, and expose agent-friendly operations that survive concurrent edits.
