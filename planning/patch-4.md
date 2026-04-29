## Compact Patch Format

Use this format to edit one existing note:

```text
*** Begin Patch
*** Update File: path/to/note.md
@@ ## Section heading or other unique nearby text
 unchanged context line
-old line to remove
+new line to add
 unchanged context line
*** End Patch
```

Rules:

- The patch must start with `*** Begin Patch` and end with `*** End Patch`.
- Use exactly one `*** Update File: <path>` operation.
- Multiple hunks per patch are supported and are applied in order.
- Each hunk starts with `@@`; text after `@@` is an optional search hint, such as a Markdown heading.
- Hunk lines begin with one prefix character: space for unchanged context, `-` for removed text, `+` for added text.
- Include about 3 unchanged context lines before and after each change when possible.
- If nearby text is repeated, add one or more specific `@@` hints to identify the right section.
- Match the current note text exactly. For long single-line paragraphs, the whole changed line must be replaced.
