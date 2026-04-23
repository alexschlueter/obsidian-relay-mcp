import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { RelayCore } from "../src/relay-core/relayCore";
import {
  createRelayMcpServer,
  MCP_RELAY_DEFAULT_EDIT_SESSION_TTL_SECONDS,
  RELAY_MCP_TOOL_NAMES,
} from "../src/mcp/relayMcpServer";

describe("Relay MCP server", () => {
  it("registers the agreed tool surface without write_text", async () => {
    await withMcpClient(createFakeRelayCore(), async ({ client }) => {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([...RELAY_MCP_TOOL_NAMES].sort());
      expect(toolNames).not.toContain("write_text");
    });
  });

  it("presents Obsidian-facing metadata to agents", async () => {
    await withMcpClient(createFakeRelayCore(), async ({ client }) => {
      const tools = await client.listTools();
      const serverVersion = client.getServerVersion();
      const agentFacingStrings = [
        serverVersion?.name ?? "",
        ...collectStrings(tools.tools),
      ];

      expect(serverVersion?.name).toBe("obsidian-notes");
      expect(agentFacingStrings.filter((value) => /\brelay\b|mcp-relay/i.test(value))).toEqual([]);
      expect(agentFacingStrings.some((value) => /Obsidian/i.test(value))).toBe(true);
    });
  });

  it("keeps tool names snake_case but exposes camelCase arguments", async () => {
    await withMcpClient(createFakeRelayCore(), async ({ client }) => {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      const argumentNames = tools.tools.flatMap((tool) =>
        Object.keys(tool.inputSchema.properties ?? {}),
      );

      expect(toolNames).toContain("read_text");
      expect(toolNames).toContain("apply_patch");
      expect(argumentNames).toContain("patchHandle");
      expect(argumentNames).toContain("sessionId");
      expect(argumentNames.filter((name) => name.includes("_"))).toEqual([]);
    });
  });

  it("maps read_text camelCase args to RelayCore readText options", async () => {
    const fakeCore = createFakeRelayCore();

    await withMcpClient(fakeCore, async ({ client }) => {
      const result = await client.callTool({
        name: "read_text",
        arguments: {
          path: "Notes/Test.md",
          startChar: 10,
          maxChars: 25,
          ttlSeconds: 12,
        },
      });

      expect(result.structuredContent).toMatchObject({
        patchHandle: "00000",
        handle: "00000",
        text: "hello",
      });
      expect(fakeCore.calls).toContainEqual({
        method: "readText",
        args: [
          "Notes/Test.md",
          {
            startChar: 10,
            maxChars: 25,
            ttlSeconds: 12,
          },
        ],
      });
    });
  });

  it("maps apply_patch camelCase args to RelayCore patchText", async () => {
    const fakeCore = createFakeRelayCore();

    await withMcpClient(fakeCore, async ({ client }) => {
      const result = await client.callTool({
        name: "apply_patch",
        arguments: {
          patchHandle: "abcde",
          path: "Notes/Test.md",
          patch: "*** Begin Patch\n*** Update File: Notes/Test.md\n@@\n-old\n+new\n*** End Patch",
          returnResult: false,
        },
      });

      expect(result.structuredContent).toMatchObject({
        changed: true,
        staleHandle: false,
      });
      expect(fakeCore.calls).toContainEqual({
        method: "patchText",
        args: [
          "abcde",
          "Notes/Test.md",
          "*** Begin Patch\n*** Update File: Notes/Test.md\n@@\n-old\n+new\n*** End Patch",
          { returnResult: false },
        ],
      });
    });
  });

  it("uses a 10 minute default TTL for open_edit_session", async () => {
    const fakeCore = createFakeRelayCore();

    await withMcpClient(fakeCore, async ({ client }) => {
      const result = await client.callTool({
        name: "open_edit_session",
        arguments: {
          path: "Notes/Test.md",
        },
      });

      expect(result.structuredContent).toEqual({ sessionId: "11111" });
      expect(fakeCore.calls).toContainEqual({
        method: "openEditSession",
        args: ["Notes/Test.md", MCP_RELAY_DEFAULT_EDIT_SESSION_TTL_SECONDS],
      });
    });
  });

  it("wraps list_active_cursors arrays in structured content", async () => {
    await withMcpClient(createFakeRelayCore(), async ({ client }) => {
      const result = await client.callTool({
        name: "list_active_cursors",
        arguments: {
          sessionId: "11111",
        },
      });

      expect(result.structuredContent).toEqual({
        ok: true,
        cursors: [
          {
            clientId: 7,
            userId: "user-1",
            userName: "Alex",
            hasSelection: true,
          },
        ],
      });
    });
  });

  it("returns structured tool errors for thrown RelayCore errors", async () => {
    const fakeCore = createFakeRelayCore();
    fakeCore.failRead = true;

    await withMcpClient(fakeCore, async ({ client }) => {
      const result = await client.callTool({
        name: "read_text",
        arguments: {
          path: "Notes/Test.md",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        reason: "toolError",
        message: "simulated read failure",
      });
    });
  });
});

async function withMcpClient(
  fakeCore: FakeRelayCore,
  fn: (context: { client: Client; fakeCore: FakeRelayCore }) => Promise<void>,
): Promise<void> {
  const server = createRelayMcpServer({
    core: fakeCore as unknown as RelayCore,
  });
  const client = new Client({
    name: "mcp-relay-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await fn({ client, fakeCore });
  } finally {
    await client.close();
    await server.close();
  }
}

interface FakeCall {
  method: string;
  args: unknown[];
}

interface FakeRelayCore {
  calls: FakeCall[];
  failRead: boolean;
  readText(path: string, options?: unknown): Promise<unknown>;
  patchText(...args: unknown[]): Promise<unknown>;
  openEditSession(path: string, ttlSeconds?: number): Promise<unknown>;
  closeEditSession(sessionId: string): boolean;
  getCursorContext(sessionId: string, options?: unknown): Promise<unknown>;
  listActiveCursors(sessionId: string): Promise<unknown>;
  searchText(sessionId: string, query: string, maxResults?: number): Promise<unknown>;
  replaceMatches(...args: unknown[]): Promise<unknown>;
  placeCursor(...args: unknown[]): Promise<unknown>;
  placeCursorAtDocumentBoundary(sessionId: string, boundary: "start" | "end"): Promise<unknown>;
  selectText(...args: unknown[]): Promise<unknown>;
  selectCurrentBlock(sessionId: string): Promise<unknown>;
  selectBetweenMatches(...args: unknown[]): Promise<unknown>;
  clearSelection(sessionId: string): Promise<unknown>;
  insertText(sessionId: string, text: string): Promise<unknown>;
  deleteSelection(sessionId: string): Promise<unknown>;
}

function createFakeRelayCore(): FakeRelayCore {
  const calls: FakeCall[] = [];
  return {
    calls,
    failRead: false,
    async readText(path, options) {
      calls.push({ method: "readText", args: options === undefined ? [path] : [path, options] });
      if (this.failRead) {
        throw new Error("simulated read failure");
      }
      return {
        patchHandle: "00000",
        handle: "00000",
        text: "hello",
        totalChars: 5,
        startChar: 0,
        endChar: 5,
        truncated: false,
      };
    },
    async patchText(...args) {
      calls.push({ method: "patchText", args });
      return {
        changed: true,
        staleHandle: false,
      };
    },
    async openEditSession(path, ttlSeconds) {
      calls.push({ method: "openEditSession", args: [path, ttlSeconds] });
      return { sessionId: "11111" };
    },
    closeEditSession(sessionId) {
      calls.push({ method: "closeEditSession", args: [sessionId] });
      return true;
    },
    async getCursorContext(sessionId, options) {
      calls.push({ method: "getCursorContext", args: [sessionId, options] });
      return {
        ok: true,
        hasSelection: false,
        position: 0,
        before: "",
        after: "hello",
      };
    },
    async listActiveCursors(sessionId) {
      calls.push({ method: "listActiveCursors", args: [sessionId] });
      return [
        {
          clientId: 7,
          userId: "user-1",
          userName: "Alex",
          hasSelection: true,
        },
      ];
    },
    async searchText(sessionId, query, maxResults) {
      calls.push({ method: "searchText", args: [sessionId, query, maxResults] });
      return {
        ok: true,
        matches: [
          {
            matchId: "22222",
            before: "",
            after: "",
            startPos: 0,
          },
        ],
      };
    },
    async replaceMatches(...args) {
      calls.push({ method: "replaceMatches", args });
      return { ok: true, replacedCount: 1, insertedChars: 3 };
    },
    async placeCursor(...args) {
      calls.push({ method: "placeCursor", args });
      return { ok: true, position: 0 };
    },
    async placeCursorAtDocumentBoundary(sessionId, boundary) {
      calls.push({ method: "placeCursorAtDocumentBoundary", args: [sessionId, boundary] });
      return { ok: true, position: 0 };
    },
    async selectText(...args) {
      calls.push({ method: "selectText", args });
      return { ok: true, selectedText: "hello", selectedFrom: 0, selectedTo: 5 };
    },
    async selectCurrentBlock(sessionId) {
      calls.push({ method: "selectCurrentBlock", args: [sessionId] });
      return { ok: true, blockType: "paragraph", selectedText: "hello", selectedFrom: 0, selectedTo: 5 };
    },
    async selectBetweenMatches(...args) {
      calls.push({ method: "selectBetweenMatches", args });
      return {
        ok: true,
        selectedText: "hello",
        selectedFrom: 0,
        selectedTo: 5,
        selectionStartPreview: "hello",
        selectionEndPreview: "hello",
      };
    },
    async clearSelection(sessionId) {
      calls.push({ method: "clearSelection", args: [sessionId] });
      return { ok: true, position: 0 };
    },
    async insertText(sessionId, text) {
      calls.push({ method: "insertText", args: [sessionId, text] });
      return { ok: true, insertedChars: text.length };
    },
    async deleteSelection(sessionId) {
      calls.push({ method: "deleteSelection", args: [sessionId] });
      return { ok: true, numCharsDeleted: 5 };
    },
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item) => collectStrings(item));
  }
  return [];
}
