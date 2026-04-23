import PocketBase, { type RecordFullListOptions, type RecordModel } from "pocketbase";
import { saveRelayClientFileConfig } from "./config";
import { getBearerTokenExpiryTime, RelayLoginClient, resolveRelayAuthUrl } from "./login";

interface RelayRecord extends RecordModel {
  guid: string;
  name: string;
  provider?: string;
  expand?: {
    provider?: {
      id: string;
      name?: string;
    };
  };
}

interface SharedFolderRecord extends RecordModel {
  creator?: string;
  guid: string;
  name: string;
  private?: boolean;
  relay: string;
  expand?: {
    creator?: {
      id: string;
      name?: string;
    };
    relay?: RelayRecord;
  };
}

export interface RelayDirectoryClientOptions {
  apiUrl?: string;
  authRecord?: Record<string, unknown>;
  authUrl?: string;
  bearerToken: string;
  bearerTokenRefreshMarginMs?: number;
  configPath?: string;
  fetch?: typeof fetch;
  relayVersion?: string;
}

export interface RelaySummary {
  id: string;
  guid: string;
  name: string;
  providerId?: string;
  providerName?: string;
}

export interface RelayFolderSummary {
  creatorId?: string;
  creatorName?: string;
  guid: string;
  id: string;
  name: string;
  private: boolean;
  relayGuid: string;
  relayId: string;
  relayName: string;
}

export interface RelayDirectorySnapshot {
  folders: RelayFolderSummary[];
  relays: RelaySummary[];
}

export interface RelayAuthState {
  authRecord?: Record<string, unknown>;
  authUrl: string;
  bearerToken: string;
  tokenExpiresAt?: string;
}

export class RelayDirectoryClient {
  readonly authUrl: string;
  private authRecord?: Record<string, unknown>;
  private bearerToken: string;
  private readonly bearerTokenRefreshMarginMs: number;
  private readonly configPath?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pb: PocketBase;
  private readonly relayVersion?: string;
  private activeBearerRefresh?: Promise<void>;

  constructor(options: RelayDirectoryClientOptions) {
    this.authUrl = resolveRelayAuthUrl({
      apiUrl: options.apiUrl,
      authUrl: options.authUrl,
    });
    this.authRecord = options.authRecord;
    this.bearerToken = options.bearerToken;
    this.bearerTokenRefreshMarginMs = options.bearerTokenRefreshMarginMs ?? 86_400_000;
    this.configPath = options.configPath;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.relayVersion = options.relayVersion;

    if (!this.fetchImpl) {
      throw new Error("No fetch implementation is available for RelayDirectoryClient");
    }

    this.pb = new PocketBase(this.authUrl);
    this.pb.beforeSend = (url, requestOptions) => {
      requestOptions.fetch = this.fetchImpl;
      requestOptions.headers = Object.assign({}, requestOptions.headers, {
        ...(this.relayVersion ? { "Relay-Version": this.relayVersion } : {}),
      });
      return { url, options: requestOptions };
    };
    this.pb.authStore.save(this.bearerToken, this.authRecord as RecordModel | undefined);
  }

  async listDirectory(): Promise<RelayDirectorySnapshot> {
    await this.maybeRefreshBearerToken();

    const [relayRecords, folderRecords] = await Promise.all([
      this.pb.collection("relays").getFullList<RelayRecord>(buildOptions("provider")),
      this.pb
        .collection("shared_folders")
        .getFullList<SharedFolderRecord>(buildOptions("relay,creator")),
    ]);

    const relays = relayRecords
      .map((record) => ({
        id: record.id,
        guid: record.guid,
        name: record.name,
        ...(record.provider ? { providerId: record.provider } : {}),
        ...(record.expand?.provider?.name ? { providerName: record.expand.provider.name } : {}),
      }))
      .sort(compareByNameThenGuid);

    const relayByRecordId = new Map(relays.map((relay) => [relay.id, relay]));

    const folders = folderRecords
      .map((record) => {
        const expandedRelay = record.expand?.relay;
        const relay =
          relayByRecordId.get(record.relay) ??
          (expandedRelay
            ? {
                id: expandedRelay.id,
                guid: expandedRelay.guid,
                name: expandedRelay.name,
              }
            : undefined);

        if (!relay) {
          return undefined;
        }

        return {
          id: record.id,
          guid: record.guid,
          name: record.name,
          private: Boolean(record.private),
          relayGuid: relay.guid,
          relayId: relay.id,
          relayName: relay.name,
          ...(record.creator ? { creatorId: record.creator } : {}),
          ...(record.expand?.creator?.name ? { creatorName: record.expand.creator.name } : {}),
        } satisfies RelayFolderSummary;
      })
      .filter(isDefined)
      .sort((left, right) => {
        const relayNameComparison = compareStrings(left.relayName, right.relayName);
        if (relayNameComparison !== 0) {
          return relayNameComparison;
        }
        return compareByNameThenGuid(left, right);
      });

    return { relays, folders };
  }

  getAuthState(): RelayAuthState {
    return {
      ...(this.authRecord ? { authRecord: this.authRecord } : {}),
      authUrl: this.authUrl,
      bearerToken: this.bearerToken,
      ...(this.getTokenExpiresAtIsoString()
        ? { tokenExpiresAt: this.getTokenExpiresAtIsoString() }
        : {}),
    };
  }

  private async maybeRefreshBearerToken(): Promise<void> {
    const expiresAt = getBearerTokenExpiryTime(this.bearerToken);
    if (!expiresAt) {
      return;
    }

    if (Date.now() + this.bearerTokenRefreshMarginMs < expiresAt) {
      return;
    }

    if (!this.authRecord) {
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
        apiUrl: undefined,
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
      this.pb.authStore.save(this.bearerToken, this.authRecord as RecordModel | undefined);

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

  private getTokenExpiresAtIsoString(): string | undefined {
    const expiresAt = getBearerTokenExpiryTime(this.bearerToken);
    return expiresAt ? new Date(expiresAt).toISOString() : undefined;
  }
}

function buildOptions(expand: string): RecordFullListOptions {
  return {
    expand,
    sort: "name",
  };
}

function compareByNameThenGuid<T extends { guid: string; name: string }>(left: T, right: T): number {
  const nameComparison = compareStrings(left.name, right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }
  return compareStrings(left.guid, right.guid);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
