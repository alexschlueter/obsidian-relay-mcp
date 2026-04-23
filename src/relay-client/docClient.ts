import * as Y from "yjs";
import { ClientToken } from "./auth";

export interface RelayDocClientOptions {
  fetch?: typeof fetch;
}

export interface LoadedYDoc {
  clientToken: ClientToken;
  baseUrl: string;
  remoteUpdate: Uint8Array;
  ydoc: Y.Doc;
}

export interface LoadedTextDocument extends LoadedYDoc {
  text: string;
  ytext: Y.Text;
}

export class RelayDocClient {
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayDocClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation is available for RelayDocClient");
    }
  }

  getBaseUrl(clientToken: ClientToken): string {
    if (clientToken.baseUrl) {
      return clientToken.baseUrl.replace(/\/$/, "");
    }

    const url = new URL(clientToken.url);
    if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol === "ws:") {
      url.protocol = "http:";
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const wsIndex = segments.lastIndexOf("ws");
    if (wsIndex >= 0) {
      const baseSegments = segments.slice(0, wsIndex);
      if (baseSegments.length === 1 && baseSegments[0] === "doc") {
        baseSegments.push(clientToken.docId);
      }
      url.pathname = `/${baseSegments.join("/")}`;
      return url.toString().replace(/\/$/, "");
    }

    return url.toString().replace(/\/$/, "");
  }

  async loadYDoc(clientToken: ClientToken): Promise<LoadedYDoc> {
    const baseUrl = this.getBaseUrl(clientToken);
    const response = await this.fetchImpl(`${baseUrl}/as-update`, {
      method: "GET",
      headers: this.buildHeaders(clientToken),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Relay document update (${response.status}): ${await safeReadResponseText(
          response,
        )}`,
      );
    }

    const remoteUpdate = new Uint8Array(await response.arrayBuffer());
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, remoteUpdate);

    return {
      clientToken,
      baseUrl,
      remoteUpdate,
      ydoc,
    };
  }

  async loadTextDocument(clientToken: ClientToken, textKey = "contents"): Promise<LoadedTextDocument> {
    const loaded = await this.loadYDoc(clientToken);
    const ytext = loaded.ydoc.getText(textKey);
    return {
      ...loaded,
      text: ytext.toString(),
      ytext,
    };
  }

  async pushUpdate(clientToken: ClientToken, update: Uint8Array): Promise<void> {
    const baseUrl = this.getBaseUrl(clientToken);
    const response = await this.fetchImpl(`${baseUrl}/update`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(clientToken),
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(update),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to push Relay document update (${response.status}): ${await safeReadResponseText(
          response,
        )}`,
      );
    }
  }

  private buildHeaders(clientToken: ClientToken): Record<string, string> {
    return {
      Authorization: `Bearer ${clientToken.token}`,
    };
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
