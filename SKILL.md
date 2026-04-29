---
name: obsidian-relay-mcp
description: Use an MCP server to work with Obsidian notes that sync through system3's Relay. It talks to the Relay server directly, so an agent can read notes, patch Markdown, inspect attachments, and collaborate in live edit sessions without requiring a running Obsidian desktop instance.
---

[Relay](https://relay.md/) is a "multiplayer" plugin and syncing backend for Obsidian, which uses Conflict-free Replicated Data Types for smart conflict resolution during concurrent editing. [obsidian-relay-mcp](https://github.com/alexschlueter/obsidian-relay-mcp) combines
- a client that connects directly to a Relay server without requiring a running Obsidian instance with
- an MCP server that exposes tools for agents to interact with the Obsidian files.

Use this skill when working with Obsidian notes and attachments through the MCP tools.

## Choose The Editing Mode

### Mode A: Snapshot / patch editing

Use for:

- Larger structured edits.
- Lower-collaboration contexts.
- Deterministic transformations.
- Fast batch edits when the agent is working alone.

Workflow:

1. Discover paths with `list_files` if the path is not known.
2. Read the note with `read_text`; keep the returned `patchHandle`.
3. Apply a Codex-style `*** Update File` patch with `apply_patch`.
4. If the result has `staleHandle: true`, mention that the note changed since
   the snapshot and re-read before doing follow-up edits.

Example:

```text
list_files { query: "meeting", pathPrefix: "Projects" }
read_text { path: "Projects/Meeting.md", ttlSeconds: 60 }
apply_patch {
  patchHandle: "abc12",
  path: "Projects/Meeting.md",
  patch: "*** Begin Patch\n*** Update File: Projects/Meeting.md\n@@ ## Decisions\n context line 1\n context line 2\n context line 3\n-old line to remove\n+new line to add\n context line 4\n context line 5\n context line 6\n*** End Patch"
}
```

Patch rules:

- Match against the text returned by `read_text`; do not guess unseen content.
- If a patch handle is expired or unknown, call `read_text` again.
- The patch must start with `*** Begin Patch` and end with `*** End Patch`.
- Use exactly one `*** Update File: <path>` operation.
- Multiple hunks per patch are supported and are applied in order.
- Each hunk starts with `@@`; text after `@@` is an optional search hint, such as a Markdown heading.
- Hunk lines begin with one prefix character: space for unchanged context, `-` for removed text, `+` for added text.
- Include about 3 unchanged context lines before and after each change when possible.
- If nearby text is repeated, add one or more specific `@@` hints to identify the right section.
- Match the current note text exactly. For long single-line paragraphs, the whole changed line must be replaced.

### Mode B: Live collaboration

Use for:

- Human-in-the-loop note editing.
- Cursor/selection questions: "What do you think about this?"; "Explain this term to me" etc.
- Small to medium interactive edits.
- Concurrent editing situations.

Workflow:

1. Open with `open_edit_session`; pass a short required `agentName`.
2. Inspect the current cursor/selection with `get_cursor_context`, or list user
   cursors with `list_active_cursors` when the user says "my cursor", "here",
   "this selection", or similar.
3. Use `search_text` before selecting or placing the cursor unless the current
   cursor context already identifies the target.
4. Make atomic edits with `select_text`, `select_current_block`,
   `replace_matches`, `insert_text`, or `delete_selection`.
5. Clear selection with `clear_selection` when finished unless the selection is
   intentionally left as a visual hint for the user.
6. Close the session with `close_edit_session` when the conversation / interactive work is done.

Example:

```text
open_edit_session { path: "Drafts/Post.md", agentName: "Claw" }
get_cursor_context { sessionId: "ed731", maxCharsBefore: 200, maxCharsAfter: 200 }
search_text { sessionId: "ed731", query: "TODO", maxResults: 10 }
select_text { sessionId: "ed731", matchId: "9ab31" }
insert_text { sessionId: "ed731", text: "DONE" }
clear_selection { sessionId: "ed731" }
close_edit_session { sessionId: "ed731" }
```

Live collaboration rules:

- **Do not select and replace the whole document or large chunks in live mode, as it is disorienting for the user and risks overwriting concurrent user work**
- Every open edit session in a document creates a profile symbol visible for the user. Do not open more than one session for each document at a time to prevent clutter.
- Selections and cursor moves are visible to the user. Keep them purposeful and
  clear them after work to avoid visual clutter.
- Prefer small, reviewable edits: exact phrase replacement, current block
  rewrite, insertion at a known cursor, or deletion of a selected span.
- For multiple exact phrase replacements, use `search_text` to gather matches
  and `replace_matches` rather than editing one by one.
- For top or end insertions, use `place_cursor_at_document_boundary` instead of
  searching for a nearby phrase.
- If a match is stale, search again before editing.
- If a session is expired or closed, open a new session.

## Attachments

Use `list_files` to discover attachments. Attachment entries have
`kind: "attachment"` and are read with `read_attachment`.

Basic workflow:

1. Read the note with `read_text` if you need to find embedded links such as
   `![[image.png]]` or `[report](Files/report.pdf)`.
2. Resolve the vault-relative attachment path. Use `list_files` if the link is
   ambiguous or relative to a folder.
3. Call `read_attachment { path }`.

`read_attachment` always returns a first text content item containing JSON:

```json
{
  "ok": true,
  "url": "https://...",
  "contentType": "image/png",
  "contentLength": 12345,
  "expiresAt": "2026-04-26T12:00:00.000Z",
  "hash": "sha256...",
  "text": "decoded text, if requested and text-like",
  "contentLimitExceeded": true
}
```

Field notes:

- `url` is the direct Relay download URL. It may be temporary, so download the file if you need it later.
- `contentLimitExceeded: true` means the requested inline content was shortened or dropped because it hit the configured limit.
- `text` is included only for text-like attachments when text inclusion is enabled.

In addition to the JSON, `read_attachment` may return inline image or audio content.
Inline content options are controlled first by the MCP server config. Tool
arguments for a content type are only available when that type is enabled in the
server config. When enabled, inline content is included by default; pass the
matching `include...Content: false` argument to opt out for a call.

Available tool arguments, when exposed by the server:

- `includeTextContent`
- `maxTextChars`
- `includeImageContent`
- `maxImageContentMB`
- `includeAudioContent`
- `maxAudioContentMB`

Relevant `.relay-client.json` server config example:

```json
{
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

## More Common Workflows

Find and read a note:

```text
list_files { query: "plan" }
read_text { path: "Projects/Plan.md", maxChars: 12000 }
```

Patch a known note quickly:

```text
read_text { path: "Notes/Inbox.md" }
apply_patch {
  patchHandle: "h7k2p",
  patch: "*** Begin Patch\n*** Update File: Notes/Inbox.md\n@@ ## Today\n context line 1\n context line 2\n context line 3\n-old line to remove\n+new line to add\n context line 4\n context line 5\n context line 6\n*** End Patch"
}
```

Edit where a collaborator is working:

```text
list_active_cursors { sessionId: "k8d3q" }
get_cursor_context { sessionId: "k8d3q", userId: "user-123" }
```

Append to a note in live mode:

```text
place_cursor_at_document_boundary { sessionId: "k8d3q", boundary: "end" }
insert_text { sessionId: "k8d3q", text: "\n\nNew paragraph..." }
```
