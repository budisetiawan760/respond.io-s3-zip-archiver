/**
 * S3 ZIP Archiver: Lambda handler.
 *
 * Trigger: S3 ObjectCreated on the archive bucket (filtered to *.json in template.yaml).
 * For each new object: download it, zip it, upload <key>.zip to the same bucket,
 * verify the zip landed, then delete the original.
 *
 * Why each safeguard exists:
 *   - Loop guard: the .zip we upload is itself a new object. Without the guard,
 *     it would trigger this function again, forever.
 *   - Version-pinned read/delete: two uploads of the same key can run in parallel.
 *     Pinning to the event's versionId means each run touches only its own upload.
 *     On a versioned bucket, deleting a specific version also removes it for good,
 *     instead of leaving a hidden copy behind a delete marker.
 *   - Verify before delete: the original is removed only after HeadObject proves
 *     the zip exists with the expected size. A failed upload never loses data.
 *   - Rethrow on error: the invocation is marked failed, so Lambda retries it.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import archiver from "archiver";

// Created once per container and reused across invocations (keeps connections warm).
const s3 = new S3Client({});
const ZIP_SUFFIX = ".zip";

// S3 invokes this asynchronously and discards the return value, so results go to the logs.
const log = (key, status, extra = {}) => console.log(JSON.stringify({ key, status, ...extra }));

export const lambdaHandler = async (event) => {
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    // S3 URL-encodes keys in events and turns spaces into "+".
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    // Present only when bucket versioning is on. undefined = "latest", and the SDK drops it.
    const versionId = record.s3.object.versionId;

    if (key.endsWith(ZIP_SUFFIX)) {
      log(key, "skipped_already_zip");
      continue;
    }

    try {
      const zipKey = await archiveObject(bucket, key, versionId);
      log(key, "ok", { zipKey });
    } catch (err) {
      // S3 can deliver the same event twice. If the original is already gone,
      // an earlier run archived it. Nothing to do, and retrying would never succeed.
      if (err.name === "NoSuchKey" || err.name === "NoSuchVersion") {
        log(key, "skipped_already_archived");
        continue;
      }
      console.error(`Failed processing s3://${bucket}/${key}`, err);
      throw err;
    }
  }
};

async function archiveObject(bucket, key, versionId) {
  const zipKey = `${key}${ZIP_SUFFIX}`;

  // 1. Download. transformToByteArray() reads the whole response stream into memory.
  // ponytail: in-memory, tested to 80 MB at 512 MB. Beyond that, stream through
  // @aws-sdk/lib-storage Upload so memory stays flat.
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })
  );
  const data = Buffer.from(await obj.Body.transformToByteArray());

  // 2. Zip. The entry inside the archive keeps the original file name.
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.append(data, { name: path.basename(key) });
  const [zip] = await Promise.all([buffer(archive), archive.finalize()]);

  // 3. Upload. Same folder, original name + ".zip".
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: zipKey,
      Body: zip,
      ContentType: "application/zip",
    })
  );

  // 4. Verify. Check the uploaded size matches the bytes we sent.
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: zipKey }));
  if (head.ContentLength !== zip.length) {
    throw new Error(
      `Zip verification failed for ${zipKey}: expected ${zip.length} bytes, got ${head.ContentLength}`
    );
  }

  // 5. Delete the exact version we archived. Never a newer upload of the same key.
  await s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })
  );

  return zipKey;
}
