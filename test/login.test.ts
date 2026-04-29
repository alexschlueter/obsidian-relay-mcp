import { describe, expect, it } from "vitest";
import {
  buildRelayBearerTokenExports,
  getBearerTokenExpiryTime,
  resolveRelayAuthUrl,
} from "../src/relay-client/login";
import { parseRelayLoginProvider, parseRelayProviderSelection } from "../src/bin/relay-login";

describe("relay login helpers", () => {
  it("prefers an explicit auth url", () => {
    expect(
      resolveRelayAuthUrl({
        apiUrl: "https://api.system3.md",
        authUrl: "https://custom-auth.example.com/",
      }),
    ).toBe("https://custom-auth.example.com");
  });

  it("uses the default auth gateway when auth url is omitted", () => {
    expect(resolveRelayAuthUrl({ apiUrl: "https://custom-api.example.com" })).toBe(
      "https://auth.system3.md",
    );
  });

  it("renders shell export lines for the bearer token flow", () => {
    expect(
      buildRelayBearerTokenExports({
        apiUrl: "https://api.system3.md/",
        authUrl: "https://auth.system3.md/",
        bearerToken: "abc123",
      }),
    ).toBe(
      "export RELAY_API_URL='https://api.system3.md'\n" +
        "export RELAY_AUTH_URL='https://auth.system3.md'\n" +
        "export RELAY_BEARER_TOKEN='abc123'",
    );
  });

  it("extracts jwt expiry timestamps when present", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
    const token = `${header}.${payload}.signature`;

    expect(getBearerTokenExpiryTime(token)).toBe(2_000_000_000_000);
  });

  it("parses generic relay login providers from cli arguments", () => {
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login:google"])).toBe("google");
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login", "microsoft"])).toBe(
      "microsoft",
    );
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login", "--provider=oidc"])).toBe(
      "oidc",
    );
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login", "-p", "discord"])).toBe(
      "discord",
    );
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login"], "google")).toBe("google");
    expect(parseRelayLoginProvider(["node", "obsidian-relay-mcp", "login"])).toBeUndefined();
  });

  it("parses interactive provider selections by number or name", () => {
    const providers = ["github", "google", "microsoft"];

    expect(parseRelayProviderSelection("1", providers)).toBe("github");
    expect(parseRelayProviderSelection("2", providers)).toBe("google");
    expect(parseRelayProviderSelection("Microsoft", providers)).toBe("microsoft");
    expect(parseRelayProviderSelection("4", providers)).toBeUndefined();
    expect(parseRelayProviderSelection("", providers)).toBeUndefined();
  });
});
