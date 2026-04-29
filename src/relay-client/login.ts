import PocketBase, {
  type AuthProviderInfo,
  type RecordAuthResponse,
  type RecordModel,
} from "pocketbase";
import { DEFAULT_RELAY_API_URL } from "./config";

const DEFAULT_RELAY_AUTH_URL = "https://auth.system3.md";

export interface RelayLoginClientOptions {
  apiUrl?: string;
  authUrl?: string;
  fetch?: typeof fetch;
  relayVersion?: string;
}

export interface RelayOAuthProvider {
  authProviderInfo: AuthProviderInfo;
  loginUrl: string;
  provider: string;
  redirectUrl: string;
}

export interface RelayOAuthLoginOptions {
  onAuthUrl?: (loginUrl: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RelayLoginResult {
  authUrl: string;
  provider: string;
  record: RecordModel;
  token: string;
  tokenExpiresAt?: string;
  user: {
    email?: string;
    id: string;
    name?: string;
  };
}

export interface RelayEnvExportInput {
  apiUrl?: string;
  authUrl?: string;
  bearerToken: string;
}

interface CodeExchangeRecord extends RecordModel {
  code: string;
}

export class RelayLoginClient {
  readonly authUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly relayVersion?: string;
  private readonly pb: PocketBase;

  constructor(options: RelayLoginClientOptions = {}) {
    this.authUrl = resolveRelayAuthUrl({
      authUrl: options.authUrl,
      apiUrl: options.apiUrl,
    });
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.relayVersion = options.relayVersion;

    if (!this.fetchImpl) {
      throw new Error("No fetch implementation is available for RelayLoginClient");
    }

    this.pb = new PocketBase(this.authUrl);
    this.pb.beforeSend = (url, requestOptions) => {
      requestOptions.fetch = this.fetchImpl;
      requestOptions.headers = Object.assign({}, requestOptions.headers, {
        ...(this.relayVersion ? { "Relay-Version": this.relayVersion } : {}),
      });
      return { url, options: requestOptions };
    };
  }

  async getProvider(providerName: string): Promise<RelayOAuthProvider> {
    const authMethods = await this.pb.collection("users").listAuthMethods({
      fetch: this.fetchImpl,
    });

    const provider = authMethods.authProviders.find((candidate) => candidate.name === providerName);
    if (!provider) {
      const available = authMethods.authProviders.map((candidate) => candidate.name).sort();
      throw new Error(
        `Relay auth provider "${providerName}" is not available. Providers returned by the server: ${available.join(", ")}`,
      );
    }

    const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
    return {
      authProviderInfo: provider,
      loginUrl: provider.authUrl + redirectUrl,
      provider: provider.name,
      redirectUrl,
    };
  }

  async loginWithOAuth(
    providerName: string,
    options: RelayOAuthLoginOptions = {},
  ): Promise<RelayLoginResult> {
    const provider = await this.getProvider(providerName);
    options.onAuthUrl?.(provider.loginUrl);

    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const exchangeCode = await this.waitForCode(provider.authProviderInfo, timeoutMs, pollIntervalMs);

    const authData = await this.pb.collection("users").authWithOAuth2Code(
      provider.provider,
      exchangeCode,
      provider.authProviderInfo.codeVerifier,
      provider.redirectUrl,
      {
        fetch: this.fetchImpl,
      },
    );

    return toRelayLoginResult(this.authUrl, provider.provider, authData);
  }

  async refreshAuthToken(auth: {
    record?: Record<string, unknown>;
    token: string;
  }): Promise<RelayLoginResult> {
    this.pb.authStore.save(auth.token, auth.record as RecordModel | undefined);
    const authData = await this.pb.collection("users").authRefresh({
      fetch: this.fetchImpl,
    });
    return toRelayLoginResult(this.authUrl, "refresh", authData);
  }

  private async waitForCode(
    provider: AuthProviderInfo,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<string> {
    const exchangeId = provider.state.slice(0, 15);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      try {
        const record = await this.pb
          .collection("code_exchange")
          .getOne<CodeExchangeRecord>(exchangeId, { fetch: this.fetchImpl });

        if (record?.code) {
          return record.code;
        }
      } catch {
        // The code exchange record is expected to 404 until login completes.
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting ${Math.round(timeoutMs / 1000)}s for the ${provider.name} OAuth login to complete`,
    );
  }
}

export function resolveRelayAuthUrl(options: { apiUrl?: string; authUrl?: string } = {}): string {
  if (options.authUrl) {
    return stripTrailingSlash(options.authUrl);
  }

  return DEFAULT_RELAY_AUTH_URL;
}

export function buildRelayBearerTokenExports(input: RelayEnvExportInput): string {
  const lines = [];
  if (input.apiUrl) {
    lines.push(`export RELAY_API_URL=${shellQuote(stripTrailingSlash(input.apiUrl))}`);
  }
  if (input.authUrl) {
    lines.push(`export RELAY_AUTH_URL=${shellQuote(stripTrailingSlash(input.authUrl))}`);
  }
  lines.push(`export RELAY_BEARER_TOKEN=${shellQuote(input.bearerToken)}`);
  return lines.join("\n");
}

function toRelayLoginResult(
  authUrl: string,
  provider: string,
  authData: RecordAuthResponse<RecordModel>,
): RelayLoginResult {
  const tokenExpiresAt = getBearerTokenExpiryTime(authData.token);
  return {
    authUrl,
    provider,
    record: authData.record,
    token: authData.token,
    ...(tokenExpiresAt ? { tokenExpiresAt: new Date(tokenExpiresAt).toISOString() } : {}),
    user: {
      id: authData.record.id,
      ...(typeof authData.record.name === "string" ? { name: authData.record.name } : {}),
      ...(typeof authData.record.email === "string" ? { email: authData.record.email } : {}),
    },
  };
}

export function getDefaultRelayApiUrl(): string {
  return DEFAULT_RELAY_API_URL;
}

export function getBearerTokenExpiryTime(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) {
    return undefined;
  }
  return payload.exp * 1000;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payloadPart = parts[1];
    if (!payloadPart) {
      return undefined;
    }
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
