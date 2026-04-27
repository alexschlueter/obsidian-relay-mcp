import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadRelayClientFileConfig, RelayClient } from "../src";

const storedConfig = loadRelayClientFileConfig().config;
const missingBaseConfiguration = [
  ...(process.env.RELAY_BEARER_TOKEN ?? storedConfig?.bearerToken ? [] : ["RELAY_BEARER_TOKEN or saved config"]),
  ...(process.env.RELAY_ID ?? storedConfig?.relayId ? [] : ["RELAY_ID or saved config"]),
  ...(process.env.RELAY_FOLDER_ID ?? storedConfig?.folderId ? [] : ["RELAY_FOLDER_ID or saved config"]),
] as const;

const liveBaseEnabled = missingBaseConfiguration.length === 0;
const writeRoundTripEnabled = isTruthy(process.env.RELAY_LIVE_TEST_WRITE);
const notePath = process.env.RELAY_LIVE_TEST_NOTE_PATH ?? "";
const attachmentPath = process.env.RELAY_LIVE_TEST_ATTACHMENT_PATH ?? "";
const attachmentMaxBytes = parseInteger(process.env.RELAY_LIVE_TEST_ATTACHMENT_MAX_BYTES, 5_000_000);
const timeoutMs = parseInteger(process.env.RELAY_LIVE_TEST_TIMEOUT_MS, 20_000);
const editSessionTtlSeconds = Math.ceil(timeoutMs / 1000);
const pollIntervalMs = parseInteger(process.env.RELAY_LIVE_TEST_POLL_MS, 500);
const liveIntegrationAgentName = "obsidian-relay-mcp live integration";

const describeLive = liveBaseEnabled ? describe : describe.skip;

describeLive("Relay live integration", () => {
  const noteTest = notePath ? it : it.skip;
  const attachmentTest = attachmentPath ? it : it.skip;

  noteTest(
    "reads a configured note from the live Relay folder",
    async () => {
      const relay = RelayClient.fromEnv();
      const folder = await relay.loadFolder();
      const entry = relay.resolvePath(folder, notePath);

      expect(entry, `Expected ${notePath} to exist in the configured Relay folder`).toBeDefined();
      expect(entry?.resourceKind).toBe("document");

      const { text } = await relay.readText(notePath);

      expect(typeof text).toBe("string");

      console.log(`[live-relay] resolved ${notePath} -> ${entry?.id}`);
      console.log(`[live-relay] current note length: ${text.length} characters`);
    },
    timeoutMs,
  );

  attachmentTest(
    "reads a configured attachment from the live Relay folder",
    async () => {
      const relay = RelayClient.fromEnv();
      const folder = await relay.loadFolder();
      const entry = relay.resolvePath(folder, attachmentPath);

      expect(
        entry,
        `Expected ${attachmentPath} to exist in the configured Relay folder`,
      ).toBeDefined();
      expect(entry?.resourceKind).toBe("file");
      const entryHash = entry?.hash;
      expect(entryHash, `Expected ${attachmentPath} to have attachment hash metadata`).toEqual(
        expect.stringMatching(/^[0-9a-f]{64}$/i),
      );

      const listed = await relay.listFiles({
        query: attachmentPath,
        maxResults: 200,
      });
      expect(listed.entries).toContainEqual({
        path: attachmentPath,
        kind: "attachment",
      });

      const attachment = await relay.readAttachment(attachmentPath, {
        includeImageContent: entry?.mimetype?.toLocaleLowerCase().startsWith("image/") === true,
        maxImageContentMB: attachmentMaxBytes / 1024 / 1024,
      });
      expect(
        attachment.dataBase64,
        `Expected ${attachmentPath} to return inline image data for the live attachment smoke test`,
      ).toBeDefined();
      const dataBase64 = attachment.dataBase64!;
      const bytes = Buffer.from(dataBase64, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      expect(attachment).toMatchObject({
        ok: true,
        hash: entryHash,
      });
      expect(attachment.contentLength).toBe(bytes.byteLength);
      expect(attachment.hash).toBe(entryHash);
      expect(attachment.hash).toBe(sha256);
      if (entry?.mimetype) {
        expect(attachment.contentType).toBe(entry.mimetype);
      }

      const boundedRead = await relay.readAttachment(attachmentPath, {
        includeImageContent: true,
        maxImageContentMB: attachment.contentLength! / 1024 / 1024,
      });
      expect(boundedRead.dataBase64).toBe(attachment.dataBase64);

      if (attachment.contentLength! > 0) {
        const limitedRead = await relay.readAttachment(attachmentPath, {
          includeImageContent: true,
          maxImageContentMB: (attachment.contentLength! - 1) / 1024 / 1024,
        });
        expect(limitedRead).toMatchObject({
          ok: true,
          contentLimitExceeded: true,
          contentType: attachment.contentType,
          hash: entryHash,
        });
        expect(limitedRead.dataBase64).toBeUndefined();
      }

      console.log(
        `[live-relay] resolved attachment ${attachmentPath} -> ${entry?.id} (${attachment.contentLength} bytes)`,
      );
    },
    timeoutMs,
  );

  const writeTest = notePath && writeRoundTripEnabled ? it : it.skip;

  noteTest(
    "opens a live edit session and publishes an agent cursor",
    async () => {
      const relay = RelayClient.fromEnv();
      const { sessionId } = await relay.openEditSession(
        notePath,
        liveIntegrationAgentName,
        editSessionTtlSeconds,
      );

      try {
        const cursors = await relay.listActiveCursors(sessionId);
        expect(cursors).toContainEqual({
          clientId: expect.any(Number),
          userId: `obsidian-relay-mcp:${sessionId}`,
          userName: liveIntegrationAgentName,
          hasSelection: false,
        });

        const context = await relay.getCursorContext(sessionId, {
          maxCharsBefore: 40,
          maxCharsAfter: 40,
        });
        expect(context.ok).toBe(true);
        expect(context).toMatchObject({
          hasSelection: false,
        });
      } finally {
        await relay.closeEditSession(sessionId);
      }
    },
    timeoutMs,
  );

  writeTest(
    "appends and removes a unique smoke-test marker through Relay",
    async () => {
      const relay = RelayClient.fromEnv();
      const markerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const markerBlock = buildMarkerBlock(markerId);

      const originalText = await cleanupSmokeTestMarkers(
        relay,
        notePath,
        timeoutMs,
        pollIntervalMs,
      );
      expect(originalText).not.toContain(markerBlock);

      const original = await relay.readText(notePath);
      await relay.applyPatch(
        original.handle,
        buildReplacePatch(notePath, originalText, appendMarker(originalText, markerBlock)),
      );

      try {
        const withMarker = await waitForNoteState(
          relay,
          notePath,
          (text) => text.includes(markerId),
          timeoutMs,
          pollIntervalMs,
        );

        expect(withMarker).toContain(markerId);
        console.log(`[live-relay] marker appended to ${notePath}`);
      } finally {
        const cleanupRead = await relay.readText(notePath);
        if (cleanupRead.text.includes(markerId)) {
          await relay.writeText(notePath, originalText);
        }
        const cleanedText = await waitForNoteState(
          relay,
          notePath,
          (text) => text === originalText,
          timeoutMs,
          pollIntervalMs,
        );

        expect(cleanedText).not.toContain(markerId);
        expect(cleanedText).toBe(
          originalText,
        );
        console.log(`[live-relay] marker removed and note restored`);
      }
    },
    timeoutMs * 2,
  );

  writeTest(
    "exercises live edit-session cursor, selection, search, and edit methods",
    async () => {
      const relay = RelayClient.fromEnv();
      const markerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const marker = buildLiveSessionMarker(markerId);
      const original = await relay.readText(notePath);
      let sessionId: string | undefined;

      try {
        const { sessionId: openedSessionId } = await relay.openEditSession(
          notePath,
          liveIntegrationAgentName,
          editSessionTtlSeconds * 3,
        );
        sessionId = openedSessionId;

        const atEnd = await relay.placeCursorAtDocumentBoundary(sessionId, "end");
        expect(atEnd).toMatchObject({ ok: true });

        const insertResult = await relay.insertText(sessionId, marker.insertedBlock);
        expect(insertResult).toEqual({
          ok: true,
          insertedChars: marker.insertedBlock.length,
        });

        await waitForNoteState(
          relay,
          notePath,
          (text) => text.includes(marker.openingComment),
          timeoutMs,
          pollIntervalMs,
        );

        const openMatches = await relay.searchText(sessionId, marker.openingComment);
        expect(openMatches.matches).toHaveLength(1);

        const headingMatches = await relay.searchText(sessionId, marker.headingText);
        expect(headingMatches.matches).toHaveLength(1);

        const headingCursor = await relay.placeCursor(
          sessionId,
          headingMatches.matches[0]!.matchId,
          "start",
        );
        expect(headingCursor).toMatchObject({ ok: true });

        const headingBlock = await relay.selectCurrentBlock(sessionId);
        expect(headingBlock).toMatchObject({
          ok: true,
          blockType: "heading",
          selectedText: marker.headingLine,
        });

        const headingSelectionContext = await relay.getCursorContext(sessionId);
        expect(headingSelectionContext).toMatchObject({
          ok: true,
          hasSelection: true,
          selectedText: marker.headingLine,
        });

        const clearResult = await relay.clearSelection(sessionId);
        expect(clearResult).toMatchObject({ ok: true });

        const afterClearContext = await relay.getCursorContext(sessionId);
        expect(afterClearContext).toMatchObject({
          ok: true,
          hasSelection: false,
        });

        const tokenAMatches = await relay.searchText(sessionId, marker.tokenA);
        const tokenBMatches = await relay.searchText(sessionId, marker.tokenB);
        const tokenCMatches = await relay.searchText(sessionId, marker.tokenC);
        expect(tokenAMatches.matches).toHaveLength(1);
        expect(tokenBMatches.matches).toHaveLength(1);
        expect(tokenCMatches.matches).toHaveLength(1);

        const listCursor = await relay.placeCursor(
          sessionId,
          tokenAMatches.matches[0]!.matchId,
          "start",
        );
        expect(listCursor).toMatchObject({ ok: true });

        const listBlock = await relay.selectCurrentBlock(sessionId);
        expect(listBlock).toMatchObject({
          ok: true,
          blockType: "list",
        });
        expect(listBlock.ok && listBlock.selectedText).toContain(marker.tokenA);
        expect(listBlock.ok && listBlock.selectedText).toContain(marker.tokenB);

        const selectedToken = await relay.selectText(sessionId, tokenCMatches.matches[0]!.matchId);
        expect(selectedToken).toEqual({
          ok: true,
          selectedText: marker.tokenC,
          selectedFrom: expect.any(Number),
          selectedTo: expect.any(Number),
        });

        const selectedContext = await relay.getCursorContext(sessionId);
        expect(selectedContext).toMatchObject({
          ok: true,
          hasSelection: true,
          selectedText: marker.tokenC,
        });

        const replacement = `${marker.tokenB}-replaced`;
        const replaceResult = await relay.replaceMatches(
          sessionId,
          [tokenBMatches.matches[0]!.matchId],
          replacement,
        );
        expect(replaceResult).toEqual({
          ok: true,
          replacedCount: 1,
          insertedChars: replacement.length,
        });

        const closeMatches = await relay.searchText(sessionId, marker.closingComment);
        expect(closeMatches.matches).toHaveLength(1);

        const between = await relay.selectBetweenMatches(
          sessionId,
          openMatches.matches[0]!.matchId,
          closeMatches.matches[0]!.matchId,
        );
        expect(between).toMatchObject({
          ok: true,
          selectedText: expect.stringContaining(replacement),
        });

        const deleteTarget = await relay.searchText(sessionId, marker.tokenA);
        expect(deleteTarget.matches).toHaveLength(1);
        const selectedA = await relay.selectText(sessionId, deleteTarget.matches[0]!.matchId);
        expect(selectedA).toMatchObject({
          ok: true,
          selectedText: marker.tokenA,
        });

        const deleteResult = await relay.deleteSelection(sessionId);
        expect(deleteResult).toEqual({
          ok: true,
          numCharsDeleted: marker.tokenA.length,
        });

        const latest = await waitForNoteState(
          relay,
          notePath,
          (text) =>
            text.includes(replacement) &&
            !text.includes(marker.tokenA) &&
            text.includes(marker.closingComment),
          timeoutMs,
          pollIntervalMs,
        );

        expect(latest).toContain(replacement);
        expect(latest).not.toContain(marker.tokenA);
        console.log(`[live-relay] live edit-session methods exercised on ${notePath}`);
      } finally {
        if (sessionId) {
          await relay.closeEditSession(sessionId);
        }

        const cleanupRead = await relay.readText(notePath);
        if (cleanupRead.text.includes(markerId)) {
          await relay.writeText(notePath, original.text);
          await waitForNoteState(
            relay,
            notePath,
            (text) => text === original.text,
            timeoutMs,
            pollIntervalMs,
          );
          console.log(`[live-relay] live edit-session marker removed`);
        }
      }
    },
    timeoutMs * 3,
  );
});

if (!liveBaseEnabled) {
  describe("Relay live integration setup", () => {
    it("documents the missing env vars for the live test", () => {
      console.log(
        `[live-relay] skipped because this base configuration is missing: ${missingBaseConfiguration.join(", ")}`,
      );
      console.log("[live-relay] set RELAY_LIVE_TEST_NOTE_PATH to include note smoke tests");
      console.log(
        "[live-relay] set RELAY_LIVE_TEST_WRITE=1 as well if you want the reversible write smoke test",
      );
      console.log(
        "[live-relay] set RELAY_LIVE_TEST_ATTACHMENT_PATH to include the read-only attachment smoke test",
      );
    });
  });
} else if (!notePath && !attachmentPath) {
  describe("Relay live integration setup", () => {
    it("documents the missing live test paths", () => {
      console.log(
        "[live-relay] skipped because no live test path is configured: set RELAY_LIVE_TEST_NOTE_PATH and/or RELAY_LIVE_TEST_ATTACHMENT_PATH",
      );
    });
  });
}

function buildMarkerBlock(markerId: string): string {
  return `\n\n<!-- relay-client live smoke test ${markerId} -->\nrelay-client live smoke test ${markerId}\n`;
}

function buildLiveSessionMarker(markerId: string): {
  insertedBlock: string;
  openingComment: string;
  closingComment: string;
  headingLine: string;
  headingText: string;
  tokenA: string;
  tokenB: string;
  tokenC: string;
} {
  const openingComment = `<!-- obsidian-relay-mcp live session test ${markerId} -->`;
  const closingComment = `<!-- /obsidian-relay-mcp live session test ${markerId} -->`;
  const headingText = `obsidian-relay-mcp live heading ${markerId}`;
  const headingLine = `# ${headingText}`;
  const tokenA = `obsidian-relay-mcp-token-a-${markerId}`;
  const tokenB = `obsidian-relay-mcp-token-b-${markerId}`;
  const tokenC = `obsidian-relay-mcp-token-c-${markerId}`;
  const insertedBlock = [
    "",
    "",
    openingComment,
    headingLine,
    `- ${tokenA}`,
    `- ${tokenB}`,
    tokenC,
    closingComment,
    "",
  ].join("\n");

  return {
    insertedBlock,
    openingComment,
    closingComment,
    headingLine,
    headingText,
    tokenA,
    tokenB,
    tokenC,
  };
}

function appendMarker(current: string, markerBlock: string): string {
  if (current.endsWith("\n")) {
    return `${current}${markerBlock.slice(1)}`;
  }
  return `${current}${markerBlock}`;
}

async function cleanupSmokeTestMarkers(
  relay: RelayClient,
  path: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const startedAt = Date.now();
  let latestText = "";

  while (Date.now() - startedAt <= timeoutMs) {
    const read = await relay.readText(path);
    latestText = read.text;
    const cleaned = removeAllSmokeTestMarkerBlocks(latestText);
    if (cleaned === latestText) {
      return latestText;
    }

    await relay.writeText(path, cleaned);
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out cleaning RelayClient live smoke test markers from ${path}`);
}

function removeAllSmokeTestMarkerBlocks(text: string): string {
  const markerPattern =
    /\n*<!-- relay-client live smoke test [^>\n]+ -->\nrelay-client live smoke test [^\n]*(?:\n|$)*/g;
  return text.replace(markerPattern, "");
}

function buildReplacePatch(path: string, before: string, after: string): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...splitPatchLines(before).map((line) => `-${line}`),
    ...splitPatchLines(after).map((line) => `+${line}`),
    "*** End Patch",
  ].join("\n");
}

async function waitForNoteState(
  relay: RelayClient,
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const { text } = await relay.readText(path);
    if (predicate(text)) {
      return text;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${path} to reach the expected state`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(rawValue: string | undefined): boolean {
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
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
