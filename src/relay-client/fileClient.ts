import { FileToken } from "./auth";

export interface RelayFileClientOptions {
  fetch?: typeof fetch;
}

export interface RelayFileDownloadOptions {
  maxContentBytes?: number;
}

export interface RelayFileDownloadUrl {
  fileToken: FileToken;
  baseUrl: string;
  downloadUrl: string;
  expiresAt?: string;
}

export interface DownloadedRelayFile {
  bytes?: Uint8Array;
  contentType?: string;
  contentLength?: number;
  contentLimitExceeded?: true;
}

export class RelayFileClient {
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayFileClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation is available for RelayFileClient");
    }
  }

  getBaseUrl(fileToken: FileToken): string {
    return fileToken.baseUrl.replace(/\/$/, "");
  }

  async getDownloadUrl(fileToken: FileToken): Promise<RelayFileDownloadUrl> {
    const baseUrl = this.getBaseUrl(fileToken);
    const response = await this.fetchImpl(`${baseUrl}/download-url`, {
      method: "GET",
      headers: this.buildHeaders(fileToken),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Relay file download URL (${response.status}): ${await safeReadResponseText(
          response,
        )}`,
      );
    }

    const responseJson = await response.json() as { downloadUrl?: unknown };
    if (typeof responseJson.downloadUrl !== "string" || responseJson.downloadUrl.length === 0) {
      throw new Error("Relay returned an incomplete file download URL response");
    }

    return {
      fileToken,
      baseUrl,
      downloadUrl: responseJson.downloadUrl,
      ...buildExpiresAt(responseJson.downloadUrl, fileToken),
    };
  }

  async downloadFile(
    fileToken: FileToken,
    options: RelayFileDownloadOptions = {},
  ): Promise<DownloadedRelayFile> {
    const downloadUrl = await this.getDownloadUrl(fileToken);
    return this.downloadFileFromUrl(downloadUrl, options);
  }

  async downloadFileFromUrl(
    downloadUrl: RelayFileDownloadUrl,
    options: RelayFileDownloadOptions = {},
  ): Promise<DownloadedRelayFile> {
    const downloadResponse = await this.fetchImpl(downloadUrl.downloadUrl);
    if (!downloadResponse.ok) {
      throw new Error(
        `Failed to download Relay file (${downloadResponse.status}): ${await safeReadResponseText(
          downloadResponse,
        )}`,
      );
    }

    const contentType = downloadResponse.headers.get("content-type") ?? undefined;
    const expectedLength = parseContentLength(downloadResponse.headers.get("content-length"));
    if (
      options.maxContentBytes !== undefined &&
      expectedLength !== undefined &&
      expectedLength > options.maxContentBytes
    ) {
      return {
        contentLength: expectedLength,
        contentType,
        contentLimitExceeded: true,
      };
    }

    const downloaded = await readResponseBytes(downloadResponse, options.maxContentBytes);
    if (downloaded.contentLimitExceeded) {
      return {
        contentLength: downloaded.contentLength,
        contentType,
        contentLimitExceeded: true,
      };
    }

    return {
      bytes: downloaded.bytes,
      contentLength: downloaded.contentLength,
      contentType,
    };
  }

  private buildHeaders(fileToken: FileToken): Record<string, string> {
    return {
      Authorization: `Bearer ${fileToken.token}`,
    };
  }
}

async function readResponseBytes(
  response: Response,
  maxContentBytes: number | undefined,
): Promise<{ bytes?: Uint8Array; contentLength: number; contentLimitExceeded?: true }> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxContentBytes !== undefined && bytes.byteLength > maxContentBytes) {
      return {
        contentLength: bytes.byteLength,
        contentLimitExceeded: true,
      };
    }
    return {
      bytes,
      contentLength: bytes.byteLength,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (maxContentBytes !== undefined && totalBytes > maxContentBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          contentLength: totalBytes,
          contentLimitExceeded: true,
        };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    bytes: concatUint8Arrays(chunks, totalBytes),
    contentLength: totalBytes,
  };
}

function concatUint8Arrays(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function buildExpiresAt(downloadUrl: string, fileToken: FileToken): { expiresAt?: string } {
  const s3ExpiresAt = parseS3PresignedUrlExpiresAt(downloadUrl);
  if (s3ExpiresAt) {
    return { expiresAt: s3ExpiresAt };
  }
  if (typeof fileToken.expiryTime === "number" && Number.isFinite(fileToken.expiryTime)) {
    return { expiresAt: new Date(fileToken.expiryTime).toISOString() };
  }
  return {};
}

function parseS3PresignedUrlExpiresAt(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!parsed.searchParams.has("X-Amz-Signature")) {
    return undefined;
  }
  const amzDate = parsed.searchParams.get("X-Amz-Date");
  const expires = parsed.searchParams.get("X-Amz-Expires");
  if (!amzDate || !expires) {
    return undefined;
  }

  const expiresSeconds = Number.parseInt(expires, 10);
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!Number.isFinite(expiresSeconds) || !match) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  const signedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return new Date(signedAt + expiresSeconds * 1000).toISOString();
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
