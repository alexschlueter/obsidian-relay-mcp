import { describe, expect, it } from "vitest";
import { RelayDirectoryClient } from "../src/relay-client/directory";

describe("RelayDirectoryClient", () => {
  it("lists relays and shared folders using Relay guids", async () => {
    const requests: string[] = [];

    const client = new RelayDirectoryClient({
      authRecord: {
        id: "user-1",
      },
      authUrl: "https://auth.system3.md",
      bearerToken: buildJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);

        if (url.includes("/api/collections/relays/records")) {
          return jsonResponse({
            items: [
              {
                id: "relay-record-1",
                guid: "11111111-1111-1111-1111-111111111111",
                name: "Team Relay",
                provider: "provider-1",
                expand: {
                  provider: {
                    id: "provider-1",
                    name: "System3 Cloud",
                  },
                },
              },
            ],
            page: 1,
            perPage: 200,
            totalItems: 1,
            totalPages: 1,
          });
        }

        if (url.includes("/api/collections/shared_folders/records")) {
          return jsonResponse({
            items: [
              {
                creator: "user-1",
                guid: "22222222-2222-2222-2222-222222222222",
                id: "folder-record-1",
                name: "Knowledge Base",
                private: false,
                relay: "relay-record-1",
                expand: {
                  creator: {
                    id: "user-1",
                    name: "Alex",
                  },
                },
              },
            ],
            page: 1,
            perPage: 200,
            totalItems: 1,
            totalPages: 1,
          });
        }

        throw new Error(`Unexpected request URL: ${url}`);
      },
    });

    const result = await client.listDirectory();

    expect(requests.some((url) => url.includes("/api/collections/relays/records"))).toBe(true);
    expect(requests.some((url) => url.includes("/api/collections/shared_folders/records"))).toBe(
      true,
    );
    expect(result.relays).toEqual([
      {
        guid: "11111111-1111-1111-1111-111111111111",
        id: "relay-record-1",
        name: "Team Relay",
        providerId: "provider-1",
        providerName: "System3 Cloud",
      },
    ]);
    expect(result.folders).toEqual([
      {
        creatorId: "user-1",
        creatorName: "Alex",
        guid: "22222222-2222-2222-2222-222222222222",
        id: "folder-record-1",
        name: "Knowledge Base",
        private: false,
        relayGuid: "11111111-1111-1111-1111-111111111111",
        relayId: "relay-record-1",
        relayName: "Team Relay",
      },
    ]);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}
