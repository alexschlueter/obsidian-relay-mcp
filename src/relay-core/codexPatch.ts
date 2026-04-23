export interface CodexPatchLine {
  kind: "add" | "context" | "delete";
  text: string;
}

export interface CodexPatchHunk {
  headers: string[];
  lines: CodexPatchLine[];
}

export interface ParsedCodexUpdatePatch {
  path: string;
  hunks: CodexPatchHunk[];
}

export interface AppliedCodexUpdatePatch {
  changed: boolean;
  path: string;
  resultText: string;
}

export function parseCodexUpdatePatch(patchText: string): ParsedCodexUpdatePatch {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  if (lines[index] !== "*** Begin Patch") {
    throw new Error("Codex patch must start with *** Begin Patch");
  }
  index += 1;

  if (!lines[index]?.startsWith("*** Update File: ")) {
    const fileAction = lines[index] ?? "<missing>";
    throw new Error(`Codex patch only supports *** Update File operations (received ${fileAction})`);
  }

  const updateFileLine = lines[index];
  if (updateFileLine === undefined) {
    throw new Error("Codex patch is missing the Update File header");
  }

  const path = updateFileLine.slice("*** Update File: ".length);
  if (!path) {
    throw new Error("Codex patch is missing the Update File path");
  }
  index += 1;

  if (lines[index]?.startsWith("*** Move to: ")) {
    throw new Error("Codex patch rename operations are not supported");
  }

  const hunks: CodexPatchHunk[] = [];

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line === "*** End Patch") {
      if (index !== lines.length - 1 && !(index === lines.length - 2 && lines.at(-1) === "")) {
        throw new Error("Codex patch contains trailing content after *** End Patch");
      }
      if (hunks.length === 0) {
        throw new Error("Codex patch must include at least one hunk");
      }
      return {
        path,
        hunks,
      };
    }

    if (line.startsWith("*** ")) {
      throw new Error(`Unsupported Codex patch directive: ${line}`);
    }

    if (!line.startsWith("@@")) {
      throw new Error(`Expected @@ hunk header but found: ${line}`);
    }

    const headers: string[] = [];
    while (index < lines.length) {
      const headerLine = lines[index];
      if (headerLine === undefined || !headerLine.startsWith("@@")) {
        break;
      }
      headers.push(headerLine.slice(2).trim());
      index += 1;
    }

    const hunkLines: CodexPatchLine[] = [];
    while (index < lines.length) {
      const hunkLine = lines[index];
      if (hunkLine === undefined) {
        break;
      }
      if (hunkLine === "*** End of File") {
        index += 1;
        break;
      }
      if (hunkLine === "*** End Patch" || hunkLine.startsWith("@@")) {
        break;
      }
      const prefix = hunkLine[0];
      if (prefix !== " " && prefix !== "+" && prefix !== "-") {
        throw new Error(`Invalid Codex patch hunk line: ${hunkLine}`);
      }
      hunkLines.push({
        kind: prefix === " " ? "context" : prefix === "+" ? "add" : "delete",
        text: hunkLine.slice(1),
      });
      index += 1;
    }

    if (hunkLines.length === 0) {
      throw new Error("Codex patch hunks must include at least one change or context line");
    }

    hunks.push({
      headers,
      lines: hunkLines,
    });
  }

  throw new Error("Codex patch must end with *** End Patch");
}

export function applyCodexUpdatePatch(
  sourceText: string,
  patchText: string,
): AppliedCodexUpdatePatch {
  const parsed = parseCodexUpdatePatch(patchText);
  const lineEnding = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = sourceText.endsWith("\n");
  const sourceLines = splitTextLines(sourceText);
  const nextLines = [...sourceLines];
  let searchStart = 0;

  for (const hunk of parsed.hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "delete")
      .map((line) => line.text);

    const narrowedSearchStart = narrowSearchStart(nextLines, searchStart, hunk.headers);
    const matchIndex =
      oldLines.length === 0
        ? narrowedSearchStart
        : findMatchingSequence(nextLines, oldLines, narrowedSearchStart);

    if (matchIndex < 0) {
      throw new Error("Codex patch hunk did not match the current document text");
    }

    nextLines.splice(matchIndex, oldLines.length, ...newLines);
    searchStart = matchIndex + newLines.length;
  }

  const resultText = joinTextLines(nextLines, lineEnding, hadTrailingNewline);

  return {
    path: parsed.path,
    resultText,
    changed: resultText !== sourceText,
  };
}

function splitTextLines(text: string): string[] {
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

function joinTextLines(lines: string[], lineEnding: string, hadTrailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }

  const body = lines.join(lineEnding);
  return hadTrailingNewline ? `${body}${lineEnding}` : body;
}

function narrowSearchStart(lines: string[], searchStart: number, headers: string[]): number {
  let narrowedSearchStart = searchStart;

  for (const header of headers) {
    const needle = header.trim();
    if (!needle) {
      continue;
    }

    const index = lines.findIndex(
      (line, lineIndex) => lineIndex >= narrowedSearchStart && line.includes(needle),
    );
    if (index >= 0) {
      narrowedSearchStart = index;
    }
  }

  return narrowedSearchStart;
}

function findMatchingSequence(haystack: string[], needle: string[], startIndex: number): number {
  if (needle.length === 0) {
    return startIndex;
  }

  const lastStart = haystack.length - needle.length;
  for (let index = startIndex; index <= lastStart; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }

  return -1;
}
