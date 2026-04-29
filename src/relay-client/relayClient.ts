import * as Y from "yjs";
import { ClientToken, RelayAuthClient, RelayAuthClientOptions } from "./auth";
import { applyCodexUpdatePatch } from "./codexPatch";
import {
  DEFAULT_RELAY_API_URL,
  DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG,
  loadRelayClientFileConfig,
  RelayAttachmentContentConfig,
} from "./config";
import { LoadedTextDocument, RelayDocClient } from "./docClient";
import { RelayFileClient } from "./fileClient";
import { FolderEntry, FolderIndex, normalizeRelayPath, toS3Resource } from "./folderIndex";
import { LiveRelayProvider, LiveRelayProviderOptions } from "./liveProvider";
import {
  ActiveCursorInfo,
  CursorContextOptions,
  CursorContextResult,
  LiveEditSession,
  MatchToolResult,
  OpenEditSessionResult,
  SearchTextResult,
  SelectCurrentBlockResult,
} from "./liveSession";
import { S3RemoteFile, S3RemoteFolder } from "./s3rn";
import { patchText as applyTextPatch, replaceText, TextMutationResult } from "./textPatch";

export interface RelayClientConfig extends RelayAuthClientOptions {
  attachments?: RelayAttachmentContentConfig;
  relayId?: string;
  folderId?: string;
  liveProvider?: LiveRelayProviderOptions;
}

export const DEFAULT_HANDLE_TTL_SECONDS = 60;
export const RELAY_HANDLE_LENGTH = 5;
const EDIT_SESSION_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export interface RelayReadResult {
  patchHandle: string;
  /**
   * Deprecated compatibility alias for patchHandle.
   */
  handle: string;
  text: string;
  totalChars: number;
  startChar: number;
  endChar: number;
  truncated: boolean;
}

export interface RelayReadTextOptions {
  ttlSeconds?: number;
  startChar?: number;
  maxChars?: number;
}

export interface RelayApplyPatchOptions {
  returnResult?: boolean;
}

export interface RelayApplyPatchResult {
  changed: boolean;
  staleHandle: boolean;
  resultText?: string;
}

export type RelayListedFileKind = "markdown" | "canvas" | "attachment" | "folder";

export interface RelayListFilesOptions {
  query?: string;
  pathPrefix?: string;
  maxResults?: number;
  offset?: number;
}

export interface RelayListedFile {
  path: string;
  kind: RelayListedFileKind;
}

export interface RelayListFilesResult {
  ok: true;
  entries: RelayListedFile[];
  totalMatches: number;
  returnedCount: number;
  offset: number;
  nextOffset?: number;
}

export interface RelayReadAttachmentOptions {
  includeTextContent?: boolean;
  maxTextChars?: number;
  includeImageContent?: boolean;
  maxImageContentMB?: number;
  includeAudioContent?: boolean;
  maxAudioContentMB?: number;
}

export interface RelayReadAttachmentResult {
  ok: true;
  url: string;
  contentType?: string;
  contentLength?: number;
  expiresAt?: string;
  hash: string;
  contentLimitExceeded?: true;
  text?: string;
  dataBase64?: string;
}

type RelayReadArgs =
  | [string, (number | RelayReadTextOptions)?]
  | [string, string, string, (number | RelayReadTextOptions)?];
type RelayReadAttachmentArgs =
  | [string, RelayReadAttachmentOptions?]
  | [string, string, string, RelayReadAttachmentOptions?];
type RelayApplyPatchArgs = [string, string, RelayApplyPatchOptions?] | [string, string, string, RelayApplyPatchOptions?];
type RelayOpenEditSessionArgs =
  | [string, string, number?]
  | [string, string, string, string, number?];

export interface RelayWriteResult {
  relayId: string;
  folderId: string;
  path: string;
  entry: FolderEntry;
  clientToken: ClientToken;
  before: string;
  after: string;
  changed: boolean;
}

export class RelayClient {
  readonly auth: RelayAuthClient;
  readonly docClient: RelayDocClient;
  readonly fileClient: RelayFileClient;
  readonly attachmentContentConfig: Required<RelayAttachmentContentConfig>;
  readonly defaultRelayId?: string;
  readonly defaultFolderId?: string;
  private readonly liveProviderOptions: LiveRelayProviderOptions;
  private readonly handles = new Map<string, StoredHandle>();
  private readonly editSessions = new Map<string, StoredEditSession>();
  private readonly editSessionTombstones = new Map<string, EditSessionTombstone>();
  private nextIdNumber = 0;

  constructor(config: RelayClientConfig) {
    this.auth = new RelayAuthClient(config);
    this.docClient = new RelayDocClient({ fetch: config.fetch });
    this.fileClient = new RelayFileClient({ fetch: config.fetch });
    this.attachmentContentConfig = normalizeAttachmentContentConfig(config.attachments);
    this.defaultRelayId = config.relayId;
    this.defaultFolderId = config.folderId;
    this.liveProviderOptions = config.liveProvider ?? {};
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RelayClientConfig> = {}): RelayClient {
    const loaded = loadRelayClientFileConfig({
      configPath: overrides.configPath,
      env,
    });
    const fileConfig = loaded.config;
    const apiUrl = overrides.apiUrl ?? env.RELAY_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_RELAY_API_URL;
    const bearerToken =
      overrides.bearerToken ?? env.RELAY_BEARER_TOKEN ?? fileConfig?.bearerToken;

    if (!bearerToken) {
      throw new Error(
        `Missing Relay bearer token. Set RELAY_BEARER_TOKEN or run obsidian-relay-mcp login:github to populate ${loaded.path}`,
      );
    }

    return new RelayClient({
      ...overrides,
      apiUrl,
      authRecord: overrides.authRecord ?? fileConfig?.authRecord,
      authUrl: overrides.authUrl ?? env.RELAY_AUTH_URL ?? fileConfig?.authUrl,
      bearerToken,
      configPath: overrides.configPath ?? loaded.path,
      attachments: overrides.attachments ?? fileConfig?.attachments,
      relayId: overrides.relayId ?? env.RELAY_ID ?? fileConfig?.relayId,
      folderId: overrides.folderId ?? env.RELAY_FOLDER_ID ?? fileConfig?.folderId,
    });
  }

  async loadFolder(): Promise<FolderIndex>;
  async loadFolder(relayId: string, folderId: string): Promise<FolderIndex>;
  async loadFolder(relayId?: string, folderId?: string): Promise<FolderIndex> {
    const coordinates = this.resolveFolderCoordinates(relayId, folderId);
    const folderResource = toFolderResource(coordinates.relayId, coordinates.folderId);
    const folderToken = await this.auth.issueToken(folderResource);
    const loaded = await this.docClient.loadYDoc(folderToken);
    return FolderIndex.fromYDoc(coordinates.relayId, coordinates.folderId, loaded.ydoc);
  }

  resolvePath(folder: FolderIndex, notePath: string): FolderEntry | undefined {
    return folder.getByPath(notePath);
  }

  async listFiles(options: RelayListFilesOptions = {}): Promise<RelayListFilesResult> {
    const folder = await this.loadFolder();
    const query = options.query?.trim().toLocaleLowerCase();
    const pathPrefix = normalizeListPathPrefix(options.pathPrefix);
    const maxResults = parseListFilesMaxResults(options.maxResults);
    const offset = parseListFilesOffset(options.offset);

    const matches = folder
      .entries()
      .filter((entry) => matchesListPathPrefix(entry.path, pathPrefix))
      .filter((entry) => !query || entry.path.toLocaleLowerCase().includes(query))
      .map((entry) => ({
        path: entry.path,
        kind: listedFileKindFromEntry(entry),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    const entries = matches.slice(offset, offset + maxResults);
    const nextOffset = offset + entries.length < matches.length
      ? offset + entries.length
      : undefined;

    return {
      ok: true,
      entries,
      totalMatches: matches.length,
      returnedCount: entries.length,
      offset,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  }

  async readAttachment(
    path: string,
    options?: RelayReadAttachmentOptions,
  ): Promise<RelayReadAttachmentResult>;
  async readAttachment(
    relayId: string,
    folderId: string,
    path: string,
    options?: RelayReadAttachmentOptions,
  ): Promise<RelayReadAttachmentResult>;
  async readAttachment(...args: RelayReadAttachmentArgs): Promise<RelayReadAttachmentResult> {
    const { address, options } = this.parseReadAttachmentArgs(args);
    const folder = await this.loadFolder(address.relayId, address.folderId);
    const entry = folder.getByPath(address.path);
    if (!entry) {
      throw new Error(`Relay path not found: ${address.path}`);
    }
    if (entry.resourceKind !== "file") {
      throw new Error(`Relay path ${address.path} is a ${entry.type} resource, not an attachment`);
    }
    if (!entry.hash) {
      throw new Error(`Relay attachment ${address.path} is missing a content hash`);
    }

    const resource = toS3Resource(address.relayId, address.folderId, entry);
    if (!(resource instanceof S3RemoteFile)) {
      throw new Error(`Relay path ${address.path} is not a file resource`);
    }

    const requestedContentType = entry.mimetype ?? "application/octet-stream";
    const fileToken = await this.auth.issueFileToken(resource, entry.hash, requestedContentType, 0);
    const downloadUrl = await this.fileClient.getDownloadUrl(fileToken);
    const contentType = entry.mimetype ?? fileToken.contentType ?? requestedContentType;
    const includeKind = attachmentIncludeKind(entry.path, contentType, options);
    const maxIncludedBytes = includeKind === "image"
      ? megabytesToBytes(options.maxImageContentMB)
      : includeKind === "audio"
        ? megabytesToBytes(options.maxAudioContentMB)
        : undefined;
    const downloaded = includeKind === undefined
      ? undefined
      : await this.fileClient.downloadFileFromUrl(downloadUrl, {
          maxContentBytes: maxIncludedBytes,
        });
    const bytes = downloaded?.bytes;
    const textContent = includeKind === "text" && bytes
      ? decodeAttachmentText(bytes, options.maxTextChars)
      : undefined;
    const contentLimitExceeded = downloaded?.contentLimitExceeded === true
      || textContent?.contentLimitExceeded === true;

    return {
      ok: true,
      url: downloadUrl.downloadUrl,
      ...(contentType === undefined ? {} : { contentType }),
      ...(downloaded?.contentLength === undefined
        ? (bytes === undefined ? {} : { contentLength: bytes.byteLength })
        : { contentLength: downloaded.contentLength }),
      ...(downloadUrl.expiresAt === undefined ? {} : { expiresAt: downloadUrl.expiresAt }),
      hash: entry.hash,
      ...(contentLimitExceeded ? { contentLimitExceeded: true as const } : {}),
      ...(textContent === undefined ? {} : { text: textContent.text }),
      ...(bytes !== undefined && (includeKind === "image" || includeKind === "audio")
        ? { dataBase64: Buffer.from(bytes!).toString("base64") }
        : {}),
    };
  }

  async readText(path: string, options?: number | RelayReadTextOptions): Promise<RelayReadResult>;
  async readText(
    relayId: string,
    folderId: string,
    path: string,
    options?: number | RelayReadTextOptions,
  ): Promise<RelayReadResult>;
  async readText(...args: RelayReadArgs): Promise<RelayReadResult> {
    this.cleanupExpiredState();

    const { address, maxChars, startChar, ttlMs } = this.parseReadArgs(args);
    const loaded = await this.loadTextDocument(address);
    const patchHandle = this.issueId();
    const window = sliceTextWindow(loaded.text, startChar, maxChars);

    this.handles.set(patchHandle, {
      address,
      entry: loaded.entry,
      expiresAt: Date.now() + ttlMs,
      lock: new HandleLock(),
      stateUpdate: cloneUint8Array(Y.encodeStateAsUpdate(loaded.ydoc)),
      text: loaded.text,
      ttlMs,
    });

    return {
      patchHandle,
      handle: patchHandle,
      text: window.text,
      totalChars: loaded.text.length,
      startChar: window.startChar,
      endChar: window.endChar,
      truncated: window.truncated,
    };
  }

  async openEditSession(path: string, agentName: string, ttlSeconds?: number): Promise<OpenEditSessionResult>;
  async openEditSession(
    relayId: string,
    folderId: string,
    path: string,
    agentName: string,
    ttlSeconds?: number,
  ): Promise<OpenEditSessionResult>;
  async openEditSession(...args: RelayOpenEditSessionArgs): Promise<OpenEditSessionResult> {
    this.cleanupExpiredState();

    const { address, agentName, ttlMs } = this.parseOpenEditSessionArgs(args);
    const resolved = await this.resolveTextDocumentResource(address);
    const sessionId = this.issueId();
    const ydoc = new Y.Doc();
    const provider = new LiveRelayProvider(
      resolved.clientToken,
      ydoc,
      this.liveProviderOptions,
    );

    provider.connect();
    try {
      await provider.waitForSynced();
    } catch (error) {
      provider.destroy();
      ydoc.destroy();
      throw error;
    }

    const session = new LiveEditSession(
      sessionId,
      address,
      resolved.entry,
      resolved.clientToken,
      ydoc,
      provider,
      agentName,
      () => this.issueId(),
    );
    this.editSessions.set(sessionId, {
      expiresAt: Date.now() + ttlMs,
      lock: new HandleLock(),
      session,
      ttlMs,
    });
    return { sessionId };
  }

  async closeEditSession(sessionId: string): Promise<boolean> {
    const stored = this.editSessions.get(sessionId);
    if (!stored) {
      return false;
    }
    return stored.lock.runExclusive(async () => {
      const freshStored = this.editSessions.get(sessionId);
      if (!freshStored) {
        return false;
      }
      freshStored.session.destroy();
      this.editSessions.delete(sessionId);
      this.rememberEditSessionTombstone(sessionId, "closed");
      return true;
    });
  }

  async getCursorContext(
    sessionId: string,
    options: CursorContextOptions = {},
  ): Promise<CursorContextResult> {
    return this.withEditSession(sessionId, (session) => session.getCursorContext(options));
  }

  async listActiveCursors(sessionId: string): Promise<ActiveCursorInfo[]> {
    return this.withEditSession(sessionId, (session) => session.listActiveCursors());
  }

  async searchText(
    sessionId: string,
    query: string,
    maxResults?: number,
  ): Promise<SearchTextResult> {
    return this.withEditSession(sessionId, (session) => session.searchText(query, maxResults));
  }

  async replaceMatches(
    matchIds: string[],
    text: string,
  ): Promise<MatchToolResult<{ replacedCount: number; insertedChars: number }>>;
  async replaceMatches(
    sessionId: string,
    matchIds: string[],
    text: string,
  ): Promise<MatchToolResult<{ replacedCount: number; insertedChars: number }>>;
  async replaceMatches(
    arg1: string | string[],
    arg2: string[] | string,
    arg3?: string,
  ): Promise<MatchToolResult<{ replacedCount: number; insertedChars: number }>> {
    const sessionId = Array.isArray(arg1) ? this.inferSessionIdFromMatchIds(arg1) : arg1;
    const matchIds = Array.isArray(arg1) ? arg1 : arg2 as string[];
    const text = Array.isArray(arg1) ? arg2 as string : arg3;
    if (typeof text !== "string") {
      throw new Error("replaceMatches requires replacement text");
    }
    return this.withEditSession(sessionId, (session) => session.replaceMatches(matchIds, text));
  }

  async placeCursor(
    matchId: string,
    edge?: "start" | "end",
  ): Promise<MatchToolResult<{ position: number }>>;
  async placeCursor(
    sessionId: string,
    matchId: string,
    edge?: "start" | "end",
  ): Promise<MatchToolResult<{ position: number }>>;
  async placeCursor(
    arg1: string,
    arg2?: string | "start" | "end",
    arg3?: "start" | "end",
  ): Promise<MatchToolResult<{ position: number }>> {
    const parsed = parsePlaceCursorArgs(arg1, arg2, arg3);
    const resolvedSessionId = parsed.sessionId ?? this.inferSessionIdFromMatchIds([parsed.matchId]);
    return this.withEditSession(resolvedSessionId, (session) =>
      session.placeCursor(parsed.matchId, parsed.edge),
    );
  }

  async placeCursorAtDocumentBoundary(
    sessionId: string,
    boundary: "start" | "end",
  ): Promise<{ ok: true; position: number }> {
    return this.withEditSession(sessionId, (session) => session.placeCursorAtDocumentBoundary(boundary));
  }

  async selectText(
    matchId: string,
  ): Promise<MatchToolResult<{ selectedText: string; selectedFrom: number; selectedTo: number }>>;
  async selectText(
    sessionId: string,
    matchId: string,
  ): Promise<MatchToolResult<{ selectedText: string; selectedFrom: number; selectedTo: number }>>;
  async selectText(
    arg1: string,
    arg2?: string,
  ): Promise<MatchToolResult<{ selectedText: string; selectedFrom: number; selectedTo: number }>> {
    const sessionId = arg2 === undefined ? this.inferSessionIdFromMatchIds([arg1]) : arg1;
    const matchId = arg2 ?? arg1;
    return this.withEditSession(sessionId, (session) => session.selectText(matchId));
  }

  async selectCurrentBlock(
    sessionId: string,
  ): Promise<SelectCurrentBlockResult | Extract<CursorContextResult, { ok: false }>> {
    return this.withEditSession(sessionId, (session) => session.selectCurrentBlock());
  }

  async selectBetweenMatches(
    startMatchId: string,
    endMatchId: string,
    startEdge?: "start" | "end",
    endEdge?: "start" | "end",
  ): Promise<MatchToolResult<{
    selectedText: string;
    selectedFrom: number;
    selectedTo: number;
    selectionStartPreview: string;
    selectionEndPreview: string;
  }>>;
  async selectBetweenMatches(
    sessionId: string,
    startMatchId: string,
    endMatchId: string,
    startEdge?: "start" | "end",
    endEdge?: "start" | "end",
  ): Promise<MatchToolResult<{
    selectedText: string;
    selectedFrom: number;
    selectedTo: number;
    selectionStartPreview: string;
    selectionEndPreview: string;
  }>>;
  async selectBetweenMatches(
    arg1: string,
    arg2: string,
    arg3?: string | "start" | "end",
    arg4?: "start" | "end",
    arg5?: "start" | "end",
  ): Promise<MatchToolResult<{
    selectedText: string;
    selectedFrom: number;
    selectedTo: number;
    selectionStartPreview: string;
    selectionEndPreview: string;
  }>> {
    const parsed = parseSelectBetweenMatchesArgs(
      arg1,
      arg2,
      arg3,
      arg4,
      arg5,
    );
    const resolvedSessionId =
      parsed.sessionId ?? this.inferSessionIdFromMatchIds([parsed.startMatchId, parsed.endMatchId]);
    return this.withEditSession(resolvedSessionId, (session) =>
      session.selectBetweenMatches(
        parsed.startMatchId,
        parsed.endMatchId,
        parsed.startEdge,
        parsed.endEdge,
      ),
    );
  }

  async clearSelection(sessionId: string): Promise<{ ok: true; position: number }> {
    return this.withEditSession(sessionId, (session) => session.clearSelection());
  }

  async insertText(
    sessionId: string,
    text: string,
  ): Promise<MatchToolResult<{ insertedChars: number }>> {
    return this.withEditSession(sessionId, (session) => session.insertText(text));
  }

  async deleteSelection(
    sessionId: string,
  ): Promise<{ ok: true; numCharsDeleted: number } | Extract<CursorContextResult, { ok: false }>> {
    return this.withEditSession(sessionId, (session) => session.deleteSelection());
  }

  async writeText(path: string, nextText: string): Promise<RelayWriteResult>;
  async writeText(relayId: string, folderId: string, path: string, nextText: string): Promise<RelayWriteResult>;
  async writeText(
    ...args: [string, string] | [string, string, string, string]
  ): Promise<RelayWriteResult> {
    const { address, input } = this.parseWriteArgs(args);
    return this.mutateExistingDocument(address, input, "replace");
  }

  async applyPatch(handle: string, patch: string, options?: RelayApplyPatchOptions): Promise<RelayApplyPatchResult>;
  async applyPatch(
    handle: string,
    path: string,
    patch: string,
    options?: RelayApplyPatchOptions,
  ): Promise<RelayApplyPatchResult>;
  async applyPatch(...args: RelayApplyPatchArgs): Promise<RelayApplyPatchResult> {
    const { handle, options, patch, path } = this.parseApplyPatchArgs(args);
    const stored = this.getHandle(handle);

    return stored.lock.runExclusive(async () => {
      const freshStored = this.getHandle(handle);
      const workingDoc = new Y.Doc();
      Y.applyUpdate(workingDoc, freshStored.stateUpdate);
      const ytext = workingDoc.getText("contents");
      const currentText = ytext.toString();

      if (currentText !== freshStored.text) {
        throw new Error(`Stored handle text drifted for ${freshStored.address.path}`);
      }

      const applied = applyCodexUpdatePatch(currentText, patch);
      const patchPath = normalizeRelayPath(applied.path);
      if (patchPath !== freshStored.address.path) {
        throw new Error(
          `Patch path ${patchPath} does not match handle path ${freshStored.address.path}`,
        );
      }

      if (path) {
        const normalizedPath = normalizeRelayPath(path);
        if (normalizedPath !== patchPath) {
          throw new Error(
            `Patch path ${patchPath} does not match the explicit path argument ${normalizedPath}`,
          );
        }
      }

      const clientToken = await this.auth.issueToken(
        toS3Resource(freshStored.address.relayId, freshStored.address.folderId, freshStored.entry),
      );
      const staleHandle = await this.isHandleStale(workingDoc, clientToken);

      const beforeStateVector = Y.encodeStateVector(workingDoc);
      let mutation: TextMutationResult;
      workingDoc.transact(() => {
        mutation = applyTextPatch(ytext, applied.resultText);
      });

      if (mutation!.changed) {
        const delta = Y.encodeStateAsUpdate(workingDoc, beforeStateVector);
        if (delta.byteLength > 0) {
          await this.docClient.pushUpdate(clientToken, delta);
        }

        freshStored.stateUpdate = cloneUint8Array(Y.encodeStateAsUpdate(workingDoc));
        freshStored.text = applied.resultText;
      }

      freshStored.expiresAt = Date.now() + freshStored.ttlMs;

      return {
        changed: mutation!.changed,
        staleHandle,
        ...(options.returnResult === true ? { resultText: applied.resultText } : {}),
      };
    });
  }

  async patchText(handle: string, patch: string, options?: RelayApplyPatchOptions): Promise<RelayApplyPatchResult>;
  async patchText(
    handle: string,
    path: string,
    patch: string,
    options?: RelayApplyPatchOptions,
  ): Promise<RelayApplyPatchResult>;
  async patchText(...args: RelayApplyPatchArgs): Promise<RelayApplyPatchResult> {
    const parsed = this.parseApplyPatchArgs(args);
    if (parsed.path) {
      return this.applyPatch(parsed.handle, parsed.path, parsed.patch, parsed.options);
    }
    return this.applyPatch(parsed.handle, parsed.patch, parsed.options);
  }

  private async loadTextDocument(address: TextAddress): Promise<ResolvedTextDocument> {
    const resolved = await this.resolveTextDocumentResource(address);
    const loaded = await this.docClient.loadTextDocument(resolved.clientToken);
    return {
      ...loaded,
      address,
      entry: resolved.entry,
    };
  }

  private async resolveTextDocumentResource(address: TextAddress): Promise<ResolvedTextResource> {
    const folder = await this.loadFolder(address.relayId, address.folderId);
    const entry = folder.getByPath(address.path);
    if (!entry) {
      throw new Error(`Relay path not found: ${address.path}`);
    }
    if (entry.resourceKind !== "document") {
      throw new Error(
        `Relay path ${address.path} is a ${entry.type} resource, not a markdown document`,
      );
    }

    const clientToken = await this.auth.issueToken(toS3Resource(address.relayId, address.folderId, entry));
    return {
      address,
      entry,
      clientToken,
    };
  }

  private async mutateExistingDocument(
    address: TextAddress,
    nextText: string,
    mode: "patch" | "replace",
  ): Promise<RelayWriteResult> {
    const loaded = await this.loadTextDocument(address);

    const beforeStateVector = Y.encodeStateVector(loaded.ydoc);
    let mutation: TextMutationResult;
    loaded.ydoc.transact(() => {
      mutation = mode === "replace" ? replaceText(loaded.ytext, nextText) : applyTextPatch(loaded.ytext, nextText);
    });

    if (!mutation!.changed) {
      return {
        relayId: address.relayId,
        folderId: address.folderId,
        path: loaded.entry.path,
        entry: loaded.entry,
        clientToken: loaded.clientToken,
        before: mutation!.before,
        after: mutation!.after,
        changed: false,
      };
    }

    const delta = Y.encodeStateAsUpdate(loaded.ydoc, beforeStateVector);
    if (delta.byteLength > 0) {
      await this.docClient.pushUpdate(loaded.clientToken, delta);
    }

    return {
      relayId: address.relayId,
      folderId: address.folderId,
      path: loaded.entry.path,
      entry: loaded.entry,
      clientToken: loaded.clientToken,
      before: mutation!.before,
      after: mutation!.after,
      changed: mutation!.changed,
    };
  }

  private cleanupExpiredState(): void {
    const now = Date.now();
    for (const [handle, stored] of this.handles.entries()) {
      if (stored.expiresAt <= now && !stored.lock.locked) {
        this.handles.delete(handle);
      }
    }
    for (const [sessionId, stored] of this.editSessions.entries()) {
      if (stored.expiresAt <= now && !stored.lock.locked) {
        stored.session.destroy();
        this.editSessions.delete(sessionId);
        this.rememberEditSessionTombstone(sessionId, "expired");
      }
    }
    this.cleanupEditSessionTombstones(now);
  }

  private getHandle(handle: string): StoredHandle {
    const stored = this.handles.get(handle);
    if (!stored) {
      throw new Error(`Unknown Relay handle: ${handle}`);
    }
    if (stored.expiresAt <= Date.now()) {
      this.handles.delete(handle);
      throw new Error(`Relay handle expired: ${handle}`);
    }
    return stored;
  }

  private async isHandleStale(localDoc: Y.Doc, clientToken: ClientToken): Promise<boolean> {
    const remote = await this.docClient.loadYDoc(clientToken);
    return !buffersEqual(
      Y.encodeStateVector(localDoc),
      Y.encodeStateVector(remote.ydoc),
    );
  }

  private getEditSession(sessionId: string): StoredEditSession {
    const stored = this.editSessions.get(sessionId);
    if (!stored) {
      const tombstone = this.editSessionTombstones.get(sessionId);
      if (tombstone?.reason === "closed") {
        throw new Error(`Closed Relay edit session: ${sessionId}`);
      }
      if (tombstone?.reason === "expired") {
        throw new Error(`Expired Relay edit session: ${sessionId}`);
      }
      throw new Error(`Unknown Relay edit session: ${sessionId}`);
    }
    if (stored.expiresAt <= Date.now()) {
      stored.session.destroy();
      this.editSessions.delete(sessionId);
      this.rememberEditSessionTombstone(sessionId, "expired");
      throw new Error(`Expired Relay edit session: ${sessionId}`);
    }
    return stored;
  }

  private rememberEditSessionTombstone(sessionId: string, reason: EditSessionTombstoneReason): void {
    this.editSessionTombstones.set(sessionId, {
      reason,
      forgetAt: Date.now() + EDIT_SESSION_TOMBSTONE_TTL_MS,
    });
  }

  private cleanupEditSessionTombstones(now: number): void {
    for (const [sessionId, tombstone] of this.editSessionTombstones.entries()) {
      if (tombstone.forgetAt <= now) {
        this.editSessionTombstones.delete(sessionId);
      }
    }
  }

  private async withEditSession<T>(
    sessionId: string,
    fn: (session: LiveEditSession) => T | Promise<T>,
  ): Promise<T> {
    this.cleanupExpiredState();
    const stored = this.getEditSession(sessionId);
    return stored.lock.runExclusive(async () => {
      const freshStored = this.getEditSession(sessionId);
      const result = await fn(freshStored.session);
      freshStored.expiresAt = Date.now() + freshStored.ttlMs;
      return result;
    });
  }

  private inferSessionIdFromMatchIds(matchIds: string[]): string {
    if (matchIds.length === 0) {
      throw new Error("Cannot infer Relay edit session from an empty match id list");
    }

    this.cleanupExpiredState();
    const matchingSessionIds = new Set<string>();
    for (const matchId of matchIds) {
      for (const [sessionId, stored] of this.editSessions.entries()) {
        if (stored.session.matches.has(matchId)) {
          matchingSessionIds.add(sessionId);
        }
      }
    }

    if (matchingSessionIds.size === 0) {
      throw new Error(`Could not infer Relay edit session for match id ${matchIds[0]}`);
    }
    if (matchingSessionIds.size > 1) {
      throw new Error("Match ids refer to multiple Relay edit sessions; pass sessionId explicitly");
    }
    return [...matchingSessionIds][0]!;
  }

  private issueId(): string {
    if (this.nextIdNumber >= MAX_RELAY_HANDLE_COUNT) {
      throw new Error(
        `Relay handle space exhausted after issuing ${MAX_RELAY_HANDLE_COUNT} handles in this process`,
      );
    }

    const handle = encodeRelayHandle(this.nextIdNumber);
    this.nextIdNumber += 1;
    return handle;
  }

  private resolveFolderCoordinates(relayId?: string, folderId?: string): FolderCoordinates {
    const resolvedRelayId = relayId ?? this.defaultRelayId;
    const resolvedFolderId = folderId ?? this.defaultFolderId;

    if (!resolvedRelayId || !resolvedFolderId) {
      throw new Error(
        "RelayClient needs relayId and folderId either in the method call or as RELAY_ID / RELAY_FOLDER_ID defaults",
      );
    }

    return {
      relayId: resolvedRelayId,
      folderId: resolvedFolderId,
    };
  }

  private parseReadArgs(
    args: RelayReadArgs,
  ): { address: TextAddress; ttlMs: number; startChar?: number; maxChars?: number } {
    if (args.length === 1 || args.length === 2) {
      const coordinates = this.resolveFolderCoordinates();
      const options = parseReadOptions(args[1]);
      return {
        address: {
          ...coordinates,
          path: normalizeRelayPath(args[0]),
        },
        ...options,
      };
    }

    const [relayId, folderId, rawPath, rawOptions] = args as [
      string,
      string,
      string,
      (number | RelayReadTextOptions)?,
    ];
    const options = parseReadOptions(rawOptions);
    return {
      address: {
        relayId,
        folderId,
        path: normalizeRelayPath(rawPath),
      },
      ...options,
    };
  }

  private parseReadAttachmentArgs(
    args: RelayReadAttachmentArgs,
  ): { address: TextAddress; options: RelayReadAttachmentOptions } {
    if (args.length === 1 || args.length === 2) {
      const coordinates = this.resolveFolderCoordinates();
      return {
        address: {
          ...coordinates,
          path: normalizeRelayPath(args[0]),
        },
        options: parseReadAttachmentOptions(args[1]),
      };
    }

    const [relayId, folderId, rawPath, rawOptions] = args as [
      string,
      string,
      string,
      RelayReadAttachmentOptions?,
    ];
    return {
      address: {
        relayId,
        folderId,
        path: normalizeRelayPath(rawPath),
      },
      options: parseReadAttachmentOptions(rawOptions),
    };
  }

  private parseOpenEditSessionArgs(
    args: RelayOpenEditSessionArgs,
  ): { address: TextAddress; agentName: string; ttlMs: number } {
    if (args.length === 2 || (args.length === 3 && (typeof args[2] === "number" || args[2] === undefined))) {
      const coordinates = this.resolveFolderCoordinates();
      return {
        address: {
          ...coordinates,
          path: normalizeRelayPath(args[0]),
        },
        agentName: parseAgentName(args[1]),
        ttlMs: parseTtlSeconds(args[2]),
      };
    }

    if (args.length !== 4 && args.length !== 5) {
      throw new Error(
        "openEditSession requires agentName: use openEditSession(path, agentName, ttlSeconds?)",
      );
    }

    const [relayId, folderId, rawPath, rawAgentName, ttlSeconds] = args as [string, string, string, string, number?];
    return {
      address: {
        relayId,
        folderId,
        path: normalizeRelayPath(rawPath),
      },
      agentName: parseAgentName(rawAgentName),
      ttlMs: parseTtlSeconds(ttlSeconds),
    };
  }

  private parseWriteArgs(args: [string, string] | [string, string, string, string]): {
    address: TextAddress;
    input: string;
  } {
    if (args.length === 2) {
      return {
        address: this.parseReadArgs([args[0]]).address,
        input: args[1],
      };
    }

    return {
      address: this.parseReadArgs([args[0], args[1], args[2]]).address,
      input: args[3],
    };
  }

  private parseApplyPatchArgs(
    args:
      | RelayApplyPatchArgs,
  ): {
    handle: string;
    options: RelayApplyPatchOptions;
    patch: string;
    path?: string;
  } {
    if (args.length >= 3 && typeof args[2] === "string") {
      return {
        handle: args[0],
        path: args[1],
        patch: args[2],
        options: args[3] ?? {},
      };
    }

    return {
      handle: args[0],
      patch: args[1],
      options: (args[2] as RelayApplyPatchOptions | undefined) ?? {},
    };
  }
}

interface FolderCoordinates {
  relayId: string;
  folderId: string;
}

interface TextAddress extends FolderCoordinates {
  path: string;
}

interface ResolvedTextDocument extends LoadedTextDocument {
  address: TextAddress;
  entry: FolderEntry;
}

interface ResolvedTextResource {
  address: TextAddress;
  entry: FolderEntry;
  clientToken: ClientToken;
}

interface StoredHandle {
  address: TextAddress;
  entry: FolderEntry;
  expiresAt: number;
  lock: HandleLock;
  stateUpdate: Uint8Array;
  text: string;
  ttlMs: number;
}

interface StoredEditSession {
  expiresAt: number;
  lock: HandleLock;
  session: LiveEditSession;
  ttlMs: number;
}

type EditSessionTombstoneReason = "closed" | "expired";

interface EditSessionTombstone {
  forgetAt: number;
  reason: EditSessionTombstoneReason;
}

function toFolderResource(relayId: string, folderId: string) {
  return new S3RemoteFolder(relayId, folderId);
}

class HandleLock {
  private tail = Promise.resolve();
  locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.locked = true;

    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }
}

function parseTtlSeconds(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) {
    return DEFAULT_HANDLE_TTL_SECONDS * 1000;
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Expected a positive TTL in seconds, received ${ttlSeconds}`);
  }
  return ttlSeconds * 1000;
}

function parseAgentName(agentName: unknown): string {
  if (typeof agentName !== "string") {
    throw new Error("Expected a non-empty agentName");
  }
  const trimmed = agentName.trim();
  if (!trimmed) {
    throw new Error("Expected a non-empty agentName");
  }
  if (trimmed.length > 100) {
    throw new Error("Expected agentName to be at most 100 characters");
  }
  return trimmed;
}

function parseReadOptions(rawOptions: number | RelayReadTextOptions | undefined): {
  ttlMs: number;
  startChar?: number;
  maxChars?: number;
} {
  if (typeof rawOptions === "number" || rawOptions === undefined) {
    return {
      ttlMs: parseTtlSeconds(rawOptions),
    };
  }

  assertNoDeprecatedTtlMs(rawOptions);

  return {
    ttlMs: parseTtlSeconds(rawOptions.ttlSeconds),
    ...(rawOptions.startChar === undefined ? {} : { startChar: rawOptions.startChar }),
    ...(rawOptions.maxChars === undefined ? {} : { maxChars: rawOptions.maxChars }),
  };
}

function assertNoDeprecatedTtlMs(rawOptions: RelayReadTextOptions): void {
  if ("ttlMs" in rawOptions) {
    throw new Error("ttlMs was renamed to ttlSeconds; pass TTL values in seconds");
  }
}

function parseReadAttachmentOptions(
  rawOptions: RelayReadAttachmentOptions | undefined,
): RelayReadAttachmentOptions {
  return {
    ...parseOptionalBooleanOption("includeTextContent", rawOptions?.includeTextContent),
    ...parseOptionalPositiveIntegerOption("maxTextChars", rawOptions?.maxTextChars),
    ...parseOptionalBooleanOption("includeImageContent", rawOptions?.includeImageContent),
    ...parseOptionalPositiveNumberOption("maxImageContentMB", rawOptions?.maxImageContentMB),
    ...parseOptionalBooleanOption("includeAudioContent", rawOptions?.includeAudioContent),
    ...parseOptionalPositiveNumberOption("maxAudioContentMB", rawOptions?.maxAudioContentMB),
  };
}

function parseOptionalBooleanOption(
  field: string,
  value: boolean | undefined,
): Record<string, boolean> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected a boolean ${field} value, received ${String(value)}`);
  }
  return { [field]: value };
}

function parseOptionalPositiveIntegerOption(
  field: string,
  value: number | undefined,
): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive ${field} value, received ${value}`);
  }
  return { [field]: value };
}

function parseOptionalPositiveNumberOption(
  field: string,
  value: number | undefined,
): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive ${field} value, received ${value}`);
  }
  return { [field]: value };
}

type CursorEdge = "start" | "end";

function parsePlaceCursorArgs(
  arg1: string,
  arg2?: string | CursorEdge,
  arg3?: CursorEdge,
): { sessionId?: string; matchId: string; edge?: CursorEdge } {
  if (arg2 === undefined || isCursorEdge(arg2)) {
    return {
      matchId: arg1,
      edge: arg2,
    };
  }
  return {
    sessionId: arg1,
    matchId: arg2,
    edge: arg3,
  };
}

function parseSelectBetweenMatchesArgs(
  arg1: string,
  arg2: string,
  arg3?: string | CursorEdge,
  arg4?: CursorEdge,
  arg5?: CursorEdge,
): {
  sessionId?: string;
  startMatchId: string;
  endMatchId: string;
  startEdge?: CursorEdge;
  endEdge?: CursorEdge;
} {
  if (arg3 === undefined || isCursorEdge(arg3)) {
    return {
      startMatchId: arg1,
      endMatchId: arg2,
      startEdge: arg3,
      endEdge: arg4,
    };
  }
  return {
    sessionId: arg1,
    startMatchId: arg2,
    endMatchId: arg3,
    startEdge: arg4,
    endEdge: arg5,
  };
}

function isCursorEdge(value: string): value is CursorEdge {
  return value === "start" || value === "end";
}

function sliceTextWindow(
  text: string,
  rawStartChar: number | undefined,
  rawMaxChars: number | undefined,
): { text: string; startChar: number; endChar: number; truncated: boolean } {
  const startChar = clampTextWindowPosition(rawStartChar ?? 0, text.length);
  const maxChars =
    rawMaxChars === undefined
      ? text.length - startChar
      : Math.max(0, Math.trunc(rawMaxChars));
  const endChar = Math.min(text.length, startChar + maxChars);
  return {
    text: text.slice(startChar, endChar),
    startChar,
    endChar,
    truncated: startChar > 0 || endChar < text.length,
  };
}

function clampTextWindowPosition(position: number, length: number): number {
  if (!Number.isFinite(position)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.trunc(position), length));
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function cloneUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function normalizeListPathPrefix(pathPrefix: string | undefined): string | undefined {
  if (pathPrefix === undefined) {
    return undefined;
  }
  return normalizeRelayPath(pathPrefix).replace(/\/+$/, "");
}

function matchesListPathPrefix(path: string, pathPrefix: string | undefined): boolean {
  if (!pathPrefix) {
    return true;
  }
  return path === pathPrefix || path.startsWith(`${pathPrefix}/`);
}

function parseListFilesMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) {
    return DEFAULT_LIST_FILES_MAX_RESULTS;
  }
  if (!Number.isFinite(maxResults) || maxResults <= 0) {
    throw new Error(`Expected a positive maxResults value, received ${maxResults}`);
  }
  return Math.min(Math.trunc(maxResults), MAX_LIST_FILES_MAX_RESULTS);
}

function parseListFilesOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`Expected a non-negative offset value, received ${offset}`);
  }
  return Math.trunc(offset);
}

function listedFileKindFromEntry(entry: FolderEntry): RelayListedFileKind {
  if (entry.resourceKind === "folder") {
    return "folder";
  }
  if (entry.resourceKind === "canvas") {
    return "canvas";
  }
  if (entry.resourceKind === "document") {
    return "markdown";
  }
  return "attachment";
}

type AttachmentIncludeKind = "text" | "image" | "audio";

function attachmentIncludeKind(
  filePath: string,
  contentType: string | undefined,
  options: RelayReadAttachmentOptions,
): AttachmentIncludeKind | undefined {
  if (options.includeTextContent !== false && isTextAttachment(filePath, contentType)) {
    return "text";
  }
  if (options.includeImageContent === true && contentType?.toLocaleLowerCase().startsWith("image/")) {
    return "image";
  }
  if (options.includeAudioContent === true && contentType?.toLocaleLowerCase().startsWith("audio/")) {
    return "audio";
  }
  return undefined;
}

function isTextAttachment(filePath: string, contentType: string | undefined): boolean {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLocaleLowerCase();
  if (normalizedContentType?.startsWith("text/")) {
    return true;
  }
  if (
    normalizedContentType &&
    TEXT_ATTACHMENT_MIME_TYPES.has(normalizedContentType)
  ) {
    return true;
  }
  const extension = filePath.split(".").pop()?.toLocaleLowerCase();
  return extension !== undefined && TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

function decodeAttachmentText(
  bytes: Uint8Array,
  maxTextChars: number | undefined,
): { text: string; contentLimitExceeded?: true } {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (maxTextChars === undefined || decoded.length <= maxTextChars) {
    return { text: decoded };
  }
  return {
    text: decoded.slice(0, maxTextChars),
    contentLimitExceeded: true,
  };
}

function megabytesToBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.floor(value * 1024 * 1024);
}

function normalizeAttachmentContentConfig(
  config: RelayAttachmentContentConfig | undefined,
): Required<RelayAttachmentContentConfig> {
  return {
    includeTextContent: config?.includeTextContent ?? DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.includeTextContent,
    includeImageContent: config?.includeImageContent ?? DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.includeImageContent,
    includeAudioContent: config?.includeAudioContent ?? DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.includeAudioContent,
    maxTextChars: normalizePositiveInteger(
      config?.maxTextChars,
      DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.maxTextChars,
    ),
    maxImageContentMB: normalizePositiveNumber(
      config?.maxImageContentMB,
      DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.maxImageContentMB,
    ),
    maxAudioContentMB: normalizePositiveNumber(
      config?.maxAudioContentMB,
      DEFAULT_RELAY_ATTACHMENT_CONTENT_CONFIG.maxAudioContentMB,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer attachment config value, received ${value}`);
  }
  return value;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive attachment config value, received ${value}`);
  }
  return value;
}

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/typescript",
  "application/x-ndjson",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
]);

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "cjs",
  "conf",
  "csv",
  "css",
  "html",
  "ini",
  "js",
  "json",
  "jsonl",
  "log",
  "md",
  "mjs",
  "svg",
  "toml",
  "ts",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const DEFAULT_LIST_FILES_MAX_RESULTS = 50;
const MAX_LIST_FILES_MAX_RESULTS = 200;
const RELAY_HANDLE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RELAY_HANDLE_RADIX = RELAY_HANDLE_ALPHABET.length;
const MAX_RELAY_HANDLE_COUNT = RELAY_HANDLE_RADIX ** RELAY_HANDLE_LENGTH;

function encodeRelayHandle(value: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < RELAY_HANDLE_LENGTH; index += 1) {
    const digit = remaining % RELAY_HANDLE_RADIX;
    encoded = RELAY_HANDLE_ALPHABET[digit] + encoded;
    remaining = Math.floor(remaining / RELAY_HANDLE_RADIX);
  }

  return encoded;
}
