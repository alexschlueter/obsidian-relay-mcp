import { describe, expect, it } from "vitest";
import { loadRelayCoreFileConfig, RelayCore } from "../src";

const storedConfig = loadRelayCoreFileConfig().config;
const missingConfiguration = [
  ...(process.env.RELAY_BEARER_TOKEN ?? storedConfig?.bearerToken ? [] : ["RELAY_BEARER_TOKEN or saved config"]),
  ...(process.env.RELAY_ID ?? storedConfig?.relayId ? [] : ["RELAY_ID or saved config"]),
  ...(process.env.RELAY_FOLDER_ID ?? storedConfig?.folderId ? [] : ["RELAY_FOLDER_ID or saved config"]),
  ...(process.env.RELAY_LIVE_TEST_NOTE_PATH ? [] : ["RELAY_LIVE_TEST_NOTE_PATH"]),
] as const;

const liveTestEnabled = missingConfiguration.length === 0;
const writeRoundTripEnabled = isTruthy(process.env.RELAY_LIVE_TEST_WRITE);
const notePath = process.env.RELAY_LIVE_TEST_NOTE_PATH ?? "";
const timeoutMs = parseInteger(process.env.RELAY_LIVE_TEST_TIMEOUT_MS, 20_000);
const pollIntervalMs = parseInteger(process.env.RELAY_LIVE_TEST_POLL_MS, 500);

const describeLive = liveTestEnabled ? describe : describe.skip;

describeLive("Relay live integration", () => {
  it(
    "reads a configured note from the live Relay folder",
    async () => {
      const relay = RelayCore.fromEnv();
      const folder = await relay.loadFolder();
      const entry = relay.resolvePath(folder, notePath);

      expect(entry, `Expected ${notePath} to exist in the configured Relay folder`).toBeDefined();
      expect(entry?.resourceKind).toBe("document");

      const text = await relay.readText(notePath);

      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);

      console.log(`[live-relay] resolved ${notePath} -> ${entry?.id}`);
      console.log(`[live-relay] current note length: ${text.length} characters`);
    },
    timeoutMs,
  );

  const writeTest = writeRoundTripEnabled ? it : it.skip;

  writeTest(
    "appends and removes a unique smoke-test marker through Relay",
    async () => {
      const relay = RelayCore.fromEnv();
      const markerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const markerBlock = buildMarkerBlock(markerId);

      const originalText = await relay.readText(notePath);
      expect(originalText).not.toContain(markerBlock);

      await relay.patchText(notePath, (current) => {
        if (current.includes(markerBlock)) {
          return current;
        }

        return appendMarker(current, markerBlock);
      });

      try {
        const withMarker = await waitForNoteState(
          relay,
          notePath,
          (text) => text.includes(markerBlock),
          timeoutMs,
          pollIntervalMs,
        );

        expect(withMarker).toContain(markerBlock);
        console.log(`[live-relay] marker appended to ${notePath}`);
      } finally {
        await relay.patchText(notePath, (current) => current.replace(markerBlock, ""));

        const cleanedText = await waitForNoteState(
          relay,
          notePath,
          (text) => !text.includes(markerBlock),
          timeoutMs,
          pollIntervalMs,
        );

        expect(cleanedText).not.toContain(markerBlock);
        expect(cleanedText).toBe(
          originalText,
        );
        console.log(`[live-relay] marker removed and note restored`);
      }
    },
    timeoutMs * 2,
  );
});

if (!liveTestEnabled) {
  describe("Relay live integration setup", () => {
    it("documents the missing env vars for the live test", () => {
      console.log(
        `[live-relay] skipped because this configuration is missing: ${missingConfiguration.join(", ")}`,
      );
      console.log(
        "[live-relay] set RELAY_LIVE_TEST_WRITE=1 as well if you want the reversible write smoke test",
      );
    });
  });
}

function buildMarkerBlock(markerId: string): string {
  return `\n\n<!-- relay-core live smoke test ${markerId} -->\nrelay-core live smoke test ${markerId}\n`;
}

function appendMarker(current: string, markerBlock: string): string {
  if (current.endsWith("\n")) {
    return `${current}${markerBlock.slice(1)}`;
  }
  return `${current}${markerBlock}`;
}

async function waitForNoteState(
  relay: RelayCore,
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const text = await relay.readText(path);
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
