I investigated the first four ideas. No code changes.

**Mental Model**
Relay currently gives us three useful storage shapes:

- Folder index: `filemeta_v0` maps vault paths to resource ids and types.
- Yjs documents: Markdown and Canvas are CRDT documents.
- Blob files: images/PDF/audio/video/other attachments are content-addressed files with hashes.

The MCP client mostly handles the first two only for Markdown.

**1. Canvas And Bases**
Canvas is the easier half. Relay already has Canvas support: `filemeta_v0` has type `canvas`, `S3RN` has `S3RemoteCanvas`, and Canvas data is stored in a Yjs doc with `nodes`, `edges`, and per-text-node `Y.Text`s. See [Canvas.ts](/home/alex/code/Relay/src/Canvas.ts) and [CanvasView.ts](/home/alex/code/Relay/src/CanvasView.ts).

What it would take:

- Add `loadCanvasDocument()` / `readCanvas()` in the relay client.
- Export Canvas JSON the same way Relay does: `nodes` + `edges`, resolving text nodes from their `Y.Text`.
- Add MCP tools like `read_canvas`, maybe `update_canvas_node`, `move_canvas_node`, `insert_canvas_text_node`, `connect_canvas_nodes`.
- Tests should build a Yjs canvas doc with `nodes`, `edges`, and node text.
- Effort: read-only Canvas is small; robust editing is medium because text nodes need special care.

Bases are different. Obsidian Bases are `.base` YAML files; Obsidian’s docs say Bases are database-like views over notes/properties, while the view definition is stored as YAML in a `.base` file or embedded in Markdown. Sources: [Introduction to Bases](https://obsidian.md/help/bases), [Bases syntax](https://obsidian.md/help/bases/syntax).

What it would take:

- For embedded ` ```base ` blocks: existing Markdown tools can already edit them.
- For standalone `.base` files: Relay does not appear to treat `.base` as a special CRDT document today. It would likely be a generic file/blob unless Relay plugin support is added.
- Basic `.base` editing therefore depends on attachment support, or on extending Relay to sync `.base` as a document-like text type.
- Evaluating a base as a table/list/cards result is much bigger: it needs a vault-wide property index, file property derivation, filter parsing, formula evaluation, and sorting/grouping.

Recommendation: implement Canvas before Bases. For Bases, start with “read/write `.base` YAML as text” only after attachment/text-file support exists.

**2. Attachments**
Relay already exposes attachment metadata in `filemeta_v0`: `type`, `hash`, `mimetype`, `synctime`. The MCP client lists attachments but cannot read/write them yet. Relay plugin uses `/file-token`, then `download-url` / `upload-url`; see [LiveTokenStore.ts](/home/alex/code/Relay/src/LiveTokenStore.ts) and [CAS.ts](/home/alex/code/Relay/src/CAS.ts). relay-server exposes the matching file endpoints under `/f/:doc_id/...` in [server.rs](/home/alex/code/relay-server/crates/relay/src/server.rs).

What it would take:

- Extend `RelayAuthClient` with `issueFileToken(resource, hash, contentType, contentLength)`.
- Add a `RelayFileClient` for:
  - `HEAD baseUrl`
  - `GET baseUrl/download-url`, then fetch presigned URL
  - `POST baseUrl/upload-url`, then PUT bytes to presigned URL
- Add `get_attachment_info(path)` and `read_attachment(path)` first.
- For upload/update, compute SHA-256, upload bytes, then update folder `filemeta_v0` with the new hash/mimetype/synctime.
- Decide MCP binary transport: base64 in JSON is simplest, but not ideal for large files.

Recommendation: split this into two phases. Download existing attachments first. Upload/update is harder because it mutates both blob storage and folder metadata.

**3. File Properties**
There are two meanings here.

Note properties are YAML frontmatter in Markdown. Those are easy conceptually because they live inside the existing `contents` Yjs text. Relay already treats metadata UI saves as frontmatter/text changes; see [MetadataRenderer.ts](/home/alex/code/Relay/src/plugins/MetadataRenderer.ts) and [Frontmatter.ts](/home/alex/code/Relay/src/Frontmatter.ts).

What it would take:

- Add a YAML/frontmatter parser dependency, probably `yaml` or `gray-matter`.
- Add tools:
  - `get_note_properties(path)`
  - `set_note_properties(path, properties)`
  - `delete_note_properties(path, keys)`
- Apply edits through the existing Yjs text mutation path.
- Tests for missing frontmatter, existing frontmatter, arrays, links, dates, and preserving body text.

File properties are broader: Obsidian Bases exposes `file.ext`, `file.path`, `file.size`, `file.mtime`, tags, links, embeds, etc. Official Bases syntax distinguishes note properties, file properties, and formula properties: [Bases syntax](https://obsidian.md/help/bases/syntax).

What it would take:

- Easy derived properties: path, name, ext, folder, kind, mimetype, hash.
- Medium: size for Markdown/Canvas/attachments.
- Harder: mtime/ctime. Markdown Yjs docs do not reliably store these; relay-server versions may approximate last changed.
- Hard: tags, links, embeds, backlinks need Markdown parsing and a vault-wide index.

Recommendation: start with frontmatter note properties, not full Obsidian file-property parity.

**4. Scan Relay For More Features**
This one is mostly a research/product-planning task, not runtime code. A useful implementation would be a structured feature-gap doc.

What it would take:

- Scan Relay plugin modules by resource type: Markdown, Canvas, SyncFile, folder metadata, auth, directory, sharing, versions, awareness.
- Compare each feature against MCP coverage.
- Produce a table with: feature, Relay source file, current MCP support, required APIs, risk, suggested MCP tools.
- Keep it in `planning/relay-feature-gap.md`.

A quick scan suggests good candidates beyond the first three:

- create/rename/delete paths via folder metadata
- document versions / last changed info via `/d/:doc_id/versions`
- attachment history via `/f/:doc_id/history`
- Canvas tools
- frontmatter properties
- share-link/frontmatter helpers
- folder/file info tooling

Best implementation order: note properties, read-only Canvas, attachment download, then Canvas editing or attachment upload depending on which is more useful next.