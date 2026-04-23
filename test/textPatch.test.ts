import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { patchText, replaceText } from "../src/relay-client/textPatch";

describe("textPatch", () => {
  it("applies a diff-style patch to Y.Text", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("contents");
    ytext.insert(0, "hello world");

    let result;
    ydoc.transact(() => {
      result = patchText(ytext, "hello brave new world");
    });

    expect(result).toMatchObject({
      before: "hello world",
      after: "hello brave new world",
      changed: true,
    });
    expect(ytext.toString()).toBe("hello brave new world");
  });

  it("replaces the whole text when requested", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("contents");
    ytext.insert(0, "old");

    ydoc.transact(() => {
      replaceText(ytext, "new");
    });

    expect(ytext.toString()).toBe("new");
  });
});
