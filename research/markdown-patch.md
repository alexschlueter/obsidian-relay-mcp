# markdown-patch

## Why this repo is relevant

This repo is the best reference here for note-oriented Markdown editing semantics.

It answers a different question than our current `mcp-relay`:

- we answer "how do we safely edit a collaborative Yjs-backed text replica?"
- this repo answers "how do we express Markdown edits in a way that matches what people actually mean?"

For Obsidian notes, that second question matters a lot.

## How they implemented the patch model

- The README states the core idea clearly: do structure-aware edits to Markdown instead of treating the file as a blob of text. See `README.md:3-6`.
- The library models patch targets as:
  - `heading`
  - `block`
  - `frontmatter`
  See `src/types.ts:23-30`.
- Patch operations are:
  - `append`
  - `prepend`
  - `replace`
  See `types.ts:25`.
- Patch instructions can also declare:
  - `createTargetIfMissing`
  - `applyIfContentPreexists`
  - `trimTargetWhitespace`
  See `types.ts:57-78` and `README.md:155-166`.
- `getDocumentMap()` parses the Markdown with `marked`, extracts:
  - heading ranges keyed by full heading path
  - block ranges keyed by Obsidian block id
  - frontmatter as parsed YAML
  - original line ending style
  See `src/map.ts:16-251`.
- `applyPatch()` resolves a target from that map, validates the content type, applies the edit, and can create missing headings/frontmatter when allowed. See `src/patch.ts:563-666`.

## Details that are especially well done

- Heading targets are full paths, not fuzzy text matches. See `README.md:102-114` and `map.ts:80-96`.
- Block targets align with Obsidian block ids, which is an excellent fit for note tooling. See `README.md:116-125` and `map.ts:123-180`.
- Frontmatter is treated as structured data instead of raw text splicing. See `README.md:126-166` and `patch.ts:519-655`.
- Table edits are specialized. JSON rows are validated against the table column count before being inserted. See `patch.ts:183-351`.
- The whitespace work is careful. `replaceText()` and `appendText()` preserve blank-line separators and original line endings. See `patch.ts:59-179`.
- By default, appending/prepending fails if the content already appears at the target. That is a very good idempotence guard for agent-driven editing. See `patch.ts:585-598`.

## Comparison to current mcp-relay

Current `mcp-relay` is generic and patch-text oriented:

- `applyPatch()` accepts a single Codex `*** Update File` patch.
- `codexPatch.ts` parses hunks and applies them by matching exact line sequences in the stored text.
- The resulting full text is then pushed back into Yjs via our handle flow.

See `src/relay-core/codexPatch.ts:22-167` and `src/relay-core/relayCore.ts:145-205`.

That means:

- our current layer is better at collaboration/state handling
- `markdown-patch` is better at note semantics

`markdown-patch` itself is not collaborative. It takes one Markdown string in and returns one Markdown string out. It has no model of:

- stale replicas
- concurrent remote edits
- Yjs state
- handle-local editing

So it is not a replacement for our current design.

## What looks especially good for our use case

- `print-map` / `getDocumentMap()` is discovery-first. That is excellent for agents.
- The target model maps well to how Obsidian users think:
  - section by heading
  - block by block ref
  - metadata by frontmatter key
- `createTargetIfMissing` gives controlled upsert semantics without making everything fuzzy.
- The repo's sample notes frame the document as a directly addressable key-value structure, which is a very good mental model for agents operating on notes.

## What I would borrow for mcp-relay

- Add a second-layer API on top of our existing handle system:
  - `getMarkdownMap(handle)`
  - `applyMarkdownPatch(handle, instruction | instruction[])`
- Internally, run those Markdown-structured edits against the handle's stored text, then keep our current Yjs push path.
- Keep `applyPatch()` for generic Codex/code-style workflows.
- Use Markdown-aware tools as the recommended layer for note editing.

The first targets worth supporting would be:

- headings
- frontmatter
- Obsidian block references

Those are exactly where this repo is strongest.

## Bottom line

If `collaborative-ai-editor` shows how to expose CRDT-aware anchors, `markdown-patch` shows how to expose note-aware intent. For `mcp-relay`, the most promising direction is probably both:

- keep the handle/Yjs core we already have
- add a Markdown-structured patch layer on top
