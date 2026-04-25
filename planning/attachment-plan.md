As coded, `read_attachment` returns a normal JSON tool result. The image bytes are inside:

```json
{
  "contentType": "image/png",
  "contentLength": 1207916,
  "dataBase64": "..."
}
```

And `jsonToolResult(...)` wraps that as text plus `structuredContent`. A vision-capable agent would receive the base64 string, but most MCP clients will not automatically treat that as an image input to the model. The agent would have to decode or explicitly hand that base64 to a vision-capable path.

For “the agent sees the image directly,” the MCP tool should return an MCP image content item, roughly:

```ts
{
  type: "image",
  data: attachment.dataBase64,
  mimeType: attachment.contentType ?? "application/octet-stream",
}
```

Probably alongside a text/structured metadata object without duplicating the huge base64 in `structuredContent`.

Better shape:

- `structuredContent`: metadata only: path, hash, contentType, contentLength
- `content`: one JSON/text metadata item plus one `image` item when `contentType` starts with `image/`
- for PDFs/audio/video/unknown files, keep base64 or maybe return an MCP resource/blob depending on client support

So right now the tool is functionally capable, but not ergonomically vision-native. We should patch `read_attachment` tool output so image attachments are returned as MCP image content.

For vision-native behavior, `read_attachment` should special-case `image/*` and return:

```ts
{
  content: [
    { type: "text", text: JSON.stringify(metadata, null, 2) },
    { type: "image", data: result.dataBase64, mimeType: result.contentType }
  ],
  structuredContent: metadata
}
```

That would make the attachment visible to MCP clients that pass image content blocks through to vision-capable models.

## Obsidian Attachment Types

Officially, Obsidian natively supports these non-Markdown file families:

- Images: .avif, .bmp, .gif, .jpeg, .jpg, .png, .svg, .webp
- Audio: .flac, .m4a, .mp3, .ogg, .wav, .webm, .3gp
- Video: .mkv, .mov, .mp4, .ogv, .webm
- PDF: .pdf
- Also Obsidian-native-ish files: .canvas, .base, .md

Obsidian can still show unsupported files in the file explorer, but it cannot necessarily preview/open them natively. In Relay’s metadata model, these broadly correspond to image, audio, video, pdf, and generic file.

Common in real Obsidian vaults: screenshots/images, PDFs, clipped web assets, audio recordings, occasional videos, and arbitrary files like .docx, .xlsx, .csv, .zip.

Sources: Obsidian accepted formats and embed docs:
https://obsidian.md/help/file-formats
https://help.obsidian.md/embeds

## MCP Content Types
For a tool result, MCP content is a list of content blocks. In the current MCP schema, CallToolResult.content can contain:

- text
- image
- audio
- resource_link
- resource
- There is no type: "pdf" content block.

Images are first-class:

```ts
{
  type: "image",
  data: "<base64>",
  mimeType: "image/png"
}
```
Audio is first-class:
```ts
{
  type: "audio",
  data: "<base64>",
  mimeType: "audio/mpeg"
}

```
PDFs and arbitrary files should be represented as resources, usually with MIME type:
```ts
{
  type: "resource",
  resource: {
    uri: "relay://attachment/path/to/file.pdf",
    mimeType: "application/pdf",
    blob: "<base64>"
  }
}

```
Or as a resource_link if the client can later read it.

MCP schema refs:
https://modelcontextprotocol.io/specification/2025-11-25/schema
https://modelcontextprotocol.io/specification/2025-03-26/server/resources

## Implication For Our Tool
For Relay attachments, I’d shape it like this:

- Images: return MCP image content block plus metadata.
- Audio: return MCP audio content block plus metadata.
- PDFs: return metadata plus either an embedded resource with application/pdf, or better, add a later read_pdf_text / extract_attachment_text tool.
- Generic files: return metadata and maybe a resource blob, but avoid dumping huge base64 into structuredContent.

So the next ergonomic patch would be: make read_attachment return native MCP image/audio blocks, and keep structuredContent metadata-only.

## Text attachments

Good point. Text attachments should be handled differently from images/audio/PDFs.

I’d treat attachment output by MIME family:

- `image/*`: MCP `image` content block
- `audio/*`: MCP `audio` content block
- `text/*`: MCP `text` content block containing decoded UTF-8 text
- structured text-ish types: also decode as text:
  - `application/json`
  - `application/yaml`, `application/x-yaml`
  - `application/xml`, `text/xml`
  - `text/csv`
  - maybe `application/javascript`, `application/typescript`
- `application/pdf`: resource blob for now, later a PDF extraction tool
- everything else: resource blob or metadata-only if too large

For text files, I would not return base64 as the main model-facing payload. The agent wants readable text. So `read_attachment` should return:

```ts
{
  content: [
    {
      type: "text",
      text: "metadata json..."
    },
    {
      type: "text",
      text: decodedAttachmentText
    }
  ],
  structuredContent: {
    ok: true,
    path,
    contentType,
    contentLength,
    hash,
    encoding: "utf-8"
  }
}
```

A few safeguards matter:

- Only decode as UTF-8 when the MIME type or extension indicates text.
- If decoding produces replacement characters heavily, fall back to blob/base64.
- Add `maxBytes`, already present, to prevent accidental giant file ingestion.
- For `.base`, `.json`, `.csv`, `.txt`, `.md`, `.xml`, `.yaml`, this becomes immediately useful.

One subtle thing: Obsidian may classify unsupported text files as generic `file`, but MIME type might still be useful. If `mimetype` is missing, we can infer from extension as a fallback.