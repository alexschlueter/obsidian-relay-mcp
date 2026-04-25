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
  fileToken: FileToken;
  baseUrl: string;
  downloadUrl: string;
  expiresAt?: string;
  bytes: Uint8Array;
  contentType?: string;
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

    const expectedLength = parseContentLength(downloadResponse.headers.get("content-length"));
    if (
      options.maxContentBytes !== undefined &&
      expectedLength !== undefined &&
      expectedLength > options.maxContentBytes
    ) {
      throw new Error(
        `Relay file is ${expectedLength} bytes, which exceeds maximum included content size ${options.maxContentBytes}`,
      );
    }

    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    if (options.maxContentBytes !== undefined && bytes.byteLength > options.maxContentBytes) {
      throw new Error(
        `Relay file is ${bytes.byteLength} bytes, which exceeds maximum included content size ${options.maxContentBytes}`,
      );
    }

    return {
      fileToken: downloadUrl.fileToken,
      baseUrl: downloadUrl.baseUrl,
      downloadUrl: downloadUrl.downloadUrl,
      ...(downloadUrl.expiresAt === undefined ? {} : { expiresAt: downloadUrl.expiresAt }),
      bytes,
      ...(downloadResponse.headers.get("content-type")
        ? { contentType: downloadResponse.headers.get("content-type")! }
        : {}),
    };
  }

  private buildHeaders(fileToken: FileToken): Record<string, string> {
    return {
      Authorization: `Bearer ${fileToken.token}`,
    };
  }
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
