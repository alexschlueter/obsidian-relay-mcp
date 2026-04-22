import * as Y from "yjs";
import { ClientToken, RelayAuthClient, RelayAuthClientOptions } from "./auth";
import { DEFAULT_RELAY_API_URL, loadRelayCoreFileConfig } from "./config";
import { LoadedTextDocument, RelayDocClient } from "./docClient";
import { FolderEntry, FolderIndex, normalizeRelayPath, toS3Resource } from "./folderIndex";
import { S3RemoteFolder } from "./s3rn";
import { patchText, replaceText, TextMutationResult } from "./textPatch";

export interface RelayCoreConfig extends RelayAuthClientOptions {
  relayId?: string;
  folderId?: string;
}

export type TextTransform = (currentText: string) => string | Promise<string>;

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

export class RelayCore {
  readonly auth: RelayAuthClient;
  readonly docClient: RelayDocClient;
  readonly defaultRelayId?: string;
  readonly defaultFolderId?: string;

  constructor(config: RelayCoreConfig) {
    this.auth = new RelayAuthClient(config);
    this.docClient = new RelayDocClient({ fetch: config.fetch });
    this.defaultRelayId = config.relayId;
    this.defaultFolderId = config.folderId;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RelayCoreConfig> = {}): RelayCore {
    const loaded = loadRelayCoreFileConfig({
      configPath: overrides.configPath,
      env,
    });
    const fileConfig = loaded.config;
    const apiUrl = overrides.apiUrl ?? env.RELAY_API_URL ?? fileConfig?.apiUrl ?? DEFAULT_RELAY_API_URL;
    const bearerToken =
      overrides.bearerToken ?? env.RELAY_BEARER_TOKEN ?? fileConfig?.bearerToken;

    if (!bearerToken) {
      throw new Error(
        `Missing Relay bearer token. Set RELAY_BEARER_TOKEN or run pnpm login:github to populate ${loaded.path}`,
      );
    }

    return new RelayCore({
      ...overrides,
      apiUrl,
      authRecord: overrides.authRecord ?? fileConfig?.authRecord,
      authUrl: overrides.authUrl ?? env.RELAY_AUTH_URL ?? fileConfig?.authUrl,
      bearerToken,
      configPath: overrides.configPath ?? loaded.path,
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

  async readText(path: string): Promise<string>;
  async readText(relayId: string, folderId: string, path: string): Promise<string>;
  async readText(...args: [string] | [string, string, string]): Promise<string> {
    const loaded = await this.loadTextDocument(...args);
    return loaded.text;
  }

  async writeText(path: string, nextText: string): Promise<RelayWriteResult>;
  async writeText(relayId: string, folderId: string, path: string, nextText: string): Promise<RelayWriteResult>;
  async writeText(
    ...args: [string, string] | [string, string, string, string]
  ): Promise<RelayWriteResult> {
    const { address, input } = this.parseWriteArgs(args);
    return this.mutateExistingDocument(address, () => input, "replace");
  }

  async patchText(path: string, transform: TextTransform): Promise<RelayWriteResult>;
  async patchText(
    relayId: string,
    folderId: string,
    path: string,
    transform: TextTransform,
  ): Promise<RelayWriteResult>;
  async patchText(
    ...args: [string, TextTransform] | [string, string, string, TextTransform]
  ): Promise<RelayWriteResult> {
    const { address, transform } = this.parsePatchArgs(args);
    return this.mutateExistingDocument(address, transform, "patch");
  }

  private async loadTextDocument(...args: [string] | [string, string, string]): Promise<LoadedTextDocument> {
    const address = this.parseReadArgs(args);
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
    return this.docClient.loadTextDocument(clientToken);
  }

  private async mutateExistingDocument(
    address: TextAddress,
    transform: TextTransform,
    mode: "patch" | "replace",
  ): Promise<RelayWriteResult> {
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
    const loaded = await this.docClient.loadTextDocument(clientToken);
    const nextText = await transform(loaded.text);
    if (typeof nextText !== "string") {
      throw new Error("Text transforms must return a string");
    }

    const beforeStateVector = Y.encodeStateVector(loaded.ydoc);
    let mutation: TextMutationResult;
    loaded.ydoc.transact(() => {
      mutation = mode === "replace" ? replaceText(loaded.ytext, nextText) : patchText(loaded.ytext, nextText);
    });

    if (!mutation!.changed) {
      return {
        relayId: address.relayId,
        folderId: address.folderId,
        path: entry.path,
        entry,
        clientToken,
        before: mutation!.before,
        after: mutation!.after,
        changed: false,
      };
    }

    const delta = Y.encodeStateAsUpdate(loaded.ydoc, beforeStateVector);
    if (delta.byteLength > 0) {
      await this.docClient.pushUpdate(clientToken, delta);
    }

    return {
      relayId: address.relayId,
      folderId: address.folderId,
      path: entry.path,
      entry,
      clientToken,
      before: mutation!.before,
      after: mutation!.after,
      changed: mutation!.changed,
    };
  }

  private resolveFolderCoordinates(relayId?: string, folderId?: string): FolderCoordinates {
    const resolvedRelayId = relayId ?? this.defaultRelayId;
    const resolvedFolderId = folderId ?? this.defaultFolderId;

    if (!resolvedRelayId || !resolvedFolderId) {
      throw new Error(
        "RelayCore needs relayId and folderId either in the method call or as RELAY_ID / RELAY_FOLDER_ID defaults",
      );
    }

    return {
      relayId: resolvedRelayId,
      folderId: resolvedFolderId,
    };
  }

  private parseReadArgs(args: [string] | [string, string, string]): TextAddress {
    if (args.length === 1) {
      const coordinates = this.resolveFolderCoordinates();
      return {
        ...coordinates,
        path: normalizeRelayPath(args[0]),
      };
    }

    const [relayId, folderId, rawPath] = args;
    return {
      relayId,
      folderId,
      path: normalizeRelayPath(rawPath),
    };
  }

  private parseWriteArgs(args: [string, string] | [string, string, string, string]): {
    address: TextAddress;
    input: string;
  } {
    if (args.length === 2) {
      return {
        address: this.parseReadArgs([args[0]]),
        input: args[1],
      };
    }

    return {
      address: this.parseReadArgs([args[0], args[1], args[2]]),
      input: args[3],
    };
  }

  private parsePatchArgs(
    args: [string, TextTransform] | [string, string, string, TextTransform],
  ): {
    address: TextAddress;
    transform: TextTransform;
  } {
    if (args.length === 2) {
      return {
        address: this.parseReadArgs([args[0]]),
        transform: args[1],
      };
    }

    return {
      address: this.parseReadArgs([args[0], args[1], args[2]]),
      transform: args[3],
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

function toFolderResource(relayId: string, folderId: string) {
  return new S3RemoteFolder(relayId, folderId);
}
