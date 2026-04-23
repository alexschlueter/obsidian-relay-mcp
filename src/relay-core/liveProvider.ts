import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { ClientToken } from "./auth";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

export type RelayAwareness = awarenessProtocol.Awareness;

export interface LiveRelayProviderOptions {
  WebSocketImpl?: typeof WebSocket;
  connectTimeoutMs?: number;
}

export class LiveRelayProvider {
  readonly awareness: RelayAwareness;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly connectTimeoutMs: number;
  private readonly url: string;
  private ws: WebSocket | null = null;
  private synced = false;
  private destroyed = false;
  private syncWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private readonly updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.destroyed) {
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private readonly awarenessUpdateHandler = (
    event: { added: number[]; updated: number[]; removed: number[] },
  ) => {
    if (this.destroyed) {
      return;
    }

    const changedClients = event.added.concat(event.updated, event.removed);
    if (changedClients.length === 0) {
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
    );
    this.send(encoding.toUint8Array(encoder));
  };

  constructor(
    clientToken: ClientToken,
    readonly doc: Y.Doc,
    options: LiveRelayProviderOptions = {},
  ) {
    const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (!WebSocketImpl) {
      throw new Error("No WebSocket implementation is available for LiveRelayProvider");
    }

    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.url = buildLiveWebSocketUrl(clientToken);
    this.awareness = new awarenessProtocol.Awareness(doc);

    this.doc.on("update", this.updateHandler);
    this.awareness.on("update", this.awarenessUpdateHandler);
  }

  connect(): void {
    if (this.destroyed || this.ws) {
      return;
    }

    const ws = new this.WebSocketImpl(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));

      if (this.awareness.getLocalState() !== null) {
        this.broadcastLocalAwareness();
      }
    };

    ws.onmessage = (event) => {
      void this.handleRawMessage(event.data).catch((error) => {
        this.rejectSyncWaiters(error instanceof Error ? error : new Error(String(error)));
      });
    };

    ws.onerror = () => {
      this.rejectSyncWaiters(new Error("Relay live websocket failed"));
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.destroyed) {
        this.rejectSyncWaiters(new Error("Relay live websocket closed before sync completed"));
      }
    };
  }

  async waitForSynced(timeoutMs = this.connectTimeoutMs): Promise<void> {
    if (this.synced) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.syncWaiters = this.syncWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Relay live sync`));
      }, timeoutMs);
      this.syncWaiters.push({ resolve, reject, timer });
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    try {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], this);
    } catch {
      // Best-effort presence cleanup only.
    }

    this.doc.off("update", this.updateHandler);
    this.awareness.off("update", this.awarenessUpdateHandler);
    this.awareness.destroy();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (
        this.ws.readyState === this.WebSocketImpl.OPEN ||
        this.ws.readyState === this.WebSocketImpl.CONNECTING
      ) {
        this.ws.close(1000, "Relay live provider destroyed");
      }
      this.ws = null;
    }

    this.resolveSyncWaiters();
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    const bytes = await messageDataToUint8Array(raw);
    const response = this.readMessage(bytes);
    if (encoding.length(response) > 1) {
      this.send(encoding.toUint8Array(response));
    }
  }

  private readMessage(bytes: Uint8Array): encoding.Encoder {
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const syncMessageType = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this,
        );
        if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.resolveSyncWaiters();
        }
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        break;
      case MESSAGE_QUERY_AWARENESS:
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            Array.from(this.awareness.getStates().keys()),
          ),
        );
        break;
      case MESSAGE_AUTH:
        throw new Error("Relay live websocket reported an authorization error");
      default:
        throw new Error(`Unsupported Relay live message type: ${messageType}`);
    }

    return encoder;
  }

  private broadcastLocalAwareness(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  private send(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      return;
    }
    this.ws.send(bytes);
  }

  private resolveSyncWaiters(): void {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectSyncWaiters(error: Error): void {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function buildLiveWebSocketUrl(clientToken: ClientToken): string {
  const url = new URL(clientToken.url);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (pathSegments.at(-1) !== clientToken.docId) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${clientToken.docId}`;
  }
  url.searchParams.set("token", clientToken.token);
  return url.toString();
}

async function messageDataToUint8Array(raw: unknown): Promise<Uint8Array> {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return new Uint8Array(await raw.arrayBuffer());
  }
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw);
  }
  throw new Error("Unsupported Relay live websocket message payload");
}
