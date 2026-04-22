export type UUID = string;

abstract class RelayResourceBase {
  readonly platform = "s3rn";
  readonly product = "relay";
}

export class S3RemoteFolder extends RelayResourceBase {
  constructor(
    public readonly relayId: UUID,
    public readonly folderId: UUID,
  ) {
    super();
  }
}

export class S3RemoteDocument extends RelayResourceBase {
  constructor(
    public readonly relayId: UUID,
    public readonly folderId: UUID,
    public readonly documentId: UUID,
  ) {
    super();
  }
}

export class S3RemoteCanvas extends RelayResourceBase {
  constructor(
    public readonly relayId: UUID,
    public readonly folderId: UUID,
    public readonly canvasId: UUID,
  ) {
    super();
  }
}

export class S3RemoteFile extends RelayResourceBase {
  constructor(
    public readonly relayId: UUID,
    public readonly folderId: UUID,
    public readonly fileId: UUID,
  ) {
    super();
  }
}

export type S3RNType =
  | S3RemoteFolder
  | S3RemoteDocument
  | S3RemoteCanvas
  | S3RemoteFile;

type ResourceKind = "folder" | "doc" | "canvas" | "file";

export class S3RN {
  private static readonly uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  static validateUUID(uuid: UUID): boolean {
    return this.uuidPattern.test(uuid);
  }

  static encode(entity: S3RNType): string {
    const pieces = [
      entity.platform,
      entity.product,
      "relay",
      entity.relayId,
      "folder",
      entity.folderId,
    ];

    this.assertUuid(entity.relayId, "relay");
    this.assertUuid(entity.folderId, "folder");

    if (entity instanceof S3RemoteDocument) {
      this.assertUuid(entity.documentId, "document");
      pieces.push("doc", entity.documentId);
    } else if (entity instanceof S3RemoteCanvas) {
      this.assertUuid(entity.canvasId, "canvas");
      pieces.push("canvas", entity.canvasId);
    } else if (entity instanceof S3RemoteFile) {
      this.assertUuid(entity.fileId, "file");
      pieces.push("file", entity.fileId);
    }

    return pieces.join(":");
  }

  static decode(value: string): S3RNType {
    const parts = value.split(":");
    if (parts.length < 6 || parts[0] !== "s3rn" || parts[1] !== "relay") {
      throw new Error(`Invalid S3RN: ${value}`);
    }

    const pairs = new Map<string, string>();
    for (let index = 2; index < parts.length; index += 2) {
      const key = parts[index];
      const pairValue = parts[index + 1];
      if (!key || !pairValue) {
        throw new Error(`Invalid S3RN segment in ${value}`);
      }
      pairs.set(key, pairValue);
    }

    const relayId = this.requireUuid(pairs.get("relay"), "relay");
    const folderId = this.requireUuid(pairs.get("folder"), "folder");

    if (pairs.has("doc")) {
      return new S3RemoteDocument(
        relayId,
        folderId,
        this.requireUuid(pairs.get("doc"), "document"),
      );
    }
    if (pairs.has("canvas")) {
      return new S3RemoteCanvas(
        relayId,
        folderId,
        this.requireUuid(pairs.get("canvas"), "canvas"),
      );
    }
    if (pairs.has("file")) {
      return new S3RemoteFile(
        relayId,
        folderId,
        this.requireUuid(pairs.get("file"), "file"),
      );
    }
    return new S3RemoteFolder(relayId, folderId);
  }

  static getFolderId(entity: S3RNType): UUID {
    return entity.folderId;
  }

  static getRelayId(entity: S3RNType): UUID {
    return entity.relayId;
  }

  static getResourceId(entity: S3RNType): UUID {
    if (entity instanceof S3RemoteDocument) {
      return entity.documentId;
    }
    if (entity instanceof S3RemoteCanvas) {
      return entity.canvasId;
    }
    if (entity instanceof S3RemoteFile) {
      return entity.fileId;
    }
    return entity.folderId;
  }

  static getResourceKind(entity: S3RNType): ResourceKind {
    if (entity instanceof S3RemoteDocument) {
      return "doc";
    }
    if (entity instanceof S3RemoteCanvas) {
      return "canvas";
    }
    if (entity instanceof S3RemoteFile) {
      return "file";
    }
    return "folder";
  }

  static getCompoundDocumentId(entity: S3RNType): string {
    return `${entity.relayId}-${this.getResourceId(entity)}`;
  }

  private static assertUuid(value: string, label: string): void {
    if (!this.validateUUID(value)) {
      throw new Error(`Invalid ${label} UUID: ${value}`);
    }
  }

  private static requireUuid(value: string | undefined, label: string): string {
    if (!value) {
      throw new Error(`Missing ${label} UUID`);
    }
    this.assertUuid(value, label);
    return value;
  }
}
