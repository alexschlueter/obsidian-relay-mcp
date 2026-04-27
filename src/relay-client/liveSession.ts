import * as Y from "yjs";
import { ClientToken } from "./auth";
import { FolderEntry } from "./folderIndex";
import { LiveRelayProvider, RelayAwareness } from "./liveProvider";

export interface EditSessionAddress {
  relayId: string;
  folderId: string;
  path: string;
}

export interface OpenEditSessionResult {
  sessionId: string;
}

export interface CursorContextOptions {
  maxCharsBefore?: number;
  maxCharsAfter?: number;
  userId?: string;
  userName?: string;
  clientId?: number;
}

export type CursorContextResult =
  | {
      ok: true;
      hasSelection: false;
      position: number;
      before: string;
      after: string;
    }
  | {
      ok: true;
      hasSelection: true;
      selectedText: string;
      selectedFrom: number;
      selectedTo: number;
      before: string;
      after: string;
    }
  | CursorToolError;

export interface ActiveCursorInfo {
  userName?: string;
  userId?: string;
  clientId: number;
  hasSelection: boolean;
}

export interface SearchTextResult {
  ok: true;
  matches: SearchMatchSummary[];
}

export interface SearchMatchSummary {
  matchId: string;
  before: string;
  after: string;
  startPos: number;
}

export type MatchToolResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | CursorToolError;

export interface SelectCurrentBlockResult {
  ok: true;
  blockType: MarkdownBlockType;
  selectedText: string;
  selectedFrom: number;
  selectedTo: number;
}

export type MarkdownBlockType =
  | "frontmatter"
  | "code block"
  | "table"
  | "list"
  | "heading"
  | "blockquote"
  | "paragraph"
  | "blank"
  | "document";

export interface CursorToolError {
  ok: false;
  reason:
    | "noCursor"
    | "cursorNotResolvable"
    | "cursorNotFound"
    | "ambiguousCursor"
    | "unknownMatch"
    | "staleMatch"
    | "overlappingMatches";
  message: string;
  candidates?: ActiveCursorInfo[];
  matchId?: string;
  expectedText?: string;
  currentText?: string;
}

interface SearchMatchHandle {
  matchId: string;
  sessionId: string;
  expectedText: string;
  before: string;
  after: string;
  startAnchor: Y.RelativePosition;
  endAnchor: Y.RelativePosition;
}

interface ResolvedMatch {
  handle: SearchMatchHandle;
  from: number;
  to: number;
}

interface ResolvedCursor {
  from: number;
  to: number;
}

export class LiveEditSession {
  readonly ytext: Y.Text;
  readonly matches = new Map<string, SearchMatchHandle>();
  cursorAnchor?: Y.RelativePosition;
  cursorHead?: Y.RelativePosition;
  private readonly agentColor: AwarenessUserColor;

  constructor(
    readonly sessionId: string,
    readonly address: EditSessionAddress,
    readonly entry: FolderEntry,
    readonly clientToken: ClientToken,
    readonly ydoc: Y.Doc,
    readonly provider: LiveRelayProvider,
    readonly agentName: string,
    private readonly issueId: () => string,
  ) {
    this.agentColor = randomAwarenessUserColor();
    this.ytext = ydoc.getText("contents");
    this.setAgentAwareness();
    this.placeCursorAtDocumentBoundary("end");
  }

  destroy(): void {
    this.provider.destroy();
    this.ydoc.destroy();
  }

  get awareness(): RelayAwareness {
    return this.provider.awareness;
  }

  getText(): string {
    return this.ytext.toString();
  }

  getCursorContext(options: CursorContextOptions = {}): CursorContextResult {
    const maxCharsBefore = clampNonNegativeInteger(options.maxCharsBefore ?? 120);
    const maxCharsAfter = clampNonNegativeInteger(options.maxCharsAfter ?? 120);
    const cursor = this.resolveCursorTarget(options);
    if (!cursor.ok) {
      return cursor;
    }

    return this.cursorContextFromRange(cursor.from, cursor.to, maxCharsBefore, maxCharsAfter);
  }

  listActiveCursors(): ActiveCursorInfo[] {
    const cursors: ActiveCursorInfo[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const cursor = getAwarenessCursor(state);
      if (!cursor) {
        continue;
      }
      const anchor = this.resolveRelativePosition(cursor.anchor);
      const head = this.resolveRelativePosition(cursor.head);
      if (anchor === null || head === null) {
        continue;
      }
      const user = getAwarenessUser(state);
      cursors.push({
        clientId,
        ...(typeof user?.name === "string" ? { userName: user.name } : {}),
        ...(typeof user?.id === "string" ? { userId: user.id } : {}),
        hasSelection: anchor !== head,
      });
    }
    return cursors;
  }

  searchText(query: string, maxResults = 8): SearchTextResult {
    const needle = query.trim();
    if (!needle) {
      return { ok: true, matches: [] };
    }

    const text = this.getText();
    const matches: SearchMatchSummary[] = [];
    let fromIndex = 0;
    const limit = Math.max(1, Math.min(Math.trunc(maxResults), 50));

    while (matches.length < limit) {
      const found = text.indexOf(needle, fromIndex);
      if (found < 0) {
        break;
      }

      const before = text.slice(Math.max(0, found - 80), found);
      const after = text.slice(found + needle.length, found + needle.length + 80);
      const matchId = this.issueId();
      const handle: SearchMatchHandle = {
        matchId,
        sessionId: this.sessionId,
        expectedText: needle,
        before,
        after,
        startAnchor: this.createRelativePosition(found),
        endAnchor: this.createRelativePosition(found + needle.length),
      };
      this.matches.set(matchId, handle);
      matches.push({
        matchId,
        before,
        after,
        startPos: found,
      });
      fromIndex = found + Math.max(1, needle.length);
    }

    return {
      ok: true,
      matches,
    };
  }

  replaceMatches(
    matchIds: string[],
    text: string,
  ): MatchToolResult<{ replacedCount: number; insertedChars: number }> {
    const resolved = this.resolveMatches(matchIds);
    if (!Array.isArray(resolved)) {
      return resolved;
    }
    if (resolved.length === 0) {
      return { ok: true, replacedCount: 0, insertedChars: text.length };
    }

    const ranges = resolved
      .map(({ from, to }) => normalizeRange(from, to))
      .sort((left, right) => (left.from === right.from ? right.to - left.to : right.from - left.from));

    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1]!.from < ranges[index]!.to) {
        return {
          ok: false,
          reason: "overlappingMatches",
          message: "replace_matches received overlapping match ranges",
        };
      }
    }

    let cursorPos = ranges[ranges.length - 1]!.from;
    this.ydoc.transact(() => {
      for (const range of ranges) {
        this.ytext.delete(range.from, range.to - range.from);
        if (text.length > 0) {
          this.ytext.insert(range.from, text);
        }
        cursorPos = range.from + text.length;
      }
    }, this);

    this.setCursor(cursorPos);
    return {
      ok: true,
      replacedCount: ranges.length,
      insertedChars: text.length,
    };
  }

  placeCursor(matchId: string, edge: "start" | "end" = "start"): MatchToolResult<{ position: number }> {
    const resolved = this.resolveMatch(matchId);
    if (!resolved.ok) {
      return resolved;
    }
    const position = edge === "end" ? resolved.to : resolved.from;
    this.setCursor(position);
    return { ok: true, position };
  }

  placeCursorAtDocumentBoundary(boundary: "start" | "end"): { ok: true; position: number } {
    const position = boundary === "start" ? 0 : this.ytext.length;
    this.setCursor(position);
    return { ok: true, position };
  }

  selectText(matchId: string): MatchToolResult<{
    selectedText: string;
    selectedFrom: number;
    selectedTo: number;
  }> {
    const resolved = this.resolveMatch(matchId);
    if (!resolved.ok) {
      return resolved;
    }

    this.setSelection(resolved.from, resolved.to);
    return {
      ok: true,
      selectedText: this.getText().slice(resolved.from, resolved.to),
      selectedFrom: resolved.from,
      selectedTo: resolved.to,
    };
  }

  selectCurrentBlock(): SelectCurrentBlockResult | CursorToolError {
    const cursor = this.resolveSessionCursor();
    if (!cursor.ok) {
      return cursor;
    }

    const block = findMarkdownBlock(this.getText(), cursor.to);
    this.setSelection(block.from, block.to);
    return {
      ok: true,
      blockType: block.blockType,
      selectedText: this.getText().slice(block.from, block.to),
      selectedFrom: block.from,
      selectedTo: block.to,
    };
  }

  selectBetweenMatches(
    startMatchId: string,
    endMatchId: string,
    startEdge: "start" | "end" = "start",
    endEdge: "start" | "end" = "end",
  ): MatchToolResult<{
    selectedText: string;
    selectedFrom: number;
    selectedTo: number;
    selectionStartPreview: string;
    selectionEndPreview: string;
  }> {
    const start = this.resolveMatch(startMatchId);
    if (!start.ok) {
      return start;
    }
    const end = this.resolveMatch(endMatchId);
    if (!end.ok) {
      return end;
    }

    const fromPos = startEdge === "end" ? start.to : start.from;
    const toPos = endEdge === "start" ? end.from : end.to;
    const range = normalizeRange(fromPos, toPos);
    this.setSelection(range.from, range.to);

    const selectedText = this.getText().slice(range.from, range.to);
    return {
      ok: true,
      selectedText,
      selectedFrom: range.from,
      selectedTo: range.to,
      selectionStartPreview: selectedText.slice(0, 80),
      selectionEndPreview: selectedText.slice(Math.max(0, selectedText.length - 80)),
    };
  }

  clearSelection(): { ok: true; position: number } {
    const cursor = this.resolveSessionCursor();
    const position = cursor.ok ? cursor.to : this.ytext.length;
    this.setCursor(position);
    return { ok: true, position };
  }

  insertText(text: string): MatchToolResult<{ insertedChars: number }> {
    const cursor = this.resolveSessionCursor();
    if (!cursor.ok) {
      return cursor;
    }

    const range = normalizeRange(cursor.from, cursor.to);
    let nextCursor = range.from + text.length;
    this.ydoc.transact(() => {
      if (range.to > range.from) {
        this.ytext.delete(range.from, range.to - range.from);
      }
      if (text.length > 0) {
        this.ytext.insert(range.from, text);
      }
    }, this);
    this.setCursor(nextCursor);
    return { ok: true, insertedChars: text.length };
  }

  deleteSelection(): { ok: true; numCharsDeleted: number } | CursorToolError {
    const cursor = this.resolveSessionCursor();
    if (!cursor.ok) {
      return cursor;
    }

    const range = normalizeRange(cursor.from, cursor.to);
    if (range.from === range.to) {
      return { ok: true, numCharsDeleted: 0 };
    }

    const numCharsDeleted = range.to - range.from;
    this.ydoc.transact(() => {
      this.ytext.delete(range.from, numCharsDeleted);
    }, this);
    this.setCursor(range.from);
    return { ok: true, numCharsDeleted };
  }

  private setAgentAwareness(): void {
    this.awareness.setLocalStateField("user", {
      id: `obsidian-relay-mcp:${this.sessionId}`,
      name: this.agentName,
      color: this.agentColor.color,
      colorLight: this.agentColor.light,
      role: "agent",
    });
  }

  private resolveCursorTarget(options: CursorContextOptions): CursorToolError | ({ ok: true } & ResolvedCursor) {
    if (options.userId === undefined && options.userName === undefined && options.clientId === undefined) {
      return this.resolveSessionCursor();
    }

    const candidates: Array<ActiveCursorInfo & { cursor: ResolvedCursor }> = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (options.clientId !== undefined && clientId !== options.clientId) {
        continue;
      }

      const user = getAwarenessUser(state);
      const userId = typeof user?.id === "string" ? user.id : undefined;
      const userName = typeof user?.name === "string" ? user.name : undefined;
      if (options.userId !== undefined && userId !== options.userId) {
        continue;
      }
      if (options.userName !== undefined && userName !== options.userName) {
        continue;
      }

      const cursor = getAwarenessCursor(state);
      if (!cursor) {
        continue;
      }
      const anchor = this.resolveRelativePosition(cursor.anchor);
      const head = this.resolveRelativePosition(cursor.head);
      if (anchor === null || head === null) {
        continue;
      }

      candidates.push({
        clientId,
        ...(userName ? { userName } : {}),
        ...(userId ? { userId } : {}),
        hasSelection: anchor !== head,
        cursor: { from: anchor, to: head },
      });
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "cursorNotFound",
        message: "No live cursor matched the requested awareness identity",
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: "ambiguousCursor",
        message: "Multiple live cursors matched. Call listActiveCursors and retry with clientId.",
        candidates: candidates.map(({ cursor: _cursor, ...candidate }) => candidate),
      };
    }

    return {
      ok: true,
      ...candidates[0]!.cursor,
    };
  }

  private cursorContextFromRange(
    from: number,
    to: number,
    maxCharsBefore: number,
    maxCharsAfter: number,
  ): CursorContextResult {
    const text = this.getText();
    const range = normalizeRange(from, to);
    if (range.from !== range.to) {
      return {
        ok: true,
        hasSelection: true,
        selectedText: text.slice(range.from, range.to),
        selectedFrom: range.from,
        selectedTo: range.to,
        before: text.slice(Math.max(0, range.from - maxCharsBefore), range.from),
        after: text.slice(range.to, Math.min(text.length, range.to + maxCharsAfter)),
      };
    }

    return {
      ok: true,
      hasSelection: false,
      position: range.from,
      before: text.slice(Math.max(0, range.from - maxCharsBefore), range.from),
      after: text.slice(range.from, Math.min(text.length, range.from + maxCharsAfter)),
    };
  }

  private resolveSessionCursor(): CursorToolError | ({ ok: true } & ResolvedCursor) {
    if (!this.cursorAnchor || !this.cursorHead) {
      return {
        ok: false,
        reason: "noCursor",
        message: "This edit session does not have a cursor yet",
      };
    }

    const anchor = this.resolveRelativePosition(this.cursorAnchor);
    const head = this.resolveRelativePosition(this.cursorHead);
    if (anchor === null || head === null) {
      return {
        ok: false,
        reason: "cursorNotResolvable",
        message: "The edit session cursor could not be resolved against the current Yjs document",
      };
    }

    return {
      ok: true,
      from: anchor,
      to: head,
    };
  }

  private resolveMatches(matchIds: string[]): ResolvedMatch[] | CursorToolError {
    const uniqueMatchIds = Array.from(new Set(matchIds));
    const resolved: ResolvedMatch[] = [];
    for (const matchId of uniqueMatchIds) {
      const match = this.resolveMatch(matchId);
      if (!match.ok) {
        return match;
      }
      resolved.push(match);
    }
    return resolved;
  }

  private resolveMatch(matchId: string): ({ ok: true } & ResolvedMatch) | CursorToolError {
    const handle = this.matches.get(matchId);
    if (!handle) {
      return {
        ok: false,
        reason: "unknownMatch",
        message: `Unknown matchId: ${matchId}`,
        matchId,
      };
    }

    const start = this.resolveRelativePosition(handle.startAnchor);
    const end = this.resolveRelativePosition(handle.endAnchor);
    if (start === null || end === null) {
      return {
        ok: false,
        reason: "staleMatch",
        message: `Could not resolve matchId: ${matchId}`,
        matchId,
        expectedText: handle.expectedText,
      };
    }

    const range = normalizeRange(start, end);
    const currentText = this.getText().slice(range.from, range.to);
    if (currentText !== handle.expectedText) {
      return {
        ok: false,
        reason: "staleMatch",
        message: `Stored match ${matchId} no longer matches the current document text`,
        matchId,
        expectedText: handle.expectedText,
        currentText,
      };
    }

    return {
      ok: true,
      handle,
      from: range.from,
      to: range.to,
    };
  }

  private setCursor(position: number): void {
    const clamped = clampPosition(position, this.ytext.length);
    const anchor = this.createRelativePosition(clamped);
    this.cursorAnchor = anchor;
    this.cursorHead = anchor;
    this.publishCursor(anchor, anchor);
  }

  private setSelection(from: number, to: number): void {
    const safeFrom = clampPosition(from, this.ytext.length);
    const safeTo = clampPosition(to, this.ytext.length);
    const anchor = this.createRelativePosition(safeFrom);
    const head = this.createRelativePosition(safeTo);
    this.cursorAnchor = anchor;
    this.cursorHead = head;
    this.publishCursor(anchor, head);
  }

  private publishCursor(anchor: Y.RelativePosition, head: Y.RelativePosition): void {
    this.awareness.setLocalStateField("cursor", { anchor, head });
  }

  private createRelativePosition(position: number): Y.RelativePosition {
    return Y.createRelativePositionFromTypeIndex(
      this.ytext,
      clampPosition(position, this.ytext.length),
    );
  }

  private resolveRelativePosition(position: unknown): number | null {
    const relative = toRelativePosition(position);
    if (!relative) {
      return null;
    }
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, this.ydoc);
    if (!absolute || absolute.type !== this.ytext) {
      return null;
    }
    return clampPosition(absolute.index, this.ytext.length);
  }
}

function toRelativePosition(position: unknown): Y.RelativePosition | null {
  if (!position || typeof position !== "object") {
    return null;
  }
  try {
    return Y.createRelativePositionFromJSON(position as Record<string, unknown>);
  } catch {
    return null;
  }
}

function getAwarenessUser(state: unknown): { id?: unknown; name?: unknown } | undefined {
  if (!isRecord(state) || !isRecord(state.user)) {
    return undefined;
  }
  return state.user;
}

function getAwarenessCursor(
  state: unknown,
): { anchor: unknown; head: unknown } | undefined {
  if (!isRecord(state) || !isRecord(state.cursor)) {
    return undefined;
  }
  return {
    anchor: state.cursor.anchor,
    head: state.cursor.head,
  };
}

interface AwarenessUserColor {
  color: string;
  light: string;
}

const AWARENESS_USER_COLORS: AwarenessUserColor[] = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#6eeb83", light: "#6eeb8333" },
  { color: "#ffbc42", light: "#ffbc4233" },
  { color: "#ecd444", light: "#ecd44433" },
  { color: "#ee6352", light: "#ee635233" },
  { color: "#9ac2c9", light: "#9ac2c933" },
  { color: "#8acb88", light: "#8acb8833" },
  { color: "#1be7ff", light: "#1be7ff33" },
];

function randomAwarenessUserColor(): AwarenessUserColor {
  return AWARENESS_USER_COLORS[Math.floor(Math.random() * AWARENESS_USER_COLORS.length)]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function clampPosition(position: number, length: number): number {
  if (!Number.isFinite(position)) {
    return length;
  }
  return Math.max(0, Math.min(Math.trunc(position), length));
}

function normalizeRange(from: number, to: number): { from: number; to: number } {
  return from <= to ? { from, to } : { from: to, to: from };
}

interface MarkdownBlock {
  blockType: MarkdownBlockType;
  from: number;
  to: number;
}

function findMarkdownBlock(text: string, cursorPosition: number): MarkdownBlock {
  if (text.length === 0) {
    return { blockType: "document", from: 0, to: 0 };
  }

  const position = clampPosition(cursorPosition, text.length);
  const lines = getLineRanges(text);
  const lineIndex = findLineIndex(lines, position);

  const frontmatter = findFrontmatterBlock(text, lines, position);
  if (frontmatter) {
    return frontmatter;
  }

  const codeBlock = findFencedCodeBlock(lines, lineIndex);
  if (codeBlock) {
    return codeBlock;
  }

  const tableBlock = findTableBlock(lines, lineIndex);
  if (tableBlock) {
    return tableBlock;
  }

  const listBlock = findContiguousLineBlock(lines, lineIndex, "list", isListLine);
  if (listBlock) {
    return listBlock;
  }

  const quoteBlock = findContiguousLineBlock(lines, lineIndex, "blockquote", isBlockquoteLine);
  if (quoteBlock) {
    return quoteBlock;
  }

  const current = lines[lineIndex];
  if (!current) {
    return { blockType: "document", from: 0, to: text.length };
  }
  if (/^#{1,6}\s+/.test(current.text)) {
    return { blockType: "heading", from: current.start, to: current.end };
  }
  if (current.text.trim() === "") {
    return { blockType: "blank", from: current.start, to: current.end };
  }

  let start = lineIndex;
  let end = lineIndex;
  while (start > 0 && lines[start - 1]!.text.trim() !== "") {
    start -= 1;
  }
  while (end + 1 < lines.length && lines[end + 1]!.text.trim() !== "") {
    end += 1;
  }

  return {
    blockType: "paragraph",
    from: lines[start]!.start,
    to: lines[end]!.end,
  };
}

interface LineRange {
  start: number;
  end: number;
  endWithNewline: number;
  text: string;
}

function getLineRanges(text: string): LineRange[] {
  const lines: LineRange[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline >= 0 ? newline : text.length;
    lines.push({
      start,
      end,
      endWithNewline: newline >= 0 ? newline + 1 : end,
      text: text.slice(start, end),
    });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}

function findLineIndex(lines: LineRange[], position: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (position >= line.start && position <= line.endWithNewline) {
      return index;
    }
  }
  return Math.max(0, lines.length - 1);
}

function findFrontmatterBlock(
  _text: string,
  lines: LineRange[],
  position: number,
): MarkdownBlock | null {
  if (lines[0]?.text !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.text === "---") {
      const block = {
        blockType: "frontmatter" as const,
        from: lines[0]!.start,
        to: lines[index]!.end,
      };
      return position >= block.from && position <= block.to ? block : null;
    }
  }
  return null;
}

function findFencedCodeBlock(lines: LineRange[], lineIndex: number): MarkdownBlock | null {
  let opening = -1;
  let marker = "";

  for (let index = 0; index < lines.length; index += 1) {
    const fence = getFenceMarker(lines[index]!.text);
    if (!fence) {
      continue;
    }

    if (opening < 0) {
      opening = index;
      marker = fence;
      continue;
    }

    if (fence === marker) {
      if (lineIndex >= opening && lineIndex <= index) {
        return {
          blockType: "code block",
          from: lines[opening]!.start,
          to: lines[index]!.end,
        };
      }
      opening = -1;
      marker = "";
    }
  }

  if (opening >= 0 && lineIndex >= opening) {
    return {
      blockType: "code block",
      from: lines[opening]!.start,
      to: lines[lines.length - 1]!.end,
    };
  }
  return null;
}

function findTableBlock(lines: LineRange[], lineIndex: number): MarkdownBlock | null {
  const current = lines[lineIndex];
  if (!current || !isTableLine(current.text)) {
    return null;
  }

  let start = lineIndex;
  let end = lineIndex;
  while (start > 0 && isTableLine(lines[start - 1]!.text)) {
    start -= 1;
  }
  while (end + 1 < lines.length && isTableLine(lines[end + 1]!.text)) {
    end += 1;
  }

  const hasSeparator = lines
    .slice(start, end + 1)
    .some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.text));
  if (!hasSeparator) {
    return null;
  }

  return {
    blockType: "table",
    from: lines[start]!.start,
    to: lines[end]!.end,
  };
}

function findContiguousLineBlock(
  lines: LineRange[],
  lineIndex: number,
  blockType: "list" | "blockquote",
  predicate: (line: string) => boolean,
): MarkdownBlock | null {
  const current = lines[lineIndex];
  if (!current || !predicate(current.text)) {
    return null;
  }

  let start = lineIndex;
  let end = lineIndex;
  while (start > 0 && predicate(lines[start - 1]!.text)) {
    start -= 1;
  }
  while (end + 1 < lines.length && predicate(lines[end + 1]!.text)) {
    end += 1;
  }
  return {
    blockType,
    from: lines[start]!.start,
    to: lines[end]!.end,
  };
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isTableLine(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

function getFenceMarker(line: string): "```" | "~~~" | null {
  if (line.startsWith("```")) {
    return "```";
  }
  if (line.startsWith("~~~")) {
    return "~~~";
  }
  return null;
}
