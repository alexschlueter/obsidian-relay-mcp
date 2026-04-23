import { describe, expect, it } from "vitest";
import { S3RN, S3RemoteDocument, S3RemoteFile, S3RemoteFolder } from "../src/relay-client/s3rn";

const relayId = "11111111-1111-1111-1111-111111111111";
const folderId = "22222222-2222-2222-2222-222222222222";
const docId = "33333333-3333-3333-3333-333333333333";
const fileId = "44444444-4444-4444-4444-444444444444";

describe("S3RN", () => {
  it("round-trips folder and document resources", () => {
    const folder = new S3RemoteFolder(relayId, folderId);
    const document = new S3RemoteDocument(relayId, folderId, docId);

    expect(S3RN.decode(S3RN.encode(folder))).toEqual(folder);
    expect(S3RN.decode(S3RN.encode(document))).toEqual(document);
  });

  it("computes compound document ids at the transport boundary", () => {
    const file = new S3RemoteFile(relayId, folderId, fileId);
    expect(S3RN.getCompoundDocumentId(file)).toBe(`${relayId}-${fileId}`);
  });
});
