import { describe, expect, it } from "vitest";
import { applyCodexUpdatePatch } from "../src/relay-client/codexPatch";

describe("codex update patch application", () => {
  it("matches later hunks against the original text when an earlier hunk changes line count", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: Notes/Test.md",
      "@@",
      " Alpha",
      "+Inserted",
      " Beta",
      "@@",
      " Gamma",
      "-Delta",
      "+Changed",
      " Epsilon",
      "*** End Patch",
    ].join("\n");

    expect(applyCodexUpdatePatch("Alpha\nBeta\nGamma\nDelta\nEpsilon\n", patch).resultText).toBe(
      "Alpha\nInserted\nBeta\nGamma\nChanged\nEpsilon\n",
    );
  });

  it("allows the next hunk to start where the previous old hunk ended", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: Notes/Test.md",
      "@@",
      " Alpha",
      "-Beta",
      "+Beta updated",
      "@@",
      " Gamma",
      "-Delta",
      "+Delta updated",
      "*** End Patch",
    ].join("\n");

    expect(applyCodexUpdatePatch("Alpha\nBeta\nGamma\nDelta\n", patch).resultText).toBe(
      "Alpha\nBeta updated\nGamma\nDelta updated\n",
    );
  });

  it("uses @@ context as a search hint and applies the first following match", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: Notes/Test.md",
      "@@ ## Target",
      "-Repeated line",
      "+Changed line",
      "*** End Patch",
    ].join("\n");

    expect(
      applyCodexUpdatePatch(
        "Repeated line\n## Target\nRepeated line\nRepeated line\n",
        patch,
      ).resultText,
    ).toBe("Repeated line\n## Target\nChanged line\nRepeated line\n");
  });

  it("falls back to matching without leading or trailing whitespace", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: Notes/Test.md",
      "@@",
      "-Indented line",
      "+Changed line",
      "*** End Patch",
    ].join("\n");

    expect(applyCodexUpdatePatch("  Indented line  \n", patch).resultText).toBe("Changed line\n");
  });

  it("falls back to matching normalized Unicode punctuation", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: Notes/Test.md",
      "@@",
      '-"Quoted" note - ready',
      "+Plain note ready",
      "*** End Patch",
    ].join("\n");

    expect(applyCodexUpdatePatch("\u201CQuoted\u201D note \u2013 ready\n", patch).resultText).toBe(
      "Plain note ready\n",
    );
  });
});
