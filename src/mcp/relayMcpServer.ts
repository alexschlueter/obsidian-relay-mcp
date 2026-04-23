import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  RelayApplyPatchOptions,
  RelayClient,
  RelayReadTextOptions,
  RELAY_HANDLE_LENGTH,
} from "../relay-client/relayClient";

export const MCP_RELAY_DEFAULT_PATCH_TTL_SECONDS = 60;
export const MCP_RELAY_DEFAULT_EDIT_SESSION_TTL_SECONDS = 600;

export const RELAY_MCP_TOOL_NAMES = [
  "read_text",
  "apply_patch",
  "open_edit_session",
  "close_edit_session",
  "get_cursor_context",
  "list_active_cursors",
  "search_text",
  "replace_matches",
  "place_cursor",
  "place_cursor_at_document_boundary",
  "select_text",
  "select_current_block",
  "select_between_matches",
  "clear_selection",
  "insert_text",
  "delete_selection",
] as const;

export interface RelayMcpServerOptions {
  client?: RelayClient;
  env?: NodeJS.ProcessEnv;
  name?: string;
  version?: string;
}

export function createRelayMcpServer(options: RelayMcpServerOptions = {}): McpServer {
  const client = options.client ?? createRelayClientFromEnvForMcp(options.env);
  const server = new McpServer({
    name: options.name ?? "obsidian-notes",
    version: options.version ?? "0.1.0",
  });

  registerRelayMcpTools(server, client);
  return server;
}

export function createRelayClientFromEnvForMcp(env: NodeJS.ProcessEnv = process.env): RelayClient {
  const client = RelayClient.fromEnv(env);
  if (!client.defaultRelayId || !client.defaultFolderId) {
    throw new Error(
      "The Obsidian MCP server needs a configured sync target. Set RELAY_ID and RELAY_FOLDER_ID or run pnpm choose:target.",
    );
  }
  return client;
}

export function registerRelayMcpTools(server: McpServer, client: RelayClient): void {
  server.registerTool(
    "read_text",
    {
      title: "Read Obsidian Markdown",
      description:
        "Read an Obsidian note by vault-relative path and create a handle referring to this version for later use with the apply_patch tool.",
      inputSchema: {
        path: pathSchema,
        startChar: nonNegativeIntegerSchema.optional().describe("Optional inclusive character offset to start reading from."),
        maxChars: nonNegativeIntegerSchema.optional().describe("Optional maximum number of characters to return."),
        ttlSeconds: ttlSecondsSchema.optional().describe("Patch handle TTL in seconds. Defaults to 60."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, startChar, maxChars, ttlSeconds }) =>
      runRelayTool(async () =>
        client.readText(path, buildReadOptions({
          ttlSeconds,
          startChar,
          maxChars,
        })),
      ),
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Patch Obsidian Markdown",
      description:
        "Apply one Codex-style *** Update File patch against a patchHandle returned by read_text. The patch must include its file path; optional path is validated if provided.",
      inputSchema: {
        patchHandle: handleSchema.describe("Patch handle returned by read_text."),
        path: pathSchema.optional().describe("Optional path guard. If provided, it must match the patch path and handle path."),
        patch: z.string().min(1).describe("Codex-style patch containing exactly one *** Update File operation."),
        returnResult: z.boolean().optional().describe("Whether to return local post-patch text. Defaults to true."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ patchHandle, path, patch, returnResult }) =>
      runRelayTool(async () => {
        const patchOptions = buildPatchOptions(returnResult);
        if (path) {
          return client.patchText(patchHandle, path, patch, patchOptions);
        }
        return client.patchText(patchHandle, patch, patchOptions);
      }),
  );

  server.registerTool(
    "open_edit_session",
    {
      title: "Open Obsidian Edit Session",
      description:
        "Open a live edit session for interactive work with a user in an Obsidian note.",
      inputSchema: {
        path: pathSchema,
        ttlSeconds: ttlSecondsSchema.optional().describe("Live edit session TTL in seconds. Defaults to 600."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, ttlSeconds }) =>
      runRelayTool(async () =>
        client.openEditSession(path, ttlSeconds ?? MCP_RELAY_DEFAULT_EDIT_SESSION_TTL_SECONDS),
      ),
  );

  server.registerTool(
    "close_edit_session",
    {
      title: "Close Obsidian Edit Session",
      description: "Close a live edit session and release its document connection and cursor state.",
      inputSchema: {
        sessionId: handleSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runRelayTool(async () => ({
        ok: true,
        closed: await client.closeEditSession(sessionId),
      })),
  );

  server.registerTool(
    "get_cursor_context",
    {
      title: "Get Cursor Context",
      description:
        "Returns context around this session's agent cursor, or around a matching Obsidian collaborator cursor. " +
        "If there is an active selection, also returns the selected text and exact range.\n" +
        "For your own cursor, leave userId and clientId undefined. To discover collaborator identities, call list_active_cursors, then use either id.\n\n" +
        "Use this when the user refers to \"here\" or \"this\" or the current selection and you want to inspect it before editing.",
      inputSchema: {
        sessionId: handleSchema,
        maxCharsBefore: nonNegativeIntegerSchema.optional(),
        maxCharsAfter: nonNegativeIntegerSchema.optional(),
        userId: z.string().min(1).optional().describe("Optional collaborator user id to inspect."),
        clientId: nonNegativeIntegerSchema.optional().describe("Optional collaborator client id to inspect."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId, maxCharsBefore, maxCharsAfter, userId, clientId }) =>
      runRelayTool(async () =>
        client.getCursorContext(sessionId, {
          ...(maxCharsBefore === undefined ? {} : { maxCharsBefore }),
          ...(maxCharsAfter === undefined ? {} : { maxCharsAfter }),
          ...(userId === undefined ? {} : { userId }),
          ...(clientId === undefined ? {} : { clientId }),
        }),
      ),
  );

  server.registerTool(
    "list_active_cursors",
    {
      title: "List Active Obsidian Cursors",
      description: "List active collaborator cursor and selection states visible in a live edit session, including userId and clientId for use in get_cursor_context.",
      inputSchema: {
        sessionId: handleSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runRelayTool(async () => ({
        ok: true,
        cursors: await client.listActiveCursors(sessionId),
      })),
  );

  server.registerTool(
    "search_text",
    {
      title: "Search Obsidian Markdown",
      description:
        'Search for exact text inside the document and return stable match ids with surrounding context.',
      inputSchema: {
        sessionId: handleSchema,
        query: z.string().min(1),
        maxResults: z.number().int().positive().max(50).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId, query, maxResults }) =>
      runRelayTool(async () => client.searchText(sessionId, query, maxResults)),
  );

  server.registerTool(
    "replace_matches",
    {
      title: "Replace Matches",
      description:
        'Replace multiple previously found exact matches with the same replacement text. Use this after search_text when the user wants the same exact text changed in several places, such as renaming a character throughout the document.',
      inputSchema: {
        matchIds: z.array(handleSchema).describe("Match ids returned by search_text."),
        text: z.string().describe("Text to replace all matches with."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ matchIds, text }) =>
      runRelayTool(async () => {
        return client.replaceMatches(matchIds, text);
      }),
  );

  server.registerTool(
    "place_cursor",
    {
      title: "Place Agent Cursor At Match",
      description:
        'Place the agent cursor at the start or end of a previously returned match id from search_text.',
      inputSchema: {
        matchId: handleSchema,
        edge: cursorEdgeSchema.optional().describe("Whether to place the cursor at the start or end of the match. Defaults to start."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ matchId, edge }) =>
      runRelayTool(async () => {
        return client.placeCursor(matchId, edge);
      }),
  );

  server.registerTool(
    "place_cursor_at_document_boundary",
    {
      title: "Place Agent Cursor At Document Boundary",
      description: 
        'Place the agent cursor at the very start or very end of the document. Use this for requests like adding a title at the top or appending exact text at the end.',
      inputSchema: {
        sessionId: handleSchema,
        boundary: cursorEdgeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId, boundary }) =>
      runRelayTool(async () => client.placeCursorAtDocumentBoundary(sessionId, boundary)),
  );

  server.registerTool(
    "select_text",
    {
      title: "Select Match Text",
      description: 'Select the exact text represented by a previously returned match id from search_text.',
      inputSchema: {
        matchId: handleSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ matchId }) =>
      runRelayTool(async () => {
        return client.selectText(matchId);
      }),
  );

  server.registerTool(
    "select_current_block",
    {
      title: "Select Current Markdown Block",
      description:
        'Select the full current text block around the cursor. Use this for formatting or rewriting the current line/paragraph when you already know the cursor is in the right block.',
      inputSchema: {
        sessionId: handleSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runRelayTool(async () => client.selectCurrentBlock(sessionId)),
  );

  server.registerTool(
    "select_between_matches",
    {
      title: "Select Between Matches",
      description:
        'Create a selection between two previously returned matches from search_text, choosing start/end edges for each.',
      inputSchema: {
        startMatchId: handleSchema,
        endMatchId: handleSchema,
        startEdge: cursorEdgeSchema.optional(),
        endEdge: cursorEdgeSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ startMatchId, endMatchId, startEdge, endEdge }) =>
      runRelayTool(async () => {
        return client.selectBetweenMatches(startMatchId, endMatchId, startEdge, endEdge);
      }),
  );

  server.registerTool(
    "clear_selection",
    {
      title: "Clear Agent Selection",
      description: 'Clear the current selection while keeping the current cursor target.',
      inputSchema: {
        sessionId: handleSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runRelayTool(async () => client.clearSelection(sessionId)),
  );

  server.registerTool(
    "insert_text",
    {
      title: "Insert Live Markdown Text",
      description:
        "Insert raw Markdown source at the agent cursor, replacing the current selection if any.",
      inputSchema: {
        sessionId: handleSchema,
        text: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, text }) =>
      runRelayTool(async () => client.insertText(sessionId, text)),
  );

  server.registerTool(
    "delete_selection",
    {
      title: "Delete Agent Selection",
      description: "Delete the current selected Markdown source range.",
      inputSchema: {
        sessionId: handleSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runRelayTool(async () => client.deleteSelection(sessionId)),
  );
}

const pathSchema = z.string().min(1).describe("Vault-relative path to an Obsidian note.");
const handleSchema = z.string().length(RELAY_HANDLE_LENGTH).regex(/^[0-9A-Za-z]+$/);
const ttlSecondsSchema = z.number().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const cursorEdgeSchema = z.enum(["start", "end"]);

function buildReadOptions(options: RelayReadTextOptions): RelayReadTextOptions | undefined {
  const definedOptions: RelayReadTextOptions = {
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.startChar === undefined ? {} : { startChar: options.startChar }),
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
  };
  return Object.keys(definedOptions).length > 0 ? definedOptions : undefined;
}

function buildPatchOptions(returnResult: boolean | undefined): RelayApplyPatchOptions {
  return returnResult === undefined ? {} : { returnResult };
}

async function runRelayTool(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await fn());
  } catch (error) {
    return jsonToolResult(
      {
        ok: false,
        reason: "toolError",
        message: errorMessage(error),
      },
      true,
    );
  }
}

function jsonToolResult(value: unknown, isError = false): CallToolResult {
  const structuredContent = toStructuredContent(value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
