import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { LiveEditSession } from "../src/relay-client/liveSession";
import { LiveRelayProvider } from "../src/relay-client/liveProvider";

describe("LiveEditSession markdown tools", () => {
  it("searches with short match ids and keeps anchors internal", () => {
    const session = createSession("hello world\nhello moon\n");

    const result = session.searchText("hello");

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({
      matchId: "00001",
      before: "",
      after: " world\nhello moon\n",
      startPos: 0,
    });
    expect(Object.keys(result.matches[0]!)).not.toContain("startAnchorB64");
    expect(Object.keys(result.matches[0]!)).not.toContain("endAnchorB64");
  });

  it("returns a stale match error when the anchored text changed", () => {
    const session = createSession("hello world");
    const match = session.searchText("world").matches[0]!;

    session.ytext.delete(match.startPos, "world".length);
    session.ytext.insert(match.startPos, "there");

    expect(session.replaceMatches([match.matchId], "moon")).toEqual({
      ok: false,
      reason: "staleMatch",
      message: `Stored match ${match.matchId} no longer matches the current document text`,
      matchId: match.matchId,
      expectedText: "world",
      currentText: "there",
    });
  });

  it("selects markdown source blocks without ProseMirror", () => {
    const session = createSession("---\ntitle: Test\n---\n\n# Heading\n\n- one\n- two\n\n```ts\ncode\n```\n");
    const heading = session.searchText("Heading").matches[0]!;

    session.placeCursor(heading.matchId);

    expect(session.selectCurrentBlock()).toEqual({
      ok: true,
      blockType: "heading",
      selectedText: "# Heading",
      selectedFrom: 21,
      selectedTo: 30,
    });
  });

  it("uses selection state for insert and delete operations", () => {
    const session = createSession("hello world");
    const match = session.searchText("world").matches[0]!;

    expect(session.selectText(match.matchId)).toMatchObject({
      ok: true,
      selectedText: "world",
    });
    expect(session.insertText("moon")).toEqual({
      ok: true,
      insertedChars: 4,
    });
    expect(session.getText()).toBe("hello moon");

    const moon = session.searchText("moon").matches[0]!;
    session.selectText(moon.matchId);
    expect(session.deleteSelection()).toEqual({
      ok: true,
      numCharsDeleted: 4,
    });
    expect(session.getText()).toBe("hello ");
  });

  it("publishes the agent cursor through awareness", () => {
    const session = createSession("hello");

    expect(session.listActiveCursors()).toEqual([
      {
        clientId: session.ydoc.clientID,
        userId: "mcp-relay:00000",
        userName: "mcp-relay agent 00000",
        hasSelection: false,
      },
    ]);
  });
});

function createSession(text: string): LiveEditSession {
  const ydoc = new Y.Doc();
  ydoc.getText("contents").insert(0, text);
  const awareness = new Awareness(ydoc);
  const provider = {
    awareness,
    destroy() {
      awareness.destroy();
    },
  } as unknown as LiveRelayProvider;
  let nextId = 1;

  return new LiveEditSession(
    "00000",
    {
      relayId: "relay",
      folderId: "folder",
      path: "note.md",
    },
    {
      id: "doc",
      path: "note.md",
      type: "markdown",
      resourceKind: "document",
      raw: {
        id: "doc",
        type: "markdown",
      },
    },
    {
      docId: "doc",
      folder: "folder",
      token: "token",
      url: "wss://relay.test/doc/ws/doc",
    },
    ydoc,
    provider,
    () => encodeId(nextId++),
  );
}

function encodeId(value: number): string {
  return value.toString(36).padStart(5, "0");
}
