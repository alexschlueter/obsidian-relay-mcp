import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FolderIndex, normalizeRelayPath } from "../src/relay-core/folderIndex";

const relayId = "11111111-1111-1111-1111-111111111111";
const folderId = "22222222-2222-2222-2222-222222222222";
const docId = "33333333-3333-3333-3333-333333333333";
const imageId = "44444444-4444-4444-4444-444444444444";

describe("FolderIndex", () => {
  it("parses filemeta_v0 entries and resolves normalized paths", () => {
    const ydoc = new Y.Doc();
    const filemeta = ydoc.getMap("filemeta_v0");
    filemeta.set("Notes/Plan.md", {
      id: docId,
      version: 0,
      type: "markdown",
    });
    filemeta.set("/Assets/logo.png", {
      id: imageId,
      version: 0,
      type: "image",
      mimetype: "image/png",
      hash: "abc123",
    });

    const index = FolderIndex.fromYDoc(relayId, folderId, ydoc);

    expect(index.getByPath("Notes//Plan.md")).toMatchObject({
      id: docId,
      resourceKind: "document",
      type: "markdown",
    });
    expect(index.getByPath("Assets/logo.png")).toMatchObject({
      id: imageId,
      resourceKind: "file",
      mimetype: "image/png",
    });
  });

  it("rejects paths that escape the shared folder root", () => {
    expect(() => normalizeRelayPath("../secret.md")).toThrow(/escapes the folder root/);
  });
});
