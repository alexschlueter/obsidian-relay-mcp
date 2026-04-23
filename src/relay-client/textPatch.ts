import { diff_match_patch } from "diff-match-patch";
import * as Y from "yjs";

export interface TextMutationResult {
  before: string;
  after: string;
  changed: boolean;
}

type DiffTuple = [number, string];

export function replaceText(ytext: Y.Text, nextText: string): TextMutationResult {
  const before = ytext.toString();
  if (before === nextText) {
    return {
      before,
      after: before,
      changed: false,
    };
  }

  if (before.length > 0) {
    ytext.delete(0, before.length);
  }
  if (nextText.length > 0) {
    ytext.insert(0, nextText);
  }

  return {
    before,
    after: nextText,
    changed: true,
  };
}

export function patchText(ytext: Y.Text, nextText: string): TextMutationResult {
  const before = ytext.toString();
  if (before === nextText) {
    return {
      before,
      after: before,
      changed: false,
    };
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(before, nextText) as DiffTuple[];
  dmp.diff_cleanupSemantic(diffs);

  let cursor = 0;
  for (const [operation, text] of diffs) {
    if (operation === 0) {
      cursor += text.length;
      continue;
    }
    if (operation === -1) {
      ytext.delete(cursor, text.length);
      continue;
    }
    if (operation === 1) {
      ytext.insert(cursor, text);
      cursor += text.length;
      continue;
    }
    throw new Error(`Unexpected diff-match-patch operation: ${operation}`);
  }

  return {
    before,
    after: nextText,
    changed: true,
  };
}
