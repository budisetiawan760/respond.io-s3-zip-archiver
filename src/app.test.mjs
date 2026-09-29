// Run: node --test   (from src/). Fakes S3 by patching S3Client.send; no AWS needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { lambdaHandler } from "./app.mjs";

const event = (key, versionId = "v1") => ({
  Records: [{ s3: { bucket: { name: "b" }, object: { key, versionId } } }],
});

// Replays a fake S3. `head` lets a test lie about the uploaded size.
function fakeS3({ getError, head } = {}) {
  const calls = [];
  let uploaded;
  S3Client.prototype.send = async (cmd) => {
    const name = cmd.constructor.name;
    calls.push({ name, input: cmd.input });
    if (name === "GetObjectCommand") {
      if (getError) throw Object.assign(new Error(getError), { name: getError });
      return { Body: { transformToByteArray: async () => Buffer.from('{"a":1}') } };
    }
    if (name === "PutObjectCommand") uploaded = cmd.input.Body;
    if (name === "HeadObjectCommand") return { ContentLength: head ?? uploaded.length };
    return {};
  };
  return { calls, uploaded: () => uploaded };
}

// The handler reports each file's status on stdout. Capture it for assertions.
async function run(evt) {
  const lines = [];
  const orig = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try { await lambdaHandler(evt); } finally { console.log = orig; }
  return lines;
}

test("zips, uploads next to the original, then deletes the exact version", async () => {
  const s3 = fakeS3();
  const [line] = await run(event("ABC/metadata.json"));
  assert.deepEqual(line, { key: "ABC/metadata.json", status: "ok", zipKey: "ABC/metadata.json.zip" });
  assert.deepEqual(s3.calls.map((c) => c.name), [
    "GetObjectCommand", "PutObjectCommand", "HeadObjectCommand", "DeleteObjectCommand",
  ]);
  assert.equal(s3.calls[0].input.VersionId, "v1");
  assert.equal(s3.calls[1].input.Key, "ABC/metadata.json.zip");
  assert.equal(s3.uploaded().subarray(0, 2).toString(), "PK"); // real zip header
  assert.deepEqual(s3.calls[3].input, { Bucket: "b", Key: "ABC/metadata.json", VersionId: "v1" });
});

test("decodes S3 event keys (spaces arrive as +)", async () => {
  const s3 = fakeS3();
  await run(event("ABC/my+file%281%29.json"));
  assert.equal(s3.calls[0].input.Key, "ABC/my file(1).json");
});

test("ignores .zip objects so it never triggers itself", async () => {
  const s3 = fakeS3();
  const [line] = await run(event("ABC/metadata.json.zip"));
  assert.equal(s3.calls.length, 0);
  assert.equal(line.status, "skipped_already_zip");
});

test("keeps the original when the zip size does not match", async () => {
  const s3 = fakeS3({ head: 1 });
  await assert.rejects(lambdaHandler(event("ABC/metadata.json")), /verification failed/);
  assert.ok(!s3.calls.some((c) => c.name === "DeleteObjectCommand"));
});

test("duplicate event for an already-archived version is skipped, not retried", async () => {
  fakeS3({ getError: "NoSuchVersion" });
  const [line] = await run(event("ABC/metadata.json"));
  assert.equal(line.status, "skipped_already_archived");
});

test("other S3 errors are rethrown so Lambda retries", async () => {
  fakeS3({ getError: "AccessDenied" });
  await assert.rejects(lambdaHandler(event("ABC/metadata.json")), /AccessDenied/);
});
