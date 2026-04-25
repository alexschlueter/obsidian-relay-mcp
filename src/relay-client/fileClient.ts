import { FileToken } from "./auth";

export interface RelayFileClientOptions {
  fetch?: typeof fetch;
}

export interface RelayFileDownloadOptions {
  maxBytes?: number;
}

export interface DownloadedRelayFile {
  fileToken: FileToken;
  baseUrl: string;
  downloadUrl: string;
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

  async downloadFile(
    fileToken: FileToken,
    options: RelayFileDownloadOptions = {},
  ): Promise<DownloadedRelayFile> {
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

    const downloadResponse = await this.fetchImpl(responseJson.downloadUrl);
    if (!downloadResponse.ok) {
      throw new Error(
        `Failed to download Relay file (${downloadResponse.status}): ${await safeReadResponseText(
          downloadResponse,
        )}`,
      );
    }

    const expectedLength = parseContentLength(downloadResponse.headers.get("content-length"));
    if (
      options.maxBytes !== undefined &&
      expectedLength !== undefined &&
      expectedLength > options.maxBytes
    ) {
      throw new Error(
        `Relay file is ${expectedLength} bytes, which exceeds maxBytes ${options.maxBytes}`,
      );
    }

    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new Error(
        `Relay file is ${bytes.byteLength} bytes, which exceeds maxBytes ${options.maxBytes}`,
      );
    }

    return {
      fileToken,
      baseUrl,
      downloadUrl: responseJson.downloadUrl,
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
