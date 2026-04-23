# OpenClaw / Obsidian collaboration tools critique

## Overall assessment

The current Obsidian collaboration tools are already useful for real live editing, but they are still too easy to misuse. The core strengths are visible cursor-aware collaboration, context inspection, and safe stale-match rejection. The main weaknesses are unclear mode boundaries, weak discoverability, and the absence of a few high-value "safe primitives" for common editing tasks.

In short: the foundation is good, but the UX is not yet foolproof.

## What works well

### 1. Live collaboration is genuinely possible
The current tool set supports a real collaborative workflow:
- opening an edit session
- listing active cursors
- inspecting cursor context
- inserting text
- clearing selection

That is already enough to answer questions like "what is selected right now?" and to perform focused edits in an open note.

### 2. Cursor context is strong
`get_cursor_context` is especially valuable because it exposes not just cursor location, but also:
- whether a selection exists
- the selected text
- surrounding text (`before` / `after`)

That makes it a strong primitive for collaborative editing and debugging.

### 3. Stale-match rejection is the right default
The fact that match-based replacement fails when the underlying document changed is a good design choice. In a collaborative environment, aborting on drift is much safer than writing into changed text.

## Main weaknesses

### 1. The model split is unclear: snapshot editing vs live collaboration
Right now it is too unclear when to use:
- `read_text` + patch-style editing
- versus live-session tools

The docs should explicitly frame two modes:

#### Mode A: Snapshot / patch editing
Use for:
- larger structured edits
- lower-collaboration contexts
- deterministic transformations

#### Mode B: Live collaboration
Use for:
- human-in-the-loop note editing
- cursor/selection questions
- small to medium interactive edits
- concurrent editing situations

This distinction should appear early and explicitly in the documentation.

### 2. `replace_matches` is too easy to misunderstand
This is currently one of the biggest UX traps.

Current semantics appear to be:
- you provide multiple `matchIds`
- and one replacement text
- therefore every match receives the exact same replacement text

That is technically consistent, but easy to misuse if the caller expects per-match replacements.

#### Recommendation
Strengthen the tool description substantially, for example:

> Replaces every provided match with the same replacement text.
> Not suitable for different per-match replacements.

#### Better long-term option
Add a separate tool such as:
- `replace_matches_individually`
  - `replacements: [{ matchId, text }, ...]`

That would make bulk editing much more natural and remove a major footgun.

### 3. There is no clean "replace whole document" primitive
A common recovery flow or rewrite flow is: replace the entire note text atomically.

Right now this requires more fragile live-edit sequences like:
- select everything
- delete selection
- insert replacement text

#### Recommendation
Add one of:
- `replace_document_text`
- `set_document_text`

Ideally with optional revision checking:
- `expectedRevision`
- `failIfChanged`

This would make full rewrites much safer and simpler.

### 4. There is no `select_all`
For live editing, this is a very basic primitive and its absence creates awkward workarounds.

#### Recommendation
Add:
- `select_all_text(sessionId)`

or equivalent.

### 5. File discovery is missing
The tools are much harder to use if the caller does not already know the exact path.

#### Recommendation
Add:
- `list_files(pathPrefix?, recursive?)`
- `list_folder(pathPrefix?)`
- `search_files(query)`

Even a minimal listing tool would improve usability significantly.

### 6. There is no direct notion of "the user's active note"
A very common collaboration question is not just "what is selected?" but:
- which note is the user currently in?
- what note should I inspect if I want to collaborate in context?

#### Recommendation
Add:
- `get_active_note(userId?)`

or a richer context tool that returns:
- active note path
- current cursor
- current selection
- visible pane/tab context

### 7. Cursor ownership is still too indirect
`list_active_cursors` is useful, but in practice the caller wants ergonomic ways to refer to:
- the agent's own cursor
- the human collaborator's cursor
- a collaborator by name

#### Recommendation
Allow more tools to accept:
- `self: true`
- `collaborator: "Alexander Schlüter"`
- or `userName`

instead of always requiring cursor IDs.

### 8. Session expiry errors are too vague
An error like `Unknown Relay edit session` leaves too much ambiguity.

#### Recommendation
Differentiate clearly between:
- unknown session id
- expired session
- closed session

This would help debugging a lot.

### 9. Live revision / change metadata is too thin
In collaborative editing, it is helpful to know:
- current document revision
- whether the note changed since a match was found
- who changed it, if available

#### Recommendation
Expose more revision-oriented metadata through session info or cursor-context calls, for example:
- `documentRevision`
- `lastChangedAt`
- `lastChangedBy`

### 10. Agent-created selections have large visible side effects
Selections are highly visible to the human collaborator. That is useful, but the side effect is strong enough that it should be treated as first-class UX behavior.

#### Recommendation for docs
Add an explicit warning such as:

> Selection-based tools create visible collaborative selections in the user's editor. Clear them when they are no longer needed.

#### Recommendation for tooling
Consider:
- transient selections
- automatic clear-after-inspection options

## Documentation improvements

### 1. Add a "common workflows" section
This would be high leverage. Include short examples for:
- what is selected right now?
- append text at the end of the current note
- replace the same term in multiple places
- copy note content to another note using live tools only
- recover safely after stale matches
- collaborate without leaving visible selections behind

### 2. Add warnings to the risky tools
Especially for:
- `replace_matches`
- selection-heavy tools
- deletion tools

### 3. Clarify field semantics
The docs should say more explicitly:
- what `selectedText` refers to in multi-cursor situations
- how `before` / `after` are defined when a selection exists
- whether opening a session can create a missing note
- what assumptions hold under concurrent edits

## Suggested priority order

### Highest priority
1. Clarify `replace_matches` semantics in the docs
2. Add `select_all_text`
3. Add `replace_document_text` / `set_document_text`
4. Add file discovery (`list_files` or similar)
5. Add `get_active_note(userId?)`

### Medium priority
6. Improve session-expiry error reporting
7. Improve revision metadata
8. Improve collaborator targeting ergonomics

### Nice to have
9. transient selections
10. dry-run / preview modes
11. richer undo / history visibility

## Minimal high-impact improvement set

If only a few changes are feasible in the near term, these would likely pay off fastest:

1. make `replace_matches` semantics extremely explicit
2. add `select_all_text`
3. add `list_files`

Those three changes alone would remove a large share of the current friction.
