Yes for **last changed**, maybe/no for **created**, depending on what source we use.

When we have opened a document via `open_edit_session`, we know its folder entry and client token. From there we have three possible metadata sources:

1. **Folder metadata**
`filemeta_v0` gives us `synctime`, `hash`, `mimetype`, etc. But for Markdown docs, `synctime` is not reliable as “last changed.” In the Relay plugin, `synctime` is mainly meaningful for uploaded file/blob metadata, not the Yjs Markdown document.

2. **Relay server versions API**
The relay-server exposes:

```text
GET /d/{docId}/versions
```

That returns storage object versions with `created_at` and `is_latest`. For Yjs docs, this is probably the best available “last persisted changed time.” If versions exist, the latest version’s `created_at` can be exposed as something like `lastChangedAt`.

But this is not necessarily document-created time. It is object-version time in the underlying store.

3. **Y.Doc contents**
The Markdown Y.Doc itself does not automatically contain created/modified timestamps unless the app wrote them into the document. So opening the doc over websocket does not magically reveal created time.

So I’d phrase the capability like this:

```text
lastChangedAt: possible, via /d/{docId}/versions if the Relay store supports versions
createdAt: not reliably available from current Relay folder/doc metadata
```

If we expose it, I would make it explicit and conservative:

```ts
get_file_info({ path })
```

Return:

```ts
{
  path: "Notes/Plan.md",
  kind: "markdown",
  lastChangedAt?: string,
  createdAt?: string,
  timeSource?: "relayDocumentVersions" | "folderSynctime"
}
```

For Markdown docs, I would only set `lastChangedAt` from `/versions`, and leave `createdAt` absent unless we can prove the oldest version timestamp is stable enough to mean creation time.