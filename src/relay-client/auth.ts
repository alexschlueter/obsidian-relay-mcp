import { S3RN, S3RNType, S3RemoteCanvas, S3RemoteDocument, S3RemoteFile } from "./s3rn";
import { saveRelayClientFileConfig } from "./config";
import { getBearerTokenExpiryTime, RelayLoginClient } from "./login";

export interface ClientToken {
  url: string;
  baseUrl?: string;
  docId: string;
  folder: string;
  token: string;
  authorization?: "full" | "read-only";
  expiryTime?: number;
  contentType?: number;
  contentLength?: number;
  fileHash?: number;
}

export interface FileToken {
  url?: string;
  baseUrl: string;
  docId?: string;
  doc?: string;
  folder: string;
  token: string;
  authorization?: "full" | "read-only";
  expiryTime?: number;
  contentType?: string;
  contentLength?: number;
  file?: string;
  fileHash?: string;
}

export interface TokenRequestPayload {
  docId: string;
  relay: string;
  folder: string;
}

export interface FileTokenRequestPayload extends TokenRequestPayload {
  hash: string;
  contentType: string;
  contentLength: number;
}

export interface RelayAuthClientOptions {
  apiUrl: string;
  bearerToken: string;
  authUrl?: string;
  authRecord?: Record<string, unknown>;
  configPath?: string;
  fetch?: typeof fetch;
  bearerTokenRefreshMarginMs?: number;
  relayVersion?: string;
  tokenRefreshMarginMs?: number;
}

interface CachedToken<T> {
  expiresAt: number;
  token: T;
}

export class RelayAuthClient {
  private readonly apiUrl: string;
  private bearerToken: string;
  private authUrl?: string;
  private authRecord?: Record<string, unknown>;
  private readonly configPath?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly relayVersion?: string;
  private readonly tokenRefreshMarginMs: number;
  private readonly bearerTokenRefreshMarginMs: number;
  private readonly cache = new Map<string, CachedToken<ClientToken>>();
  private readonly fileCache = new Map<string, CachedToken<FileToken>>();
  private activeBearerRefresh?: Promise<void>;

  constructor(options: RelayAuthClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.authUrl = options.authUrl;
    this.authRecord = options.authRecord;
    this.configPath = options.configPath;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.relayVersion = options.relayVersion;
    this.tokenRefreshMarginMs = options.tokenRefreshMarginMs ?? 30_000;
    this.bearerTokenRefreshMarginMs = options.bearerTokenRefreshMarginMs ?? 86_400_000;

    if (!this.fetchImpl) {
      throw new Error("No fetch implementation is available for RelayAuthClient");
    }
  }

  async issueToken(resource: S3RNType): Promise<ClientToken> {
    await this.maybeRefreshBearerToken();

    const cacheKey = S3RN.encode(resource);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() + this.tokenRefreshMarginMs < cached.expiresAt) {
      return cached.token;
    }

    const payload = this.buildPayload(resource);
    const response = await this.fetchImpl(`${this.apiUrl}/token`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Relay token request failed (${response.status}): ${await safeReadResponseText(response)}`,
      );
    }

    const clientToken = (await response.json()) as ClientToken;
    this.assertClientToken(clientToken, resource);

    if (typeof clientToken.expiryTime === "number" && clientToken.expiryTime > Date.now()) {
      this.cache.set(cacheKey, {
        token: clientToken,
        expiresAt: clientToken.expiryTime,
      });
    } else {
      this.cache.delete(cacheKey);
    }

    return clientToken;
  }

  async issueFileToken(
    resource: S3RemoteFile,
    fileHash: string,
    contentType: string,
    contentLength: number,
  ): Promise<FileToken> {
    await this.maybeRefreshBearerToken();

    const cacheKey = this.buildFileCacheKey(resource, fileHash, contentType, contentLength);
    const cached = this.fileCache.get(cacheKey);
    if (cached && Date.now() + this.tokenRefreshMarginMs < cached.expiresAt) {
      return cached.token;
    }

    const payload = this.buildFilePayload(resource, fileHash, contentType, contentLength);
    const response = await this.fetchImpl(`${this.apiUrl}/file-token`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Relay file token request failed (${response.status}): ${await safeReadResponseText(response)}`,
      );
    }

    const fileToken = (await response.json()) as FileToken;
    this.assertFileToken(fileToken, resource);

    if (typeof fileToken.expiryTime === "number" && fileToken.expiryTime > Date.now()) {
      this.fileCache.set(cacheKey, {
        token: fileToken,
        expiresAt: fileToken.expiryTime,
      });
    } else {
      this.fileCache.delete(cacheKey);
    }

    return fileToken;
  }

  clearCache(resource?: S3RNType): void {
    if (!resource) {
      this.cache.clear();
      this.fileCache.clear();
      return;
    }
    const resourceKey = S3RN.encode(resource);
    this.cache.delete(resourceKey);
    for (const key of this.fileCache.keys()) {
      if (key.startsWith(`${resourceKey}:`)) {
        this.fileCache.delete(key);
      }
    }
  }

  private async maybeRefreshBearerToken(): Promise<void> {
    const expiresAt = getBearerTokenExpiryTime(this.bearerToken);
    if (!expiresAt) {
      return;
    }

    if (Date.now() + this.bearerTokenRefreshMarginMs < expiresAt) {
      return;
    }

    if (!this.authUrl || !this.authRecord) {
      return;
    }

    if (this.activeBearerRefresh) {
      return this.activeBearerRefresh;
    }

    const refreshPromise = this.refreshBearerToken(expiresAt);
    this.activeBearerRefresh = refreshPromise;

    try {
      await refreshPromise;
    } finally {
      this.activeBearerRefresh = undefined;
    }
  }

  private async refreshBearerToken(expiresAt: number): Promise<void> {
    try {
      const loginClient = new RelayLoginClient({
        apiUrl: this.apiUrl,
        authUrl: this.authUrl,
        fetch: this.fetchImpl,
        relayVersion: this.relayVersion,
      });

      const refreshed = await loginClient.refreshAuthToken({
        token: this.bearerToken,
        record: this.authRecord,
      });

      this.bearerToken = refreshed.token;
      this.authRecord = refreshed.record as Record<string, unknown>;

      if (this.configPath) {
        saveRelayClientFileConfig(
          {
            authRecord: this.authRecord,
            authUrl: this.authUrl,
            bearerToken: this.bearerToken,
            provider: refreshed.provider,
            tokenExpiresAt: refreshed.tokenExpiresAt,
          },
          { configPath: this.configPath },
        );
      }
    } catch (error) {
      if (Date.now() >= expiresAt) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Relay bearer token expired and refresh failed: ${message}`);
      }
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      "Content-Type": "application/json",
    };
    if (this.relayVersion) {
      headers["Relay-Version"] = this.relayVersion;
    }
    return headers;
  }

  private buildPayload(resource: S3RNType): TokenRequestPayload {
    if (resource instanceof S3RemoteDocument) {
      return {
        docId: resource.documentId,
        relay: resource.relayId,
        folder: resource.folderId,
      };
    }
    if (resource instanceof S3RemoteCanvas) {
      return {
        docId: resource.canvasId,
        relay: resource.relayId,
        folder: resource.folderId,
      };
    }
    if (resource instanceof S3RemoteFile) {
      return {
        docId: resource.fileId,
        relay: resource.relayId,
        folder: resource.folderId,
      };
    }
    return {
      docId: resource.folderId,
      relay: resource.relayId,
      folder: resource.folderId,
    };
  }

  private buildFilePayload(
    resource: S3RemoteFile,
    fileHash: string,
    contentType: string,
    contentLength: number,
  ): FileTokenRequestPayload {
    return {
      docId: resource.fileId,
      relay: resource.relayId,
      folder: resource.folderId,
      hash: fileHash,
      contentType,
      contentLength,
    };
  }

  private buildFileCacheKey(
    resource: S3RemoteFile,
    fileHash: string,
    contentType: string,
    contentLength: number,
  ): string {
    return `${S3RN.encode(resource)}:${fileHash}:${contentType}:${contentLength}`;
  }

  private assertClientToken(token: ClientToken, resource: S3RNType): void {
    if (!token.url || !token.docId || !token.token) {
      throw new Error(`Relay returned an incomplete client token for ${S3RN.encode(resource)}`);
    }
  }

  private assertFileToken(token: FileToken, resource: S3RemoteFile): void {
    if (!token.baseUrl || !token.token || (!token.docId && !token.doc)) {
      throw new Error(`Relay returned an incomplete file token for ${S3RN.encode(resource)}`);
    }
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
