import * as path from "node:path";
import * as Y from "yjs";
import { S3RNType, S3RemoteCanvas, S3RemoteDocument, S3RemoteFile, S3RemoteFolder } from "./s3rn";

export type RelayMetaType =
  | "folder"
  | "markdown"
  | "document"
  | "canvas"
  | "file"
  | "image"
  | "pdf"
  | "audio"
  | "video";

export type RelayResourceKind = "folder" | "document" | "canvas" | "file";

export interface FolderEntryMeta {
  id: string;
  type: RelayMetaType;
  version?: number;
  hash?: string;
  mimetype?: string;
  synctime?: number;
  [key: string]: unknown;
}

export interface FolderEntry {
  id: string;
  path: string;
  type: RelayMetaType;
  resourceKind: RelayResourceKind;
  version?: number;
  hash?: string;
  mimetype?: string;
  synctime?: number;
  raw: FolderEntryMeta;
}

export class FolderIndex {
  private readonly byPath = new Map<string, FolderEntry>();
  private readonly byId = new Map<string, FolderEntry>();

  constructor(
    public readonly relayId: string,
    public readonly folderId: string,
    entries: Iterable<FolderEntry>,
  ) {
    for (const entry of entries) {
      this.byPath.set(entry.path, entry);
      this.byId.set(entry.id, entry);
    }
  }

  static fromYDoc(relayId: string, folderId: string, ydoc: Y.Doc): FolderIndex {
    const filemeta = ydoc.getMap<unknown>("filemeta_v0");
    const entries: FolderEntry[] = [];

    for (const [rawPath, rawMeta] of filemeta.entries()) {
      const normalizedPath = normalizeRelayPath(rawPath);
      const meta = parseFolderEntryMeta(rawMeta, normalizedPath);
      entries.push({
        id: meta.id,
        path: normalizedPath,
        type: meta.type,
        resourceKind: resourceKindFromMetaType(meta.type),
        version: meta.version,
        hash: meta.hash,
        mimetype: meta.mimetype,
        synctime: meta.synctime,
        raw: meta,
      });
    }

    return new FolderIndex(relayId, folderId, entries);
  }

  entries(): FolderEntry[] {
    return [...this.byPath.values()];
  }

  getByPath(filePath: string): FolderEntry | undefined {
    return this.byPath.get(normalizeRelayPath(filePath));
  }

  getById(resourceId: string): FolderEntry | undefined {
    return this.byId.get(resourceId);
  }
}

export function normalizeRelayPath(filePath: string): string {
  if (!filePath) {
    throw new Error("Expected a non-empty Relay path");
  }

  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === ".") {
    throw new Error(`Invalid Relay path: ${filePath}`);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Relay path escapes the folder root: ${filePath}`);
  }
  return normalized;
}

export function resourceKindFromMetaType(metaType: string): RelayResourceKind {
  if (metaType === "folder") {
    return "folder";
  }
  if (metaType === "markdown" || metaType === "document") {
    return "document";
  }
  if (metaType === "canvas") {
    return "canvas";
  }
  return "file";
}

export function toS3Resource(relayId: string, folderId: string, entry: FolderEntry): S3RNType {
  if (entry.resourceKind === "folder") {
    throw new Error(
      `Path ${entry.path} is folder metadata inside ${folderId}, not a standalone Relay document resource`,
    );
  }
  if (entry.resourceKind === "document") {
    return new S3RemoteDocument(relayId, folderId, entry.id);
  }
  if (entry.resourceKind === "canvas") {
    return new S3RemoteCanvas(relayId, folderId, entry.id);
  }
  return new S3RemoteFile(relayId, folderId, entry.id);
}

function parseFolderEntryMeta(rawMeta: unknown, contextPath: string): FolderEntryMeta {
  const plain = toPlainValue(rawMeta);
  if (!isRecord(plain)) {
    throw new Error(`Invalid filemeta_v0 entry for ${contextPath}: expected an object`);
  }

  const id = plain.id;
  const type = plain.type;
  if (typeof id !== "string" || typeof type !== "string") {
    throw new Error(`Invalid filemeta_v0 entry for ${contextPath}: missing id or type`);
  }

  return {
    ...plain,
    id,
    type: type as RelayMetaType,
    ...(typeof plain.version === "number" ? { version: plain.version } : {}),
    ...(typeof plain.hash === "string" ? { hash: plain.hash } : {}),
    ...(typeof plain.mimetype === "string" ? { mimetype: plain.mimetype } : {}),
    ...(typeof plain.synctime === "number" ? { synctime: plain.synctime } : {}),
  };
}

function toPlainValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, nestedValue]) => [key, toPlainValue(nestedValue)]),
    );
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((item) => toPlainValue(item));
  }
  if (value instanceof Y.Text) {
    return value.toString();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
