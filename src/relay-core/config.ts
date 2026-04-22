import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_RELAY_API_URL = "https://api.system3.md";
export const DEFAULT_RELAY_CORE_CONFIG_FILENAME = ".relay-core.json";

export interface RelayCoreFileConfig {
  apiUrl?: string;
  authUrl?: string;
  bearerToken?: string;
  authRecord?: Record<string, unknown>;
  relayId?: string;
  folderId?: string;
  provider?: string;
  tokenExpiresAt?: string;
  updatedAt?: string;
}

export interface RelayCoreFileConfigResult {
  config?: RelayCoreFileConfig;
  path: string;
}

export interface RelayCoreConfigPathOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveRelayCoreConfigPath(options: RelayCoreConfigPathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = options.configPath ?? options.env?.RELAY_CORE_CONFIG;
  if (!configuredPath) {
    return path.resolve(cwd, DEFAULT_RELAY_CORE_CONFIG_FILENAME);
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(cwd, configuredPath);
}

export function loadRelayCoreFileConfig(
  options: RelayCoreConfigPathOptions = {},
): RelayCoreFileConfigResult {
  const resolvedPath = resolveRelayCoreConfigPath(options);
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
    config: parsed as RelayCoreFileConfig,
  };
}

export function saveRelayCoreFileConfig(
  patch: RelayCoreFileConfig,
  options: RelayCoreConfigPathOptions = {},
): RelayCoreFileConfigResult {
  const loaded = loadRelayCoreFileConfig(options);
  const merged: RelayCoreFileConfig = {
    ...(loaded.config ?? {}),
    ...removeUndefinedValues(patch),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(loaded.path), { recursive: true });
  fs.writeFileSync(loaded.path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

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
