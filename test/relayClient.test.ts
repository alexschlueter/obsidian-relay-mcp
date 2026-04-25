import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { RelayClient } from "../src/relay-client/relayClient";

const relayId = "11111111-1111-1111-1111-111111111111";
const folderId = "22222222-2222-2222-2222-222222222222";
const folderDocId = "33333333-3333-3333-3333-333333333333";
const noteDocId = "44444444-4444-4444-4444-444444444444";
const notePath = "Notes/Test.md";

describe("RelayClient handle editing", () => {
  it("lists configured folder paths with query, prefix, kinds, and pagination", async () => {
    const harness = createHarness("hello");
    harness.addFolderEntry("Projects/Alpha.md", {
      id: "55555555-5555-5555-5555-555555555555",
      type: "markdown",
    });
    harness.addFolderEntry("Projects/Alpha.canvas", {
      id: "66666666-6666-6666-6666-666666666666",
      type: "canvas",
    });
    harness.addFolderEntry("Projects/Assets/logo.png", {
      id: "77777777-7777-7777-7777-777777777777",
      type: "image",
    });
    harness.addFolderEntry("Archive/Alpha.md", {
      id: "88888888-8888-8888-8888-888888888888",
      type: "markdown",
    });

    const relay = harness.createRelay();
    const firstPage = await relay.listFiles({
      query: "alpha",
      pathPrefix: "Projects",
      maxResults: 1,
    });

    expect(firstPage).toEqual({
      ok: true,
      entries: [
        {
          path: "Projects/Alpha.canvas",
          kind: "canvas",
        },
      ],
      totalMatches: 2,
      returnedCount: 1,
      offset: 0,
      nextOffset: 1,
    });

    const secondPage = await relay.listFiles({
      query: "alpha",
      pathPrefix: "Projects",
      maxResults: 1,
      offset: firstPage.nextOffset,
    });

    expect(secondPage).toEqual({
      ok: true,
      entries: [
        {
          path: "Projects/Alpha.md",
          kind: "markdown",
        },
      ],
      totalMatches: 2,
      returnedCount: 1,
      offset: 1,
    });

    const attachments = await relay.listFiles({ query: "logo" });
    expect(attachments.entries).toEqual([
      {
        path: "Projects/Assets/logo.png",
        kind: "attachment",
      },
    ]);
  });

  it("returns a fresh handle for each read and applies update-file patches", async () => {
    const harness = createHarness("hello world\n");
    const relay = harness.createRelay();

    const first = await relay.readText(notePath);
    const second = await relay.readText(notePath);

    expect(first.text).toBe("hello world\n");
    expect(second.text).toBe("hello world\n");
    expect(first.patchHandle).toBe(first.handle);
    expect(first.handle).toHaveLength(5);
    expect(second.handle).toHaveLength(5);
    expect(first.handle).not.toBe(second.handle);

    const windowed = await relay.readText(notePath, { startChar: 6, maxChars: 5 });
    expect(windowed).toMatchObject({
      text: "world",
      totalChars: "hello world\n".length,
      startChar: 6,
      endChar: 11,
      truncated: true,
    });
    expect(windowed.patchHandle).toHaveLength(5);

    const result = await relay.applyPatch(
      first.patchHandle,
      buildReplacePatch(notePath, first.text, "hello brave new world\n"),
      { returnResult: true },
    );

    expect(result).toEqual({
      changed: true,
      staleHandle: false,
      resultText: "hello brave new world\n",
    });

    const latest = await relay.readText(notePath);
    expect(latest.text).toBe("hello brave new world\n");
  });

  it("marks stale handles when remote peers changed the document", async () => {
    const harness = createHarness("hello");
    const relay = harness.createRelay();

    const read = await relay.readText(notePath);
    harness.updateRemoteText((current) => `${current} world`);

    const result = await relay.patchText(
      read.handle,
      buildReplacePatch(notePath, read.text, "HELLO"),
      { returnResult: true },
    );

    expect(result).toEqual({
      changed: true,
      staleHandle: true,
      resultText: "HELLO",
    });

    const latest = await relay.readText(notePath);
    expect(latest.text).toContain("world");
    expect(latest.text).not.toBe(result.resultText);
  });

  it("does not persist handle changes when push fails", async () => {
    const harness = createHarness("start");
    const relay = harness.createRelay();
    const read = await relay.readText(notePath);
    const patch = buildReplacePatch(notePath, read.text, "finish");

    harness.failNextUpdate = true;
    await expect(relay.applyPatch(read.handle, patch)).rejects.toThrow(
      "Failed to push Relay document update (500): simulated update failure",
    );

    const retry = await relay.applyPatch(read.handle, patch, { returnResult: false });
    expect(retry).toEqual({
      changed: true,
      staleHandle: false,
    });

    const latest = await relay.readText(notePath);
    expect(latest.text).toBe("finish");
  });

  it("expires handles after the requested TTL", async () => {
    const harness = createHarness("ttl");
    const relay = harness.createRelay();
    const read = await relay.readText(notePath, 0.005);

    await sleep(15);

    await expect(
      relay.applyPatch(read.handle, buildReplacePatch(notePath, read.text, "after ttl")),
    ).rejects.toThrow(`Relay handle expired: ${read.handle}`);
  });

  it("rejects the old ttlMs option name", async () => {
    const harness = createHarness("ttl option");
    const relay = harness.createRelay();

    await expect(
      relay.readText(notePath, { ttlMs: 5 } as never),
    ).rejects.toThrow("ttlMs was renamed to ttlSeconds; pass TTL values in seconds");
  });

  it("validates the explicit path argument against the patch path", async () => {
    const harness = createHarness("path check");
    const relay = harness.createRelay();
    const read = await relay.readText(notePath);

    await expect(
      relay.applyPatch(
        read.handle,
        "Notes/Other.md",
        buildReplacePatch(notePath, read.text, "updated"),
      ),
    ).rejects.toThrow(
      "Patch path Notes/Test.md does not match the explicit path argument Notes/Other.md",
    );
  });
});

describe("RelayClient live edit sessions", () => {
  it("reports unknown edit sessions distinctly", async () => {
    const harness = createHarness("live hello");
    const relay = harness.createRelay();

    await expect(relay.searchText("abcde", "hello")).rejects.toThrow(
      "Unknown Relay edit session: abcde",
    );
  });

  it("reports closed edit sessions distinctly", async () => {
    const harness = createHarness("live hello");
    const relay = harness.createRelay({ liveWebSocket: true });

    const { sessionId } = await relay.openEditSession(notePath, "Test Agent");
    await expect(relay.closeEditSession(sessionId)).resolves.toBe(true);

    await expect(relay.searchText(sessionId, "hello")).rejects.toThrow(
      `Closed Relay edit session: ${sessionId}`,
    );
  });

  it("reports expired edit sessions distinctly", async () => {
    const harness = createHarness("live hello");
    const relay = harness.createRelay({ liveWebSocket: true });

    const { sessionId } = await relay.openEditSession(notePath, "Test Agent", 0.001);
    await sleep(15);

    await expect(relay.searchText(sessionId, "hello")).rejects.toThrow(
      `Expired Relay edit session: ${sessionId}`,
    );
  });

  it("hydrates the note document over websocket instead of fetching note content over HTTP", async () => {
    const harness = createHarness("live hello");
    harness.failNoteAsUpdate = true;
    const relay = harness.createRelay({ liveWebSocket: true });

    const { sessionId } = await relay.openEditSession(notePath, "Test Agent");
    const match = (await relay.searchText(sessionId, "hello")).matches[0]!;

    await relay.selectText(sessionId, match.matchId);
    await relay.insertText(sessionId, "world");

    expect(harness.getRemoteText()).toBe("live world");
  });
});

function createHarness(initialText: string) {
  const folderDoc = new Y.Doc();
  folderDoc.getMap("filemeta_v0").set(notePath, {
    id: noteDocId,
    type: "markdown",
  });

  const noteDoc = new Y.Doc();
  noteDoc.getText("contents").insert(0, initialText);

  const docs = new Map<string, Y.Doc>([
    [folderDocId, folderDoc],
    [noteDocId, noteDoc],
  ]);

  let failNextUpdate = false;
  let failNoteAsUpdate = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://api.system3.md/token") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { docId?: string };
      const docId = payload.docId === folderId ? folderDocId : noteDocId;

      return jsonResponse({
        docId,
        folder: folderId,
        token: "client-token",
        url: `wss://relay.test/doc/ws/${docId}`,
      });
    }

    if (url === `https://relay.test/doc/${folderDocId}/as-update`) {
      return binaryResponse(Y.encodeStateAsUpdate(docs.get(folderDocId)!));
    }

    if (url === `https://relay.test/doc/${noteDocId}/as-update`) {
      if (failNoteAsUpdate) {
        throw new Error("note as-update should not be fetched");
      }
      return binaryResponse(Y.encodeStateAsUpdate(docs.get(noteDocId)!));
    }

    if (url === `https://relay.test/doc/${noteDocId}/update`) {
      if (failNextUpdate) {
        failNextUpdate = false;
        return new Response("simulated update failure", { status: 500 });
      }

      const body = init?.body;
      if (!(body instanceof Uint8Array || Buffer.isBuffer(body))) {
        throw new Error("Expected a Uint8Array update body");
      }
      Y.applyUpdate(docs.get(noteDocId)!, new Uint8Array(body));
      return new Response(null, { status: 200 });
    }

    throw new Error(`Unexpected request URL: ${url}`);
  };

  return {
    createRelayWithOptions(options: { liveWebSocket?: boolean }) {
      return new RelayClient({
        apiUrl: "https://api.system3.md",
        bearerToken: "bearer-token",
        fetch: fetchImpl,
        folderId,
        liveProvider: options.liveWebSocket
          ? {
              WebSocketImpl: createFakeWebSocket(docs),
            }
          : undefined,
        relayId,
      });
    },
    createRelay(options: { liveWebSocket?: boolean } = {}) {
      return this.createRelayWithOptions(options);
    },
    addFolderEntry(path: string, meta: { id: string; type: string }) {
      folderDoc.getMap("filemeta_v0").set(path, meta);
    },
    get failNextUpdate() {
      return failNextUpdate;
    },
    set failNextUpdate(value: boolean) {
      failNextUpdate = value;
    },
    get failNoteAsUpdate() {
      return failNoteAsUpdate;
    },
    set failNoteAsUpdate(value: boolean) {
      failNoteAsUpdate = value;
    },
    getRemoteText() {
      return docs.get(noteDocId)!.getText("contents").toString();
    },
    updateRemoteText(update: (current: string) => string) {
      const ydoc = docs.get(noteDocId)!;
      const ytext = ydoc.getText("contents");
      const nextText = update(ytext.toString());
      ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, nextText);
      });
    },
  };
}

function createFakeWebSocket(docs: Map<string, Y.Doc>): typeof WebSocket {
  return class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    binaryType: BinaryType = "arraybuffer";
    readyState = FakeWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private readonly doc: Y.Doc;

    constructor(url: string | URL) {
      const parsed = new URL(String(url));
      const docId = parsed.pathname.split("/").filter(Boolean).at(-1);
      const doc = docId ? docs.get(docId) : undefined;
      if (!doc) {
        throw new Error(`Fake websocket missing doc for ${String(url)}`);
      }
      this.doc = doc;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const bytes = data instanceof Uint8Array
        ? data
        : typeof data === "string"
          ? new TextEncoder().encode(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : undefined;
      if (!bytes) {
        throw new Error("Fake websocket only supports binary test messages");
      }

      const response = readServerMessage(this.doc, bytes);
      if (response.byteLength > 1) {
        queueMicrotask(() => {
          this.onmessage?.(new MessageEvent("message", { data: response.buffer }));
        });
      }
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.(new CloseEvent("close"));
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return true;
    }
  } as unknown as typeof WebSocket;
}

function readServerMessage(doc: Y.Doc, bytes: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(bytes);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  if (messageType === 0) {
    encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, doc, "fake-server");
  }
  return encoding.toUint8Array(encoder);
}

function buildReplacePatch(path: string, before: string, after: string): string {
  const beforeLines = splitPatchLines(before);
  const afterLines = splitPatchLines(after);

  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "*** End Patch",
  ].join("\n");
}

function splitPatchLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function binaryResponse(bytes: Uint8Array): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
