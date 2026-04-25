#!/usr/bin/env node

import { toS3Resource } from "../relay-client/folderIndex";
import { RelayClient } from "../relay-client/relayClient";
import { S3RemoteFile } from "../relay-client/s3rn";

interface HttpProbeResult {
  ok: boolean;
  status: number;
  statusText: string;
  json?: unknown;
  text: string;
}

interface UrlSummary {
  origin: string;
  pathname: string;
  queryKeys: string[];
  hasTokenQuery: boolean;
  hasHashQuery: boolean;
  redacted: string;
  s3Presign?: S3PresignSummary;
}

interface S3PresignSummary {
  algorithm?: string;
  date?: string;
  expiresSeconds?: number;
  expiresAt?: string;
  signedHeaders?: string;
  hasSecurityToken: boolean;
  credentialScope?: string;
}

async function main(): Promise<void> {
  const attachmentPath = getAttachmentPath();
  const relay = RelayClient.fromEnv(process.env);
  const folder = await relay.loadFolder();
  const entry = relay.resolvePath(folder, attachmentPath);

  if (!entry) {
    throw new Error(`Relay path not found: ${attachmentPath}`);
  }
  if (entry.resourceKind !== "file") {
    throw new Error(`Relay path ${entry.path} is a ${entry.type} resource, not an attachment`);
  }
  if (!entry.hash) {
    throw new Error(`Relay attachment ${entry.path} is missing a content hash`);
  }

  const resource = toS3Resource(folder.relayId, folder.folderId, entry);
  if (!(resource instanceof S3RemoteFile)) {
    throw new Error(`Relay path ${entry.path} did not resolve to a file resource`);
  }

  const requestedContentType = entry.mimetype ?? "application/octet-stream";
  const requestedContentLength = parseContentLengthOverride(process.env.RELAY_FILE_TOKEN_CONTENT_LENGTH) ?? 0;
  const fileToken = await relay.auth.issueFileToken(
    resource,
    entry.hash,
    requestedContentType,
    requestedContentLength,
  );
  const baseUrl = fileToken.baseUrl.replace(/\/$/, "");

  console.log("[relay-probe] Attachment");
  console.log(`  path: ${entry.path}`);
  console.log(`  relayId: ${folder.relayId}`);
  console.log(`  folderId: ${folder.folderId}`);
  console.log(`  resourceId: ${entry.id}`);
  console.log(`  hash: ${entry.hash}`);
  console.log(`  folderMimeType: ${entry.mimetype ?? "(none)"}`);
  console.log("");

  console.log("[relay-probe] Requested file token");
  console.log(`  contentType: ${requestedContentType}`);
  console.log(`  contentLength: ${requestedContentLength}`);
  console.log(`  responseAuthorization: ${fileToken.authorization ?? "(not returned)"}`);
  console.log(`  responseExpiryTime: ${formatExpiry(fileToken.expiryTime)}`);
  console.log(`  responseContentType: ${fileToken.contentType ?? "(not returned)"}`);
  console.log(`  responseContentLength: ${formatOptionalNumber(fileToken.contentLength)}`);
  console.log(`  responseFileHash: ${fileToken.fileHash ?? fileToken.file ?? "(not returned)"}`);
  console.log(`  baseUrl: ${baseUrl}`);
  console.log("");

  const downloadProbe = await requestJson(`${baseUrl}/download-url`, "GET", fileToken.token);
  console.log("[relay-probe] Download URL probe");
  printProbeStatus(downloadProbe);
  const downloadUrl = extractStringField(downloadProbe.json, "downloadUrl");
  if (downloadUrl) {
    printUrlSummary(downloadUrl);
  }
  console.log("");

  const uploadProbe = await requestJson(`${baseUrl}/upload-url`, "POST", fileToken.token);
  console.log("[relay-probe] Upload URL probe");
  printProbeStatus(uploadProbe);
  const uploadUrl = extractStringField(uploadProbe.json, "uploadUrl");
  if (uploadUrl) {
    printUrlSummary(uploadUrl);
  }
  console.log("");

  printConclusion(uploadProbe);
}

function getAttachmentPath(): string {
  const args = process.argv.slice(2);
  const explicitPath = args.find((arg) => !arg.startsWith("-"));
  const pathFlag = args.find((arg) => arg.startsWith("--path="))?.slice("--path=".length);
  const attachmentPath =
    pathFlag ??
    explicitPath ??
    process.env.RELAY_TEST_ATTACHMENT_PATH ??
    process.env.RELAY_LIVE_TEST_ATTACHMENT_PATH;

  if (!attachmentPath) {
    throw new Error(
      "Usage: pnpm probe:file-token -- <attachment-path>\n" +
        "Or set RELAY_TEST_ATTACHMENT_PATH / RELAY_LIVE_TEST_ATTACHMENT_PATH.",
    );
  }
  return attachmentPath;
}

function parseContentLengthOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected RELAY_FILE_TOKEN_CONTENT_LENGTH to be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

async function requestJson(url: string, method: "GET" | "POST", token: string): Promise<HttpProbeResult> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  const result: HttpProbeResult = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
  };

  if (text.trim()) {
    try {
      result.json = JSON.parse(text) as unknown;
    } catch {
      // Keep the raw text for diagnostics below.
    }
  }

  return result;
}

function printProbeStatus(probe: HttpProbeResult): void {
  console.log(`  status: ${probe.status} ${probe.statusText}`);
  if (!probe.ok && probe.text.trim()) {
    console.log(`  body: ${truncate(probe.text.trim(), 500)}`);
  }
}

function printUrlSummary(rawUrl: string): void {
  const summary = summarizeUrl(rawUrl);
  console.log(`  url: ${summary.redacted}`);
  console.log(`  queryKeys: ${summary.queryKeys.length === 0 ? "(none)" : summary.queryKeys.join(", ")}`);
  console.log(`  hasTokenQuery: ${summary.hasTokenQuery}`);
  console.log(`  hasHashQuery: ${summary.hasHashQuery}`);
  if (summary.s3Presign) {
    console.log("  s3Presign:");
    console.log(`    algorithm: ${summary.s3Presign.algorithm ?? "(not present)"}`);
    console.log(`    date: ${summary.s3Presign.date ?? "(not present)"}`);
    console.log(`    expiresSeconds: ${summary.s3Presign.expiresSeconds ?? "(not present)"}`);
    console.log(`    expiresAt: ${summary.s3Presign.expiresAt ?? "(not present)"}`);
    console.log(`    signedHeaders: ${summary.s3Presign.signedHeaders ?? "(not present)"}`);
    console.log(`    hasSecurityToken: ${summary.s3Presign.hasSecurityToken}`);
    console.log(`    credentialScope: ${summary.s3Presign.credentialScope ?? "(not present)"}`);
  }
}

function summarizeUrl(rawUrl: string): UrlSummary {
  const parsed = new URL(rawUrl);
  const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
  const redactedQuery = queryKeys.map((key) => `${key}=<redacted>`).join("&");
  const s3Presign = summarizeS3Presign(parsed);
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    queryKeys,
    hasTokenQuery: parsed.searchParams.has("token"),
    hasHashQuery: parsed.searchParams.has("hash"),
    redacted: `${parsed.origin}${parsed.pathname}${redactedQuery ? `?${redactedQuery}` : ""}`,
    ...(s3Presign ? { s3Presign } : {}),
  };
}

function summarizeS3Presign(url: URL): S3PresignSummary | undefined {
  if (!url.searchParams.has("X-Amz-Signature")) {
    return undefined;
  }

  const date = url.searchParams.get("X-Amz-Date") ?? undefined;
  const expiresSeconds = parseOptionalInteger(url.searchParams.get("X-Amz-Expires"));
  return {
    algorithm: url.searchParams.get("X-Amz-Algorithm") ?? undefined,
    date,
    expiresSeconds,
    expiresAt: date && expiresSeconds !== undefined ? formatS3Expiry(date, expiresSeconds) : undefined,
    signedHeaders: url.searchParams.get("X-Amz-SignedHeaders") ?? undefined,
    hasSecurityToken: url.searchParams.has("X-Amz-Security-Token"),
    credentialScope: redactCredentialScope(url.searchParams.get("X-Amz-Credential")),
  };
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatS3Expiry(amzDate: string, expiresSeconds: number): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!match) {
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

function redactCredentialScope(credential: string | null): string | undefined {
  if (!credential) {
    return undefined;
  }
  const parts = credential.split("/");
  if (parts.length < 2) {
    return "<redacted>";
  }
  return ["<access-key>", ...parts.slice(1)].join("/");
}

function extractStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function printConclusion(uploadProbe: HttpProbeResult): void {
  if (uploadProbe.ok) {
    console.log("[relay-probe] Conclusion: file token can request an upload URL.");
    console.log("[relay-probe] That means the gateway issued a Full/upload-capable file token.");
    return;
  }

  if (uploadProbe.status === 403) {
    console.log("[relay-probe] Conclusion: file token cannot request an upload URL.");
    console.log("[relay-probe] That means the gateway issued a ReadOnly download-only file token.");
    return;
  }

  if (uploadProbe.status === 401) {
    console.log("[relay-probe] Conclusion: inconclusive; Relay rejected the file token as unauthorized.");
    return;
  }

  console.log("[relay-probe] Conclusion: inconclusive; upload-url returned an unexpected status.");
}

function formatExpiry(expiryTime: number | undefined): string {
  if (expiryTime === undefined) {
    return "(not returned)";
  }
  return `${expiryTime} (${new Date(expiryTime).toISOString()})`;
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "(not returned)" : String(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[relay-probe] ${message}`);
  process.exitCode = 1;
});
