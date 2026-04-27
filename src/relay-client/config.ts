import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_RELAY_API_URL = "https://api.system3.md";
export const DEFAULT_RELAY_CLIENT_CONFIG_FILENAME = ".relay-client.json";
export const DEFAULT_RELAY_CLIENT_USER_CONFIG_DIRNAME = "obsidian-relay-mcp";
export const DEFAULT_RELAY_CLIENT_USER_CONFIG_FILENAME = "config.json";
export const RELAY_CLIENT_CONFIG_FILE_MODE = 0o600;

export interface RelayClientFileConfig {
  apiUrl?: string;
  authUrl?: string;
  bearerToken?: string;
  authRecord?: Record<string, unknown>;
  attachments?: RelayAttachmentContentConfig;
  relayId?: string;
  folderId?: string;
  provider?: string;
  tokenExpiresAt?: string;
  updatedAt?: string;
}

export interface RelayAttachmentContentConfig {
  includeTextContent?: boolean;
  includeImageContent?: boolean;
  includeAudioContent?: boolean;
  maxTextChars?: number;
  maxImageContentMB?: number;
  maxAudioContentMB?: number;
}

export interface RelayClientFileConfigResult {
  config?: RelayClientFileConfig;
  path: string;
}

export interface RelayClientConfigPathOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveRelayClientConfigPath(options: RelayClientConfigPathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configuredPath = options.configPath ?? env.RELAY_CLIENT_CONFIG;
  if (!configuredPath) {
    const localConfigPath = path.resolve(cwd, DEFAULT_RELAY_CLIENT_CONFIG_FILENAME);
    return fs.existsSync(localConfigPath)
      ? localConfigPath
      : getDefaultRelayClientUserConfigPath(env);
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(cwd, configuredPath);
}

export function getDefaultRelayClientUserConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = getConfigHome(env);
  return path.join(
    configHome,
    DEFAULT_RELAY_CLIENT_USER_CONFIG_DIRNAME,
    DEFAULT_RELAY_CLIENT_USER_CONFIG_FILENAME,
  );
}

export function loadRelayClientFileConfig(
  options: RelayClientConfigPathOptions = {},
): RelayClientFileConfigResult {
  const resolvedPath = resolveRelayClientConfigPath(options);
  if (!fs.existsSync(resolvedPath)) {
    return { path: resolvedPath };
  }

  const raw = fs.readFileSync(resolvedPath, "utf8").trim();
  if (!raw) {
    return { path: resolvedPath };
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Relay config at ${resolvedPath} must contain a JSON object`);
  }

  return {
    path: resolvedPath,
    config: parsed as RelayClientFileConfig,
  };
}

export function saveRelayClientFileConfig(
  patch: RelayClientFileConfig,
  options: RelayClientConfigPathOptions = {},
): RelayClientFileConfigResult {
  const loaded = loadRelayClientFileConfig(options);
  const merged: RelayClientFileConfig = {
    ...(loaded.config ?? {}),
    ...removeUndefinedValues(patch),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(loaded.path), { recursive: true });
  fs.writeFileSync(loaded.path, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: RELAY_CLIENT_CONFIG_FILE_MODE,
  });
  fs.chmodSync(loaded.path, RELAY_CLIENT_CONFIG_FILE_MODE);

  return {
    path: loaded.path,
    config: merged,
  };
}

function removeUndefinedValues<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfigHome(env: NodeJS.ProcessEnv): string {
  if (env.XDG_CONFIG_HOME) {
    return env.XDG_CONFIG_HOME;
  }
  if (process.platform === "win32" && env.APPDATA) {
    return env.APPDATA;
  }
  return path.join(os.homedir(), ".config");
}
