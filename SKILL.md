---
name: Obsidian
description: Use Obsidian MCP tools for reading, patching, and live collaborative Markdown editing.
---

Use this skill when working with Obsidian notes through the MCP tools.

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
  patch: "*** Begin Patch\n*** Update File: Projects/Meeting.md\n@@\n-old\n+new\n*** End Patch"
}
```

Patch rules:

- Match against the text returned by `read_text`; do not guess unseen content.
- Prefer one clear file patch per note. Include enough unchanged context.
- If a patch handle is expired or unknown, call `read_text` again.

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

## Common Workflows

Find and read a note:

```text
list_files { query: "plan" }
read_text { path: "Projects/Plan.md", maxChars: 12000 }
```

Patch a known note quickly:

```text
read_text { path: "Notes/Inbox.md" }
apply_patch { patchHandle: "h7k2p", patch: "...Codex update patch..." }
```

Answer "what is selected?" or "rewrite this":

```text
open_edit_session { path: "Drafts/Essay.md", agentName: "Claw" }
get_cursor_context { sessionId: "k8d3q" }
delete_selection { sessionId: "k8d3q" }
insert_text { sessionId: "k8d3q", text: "replacement text" }
clear_selection { sessionId: "k8d3q" }
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

## Behavior Guidelines

- If the user asks to edit the note, edit with tools instead of replying with
  the full replacement text in chat.
- Always inspect the document before non-trivial edits.
- Ask a clarifying question only when the target or intent is genuinely
  ambiguous.
- Preserve exact user-provided text unless asked to rewrite or improve it.
- After editing, give one short summary of what changed. Do not claim a change
  if no tool changed the document.
