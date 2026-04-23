import { describe, expect, it } from "vitest";
import {
  buildRelayBearerTokenExports,
  getBearerTokenExpiryTime,
  resolveRelayAuthUrl,
} from "../src/relay-client/login";

describe("relay login helpers", () => {
  it("prefers an explicit auth url", () => {
    expect(
      resolveRelayAuthUrl({
        apiUrl: "https://api.system3.md",
        authUrl: "https://custom-auth.example.com/",
      }),
    ).toBe("https://custom-auth.example.com");
  });

  it("derives the default auth url from the api url", () => {
    expect(resolveRelayAuthUrl({ apiUrl: "https://api.system3.md" })).toBe(
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
});
