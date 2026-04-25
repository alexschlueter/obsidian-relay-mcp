Relay uses IndexedDB as a **local Yjs persistence cache** for each shared folder / document / canvas.

It is not the source of truth. The server is still the shared source of truth. IndexedDB is the local durable replica.

Main jobs:

- **Fast startup / offline cache:** it stores Yjs updates locally, then reapplies them into the `Y.Doc` on startup before or while the websocket sync catches up. See [y-indexeddb.js](/home/alex/code/Relay/src/storage/y-indexeddb.js:21).
- **Persist local edits before server sync:** every Yjs update is stored into IndexedDB unless the update came from the persistence layer itself. See [y-indexeddb.js](/home/alex/code/Relay/src/storage/y-indexeddb.js:107).
- **Compaction:** after enough updates, it stores a compact full Yjs state update and deletes older incremental updates. See [y-indexeddb.js](/home/alex/code/Relay/src/storage/y-indexeddb.js:38).
- **Readiness/staleness decisions:** Relay tracks whether this doc has ever synced with the server via `serverSync`. See [y-indexeddb.js](/home/alex/code/Relay/src/storage/y-indexeddb.js:211).
- **Metadata:** it stores things like `path`, `relay`, `appId`, and `s3rn` for local bookkeeping. See [Document.ts](/home/alex/code/Relay/src/Document.ts:103).

For a `Document`, the setup is:

```ts
this.ydoc = new Y.Doc()
this._persistence = new IndexeddbPersistence(key, this.ydoc)
```

Relevant lines:

- Creates the document `Y.Doc`: [HasProvider.ts](/home/alex/code/Relay/src/HasProvider.ts:75)
- Attaches IndexedDB persistence: [Document.ts](/home/alex/code/Relay/src/Document.ts:83)
- Waits for local persistence to load: [Document.ts](/home/alex/code/Relay/src/Document.ts:341)
- Marks server sync complete: [Document.ts](/home/alex/code/Relay/src/Document.ts:397)

For `mcp-relay`, we probably do **not** need IndexedDB. Our server-side process can open a live session, wait for websocket sync, edit, and discard state after TTL. IndexedDB matters more for a long-running desktop editor that needs local durability, offline behavior, and quick reopen.