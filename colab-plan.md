## Design

- all ids should be 5 chars
- wire up the live provider / awareness from relay server to get and send presence and cursor states
- add openEditSession(path, agentName, ttlSeconds) method that returns a sessionId and creates a new edit session for the doc at path which saves cursor state and publishes agentName in awareness. does not return text. cleans up automatically after ttl. if used after cleanup, expired error
- port over the following methods from collaborative-ai-editor and wire them up with the relay server. each tool takes a sessionId as first mandatory argument, unless they can infer sessionId from matchIds, then sessionId is optional. work on Y doc directly instead of prosemirror:
- before using a matchId, check if matches still matches at the stored position in current live Y doc, else return stale error

  - `get_selection_snapshot` and `get_cursor_context` merged as one tool getCursorContext.
  It takes an optional userId and clientId arg identifying the user from which we want the cursor state. if both not given, take our session cursor. if both name and id given, assert match. if only name given and name matches multiple cursors, return sensible error msg noting to check listActiveCursors and use clientId instead.
  if cursor has selection, return payload as in get_selection_snapshot but with fields renamed selectedText, selectedFrom and selectTo. else return payload as in get_cursor_context

  - `search_text` use 5 chars uuid instead. save matches. response payload should be list of matches, where each match only has matchId, before and after text and startPos as absolute pos in current text
  - `replace_matches`: leave out contentFormat arg. don't need it since we edit markdown source directly.
  - `place_cursor`: dont return anchor
  - `place_cursor_at_document_boundary` dont return anchor
  - `insert_paragraph_break` leave out
  - `select_text` port
  - `select_current_block` sensible block selection in Markdown instead of prosemirror, also return blockType e.g. "list" "heading" "code block" "table" "frontmatter"
  - `select_between_matches` return text at beginning and end of selection as well
  - `clear_selection` port
  - `set_format` leave out
  - `insert_text` no contentFormat, always raw
  - `delete_selection` return numCharsDeleted instead of bool
  - `start_streaming_edit` and `stop_streaming_edit` leave out

- add startChar and maxChars to readText same as in get_document_snapshot. rename handle from readText to patchHandle. return text, totalChars, startChar, endChar, truncated: true/false and patchHandle
- add listActiveCursors(sessionId) returning list of {userName, userId, clientId from awareness, hasSelection}
- live tools edit the live doc immediately, dont use patchHandle
- agent cursor is published to Relay awareness
