**Short Answer**

OpenClaw uses the official MCP SDK, `@modelcontextprotocol/sdk@1.29.0`, but the exact MCP client path depends on the agent backend:

- With the OpenAI Codex CLI backend, OpenClaw injects your `mcp.servers` config into `codex exec` via `-c mcp_servers=...`, so Codex CLI’s own MCP client handles the server. See [openclaw/extensions/openai/cli-backend.ts](/home/alex/code/openclaw/extensions/openai/cli-backend.ts:21) and [bundle-mcp.ts](/home/alex/code/openclaw/src/agents/cli-runner/bundle-mcp.ts:224).
- In OpenClaw’s embedded/PI agent runtime, OpenClaw itself uses `@modelcontextprotocol/sdk/client/index.js` and transports for stdio/SSE/streamable HTTP. See [pi-bundle-mcp-runtime.ts](/home/alex/code/openclaw/src/agents/pi-bundle-mcp-runtime.ts:3) and [mcp-transport.ts](/home/alex/code/openclaw/src/agents/mcp-transport.ts:1).

**Resource Handling**

MCP itself supports `resource` and `resource_link`; the installed SDK’s content union includes `TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource`. See [spec.types.d.ts](/home/alex/code/openclaw/node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts:1602).

But OpenClaw does not currently route a PDF returned as an MCP `resource` into the PDF tool automatically.

What I found:

- ACP prompt handling extracts text from embedded text resources, and turns `resource_link` into a plain textual URI. Only `image` blocks become attachments. See [event-mapper.ts](/home/alex/code/openclaw/src/acp/event-mapper.ts:245).
- OpenClaw’s dynamic tool bridge only converts tool output content of type `text` or `image` into Codex input items. See [dynamic-tools.ts](/home/alex/code/openclaw/extensions/codex/src/app-server/dynamic-tools.ts:248).
- Codex app-server protocol can represent MCP tool results as raw `content` plus `structuredContent`, and it has a resource-read response shape with `text` or `blob`, but I did not find a bridge that says “this blob is a PDF, call the `pdf` tool now.” See [McpToolCallResult.ts](/home/alex/code/openclaw/extensions/codex/src/app-server/protocol-generated/typescript/v2/McpToolCallResult.ts:6) and [ResourceContent.ts](/home/alex/code/openclaw/extensions/codex/src/app-server/protocol-generated/typescript/ResourceContent.ts:9).

**PDF Tool**

OpenClaw’s `pdf` tool is good, but it wants a reference it can open: local path, `file://`, `http(s)`, or `media://inbound/<id>`. In sandbox mode, remote URLs are rejected. See [docs/tools/pdf.md](/home/alex/code/openclaw/docs/tools/pdf.md:71) and [pdf-tool.ts](/home/alex/code/openclaw/src/agents/tools/pdf-tool.ts:356).

So the best handoff for Relay attachments is not “return a PDF as MCP `resource` and hope the harness notices.” It is:

1. Agent reads the note.
2. Agent finds `![[file.pdf]]` or a normal attachment path.
3. Agent calls a Relay MCP tool that materializes the attachment to disk.
4. Tool returns `localPath`, `fileUri`, MIME type, size, and hash.
5. Agent calls OpenClaw’s `pdf` tool with `{ "pdf": localPath }`.

For our MCP server, I’d add something like `export_attachment` alongside `read_attachment`. It should write to a controlled cache dir, preferably hash-addressed, and return:

```json
{
  "ok": true,
  "path": "docs/report.pdf",
  "localPath": "/tmp/obsidian-relay-mcp/attachments/<sha256>/report.pdf",
  "fileUri": "file:///tmp/obsidian-relay-mcp/attachments/<sha256>/report.pdf",
  "contentType": "application/pdf",
  "contentLength": 123456,
  "sha256": "..."
}
```

That same pattern is also best for `docx`, `xlsx`, etc. I found MIME recognition for those in OpenClaw, but not a dedicated automatic DOCX/XLSX harness bridge like the PDF tool. Local path is still the most composable handoff.

For text attachments, we should return decoded text directly as `text` content when safe, plus metadata in `structuredContent`; no need to force the agent through a file tool for plain text.

---

**1. Remote MCP Server**

If `obsidian-relay-mcp` runs on another machine, an exported `/tmp/...` path is only useful on that remote machine. OpenClaw cannot read it unless there is a shared filesystem, a mounted network path, or a URL that OpenClaw can fetch.

So a server-local `export_attachment` is not a good primary protocol. It is only a same-host convenience.

For remote-safe handoff, the bytes need to cross the boundary as one of:

- MCP `resource` with a base64 `blob`
- MCP tool result with base64 in `structuredContent`
- a temporary HTTP(S) URL OpenClaw can fetch
- an OpenClaw-side tool that downloads/imports the attachment itself

For PDFs and Office files, the best shape is: get bytes to OpenClaw, then let OpenClaw create the local/media reference.

**2. Sandboxed OpenClaw Agent**

A random host tmp path is also weak with sandboxing. Even same machine, `/tmp/obsidian-relay-mcp/foo.pdf` may not be visible inside the agent’s sandbox, and OpenClaw’s PDF tool rejects remote HTTP URLs when sandboxed. See [pdf-tool.ts](/home/alex/code/openclaw/src/agents/tools/pdf-tool.ts:356).

OpenClaw already has the right building blocks:

- `saveMediaBuffer(...)` stores bytes in OpenClaw’s media store under `media/inbound` and returns an id/path. See [store.ts](/home/alex/code/openclaw/src/media/store.ts:407).
- `media://inbound/<id>` resolves back to that stored file. See [media-reference.ts](/home/alex/code/openclaw/src/media/media-reference.ts:133).
- The PDF tool can read `media://inbound/<id>` in the non-sandboxed host-tool path. There is a test for this in [pdf-tool.test.ts](/home/alex/code/openclaw/src/agents/tools/pdf-tool.test.ts:218).
- For sandboxed tool execution, OpenClaw has a convention to fall back to `media/inbound/<basename>` inside the sandbox workspace. See [sandbox-media-paths.ts](/home/alex/code/openclaw/src/agents/sandbox-media-paths.ts:21) and [pdf-tool.ts](/home/alex/code/openclaw/src/agents/tools/pdf-tool.ts:370).

But the missing piece is important: current OpenClaw code does not automatically take a binary MCP resource from `obsidian-relay-mcp`, save it into OpenClaw’s media store, and copy/mount it into the sandbox. The primitives exist; the bridge is not wired.

Best design would be OpenClaw-side import, not Relay-side tmp export:

1. `obsidian-relay-mcp.read_attachment` returns bytes plus MIME/name/hash.
2. OpenClaw imports those bytes with `saveMediaBuffer(...)`.
3. OpenClaw returns `mediaRef: "media://inbound/<id>"`.
4. The agent calls OpenClaw’s `pdf` tool with that `mediaRef`.

For full sandbox file access, the importer should additionally write the file into the sandbox workspace via `SandboxFsBridge.writeFile(...)`, probably at `media/inbound/<id-or-filename>`, and return that sandbox-relative path too.

So: my tmp-path idea is not the robust version. The robust version is an OpenClaw-owned media import path. Current media store code gets us most of the way there, but we’d need to add either a small OpenClaw core/plugin tool or MCP-result middleware that imports `resource`/blob outputs automatically.