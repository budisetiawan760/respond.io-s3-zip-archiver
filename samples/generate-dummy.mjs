/**
 * Dummy data generator: mimics the "video processing result in JSON" from the task scenario.
 * Usage:
 *   node generate-dummy.mjs                 -> result.json (2000 scenes by default)
 *   node generate-dummy.mjs 50 tiny.json    -> 50 scenes into tiny.json
 *   node generate-dummy.mjs 20000 big.json  -> large file for compression testing
 */
import { writeFileSync } from "node:fs";

const sceneCount = Number(process.argv[2] ?? 2000);
const outFile = process.argv[3] ?? "result.json";

const LABELS = ["intro", "product", "face", "logo", "text_overlay", "transition", "outro"];
const rand = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const doc = {
  schema_version: "1.2",
  video_id: `vid_${Math.random().toString(36).slice(2, 10)}`,
  source_file: "s3://on-prem-export/raw/clip_0042.mp4",
  processed_at: new Date().toISOString(),
  duration_sec: rand(30, 3600),
  resolution: pick(["1280x720", "1920x1080", "3840x2160"]),
  fps: pick([24, 30, 60]),
  scenes: Array.from({ length: sceneCount }, (_, i) => ({
    idx: i,
    t_start: i * 2,
    t_end: i * 2 + 2,
    label: pick(LABELS),
    confidence: rand(0.7, 0.99),
    bbox: [
      Math.floor(Math.random() * 1920),
      Math.floor(Math.random() * 1080),
      Math.floor(Math.random() * 400),
      Math.floor(Math.random() * 300),
    ],
    tags: [pick(LABELS), pick(LABELS)],
  })),
};

const out = JSON.stringify(doc, null, 2);
writeFileSync(outFile, out);
console.log(`${outFile}: ${sceneCount} scenes, ${(out.length / 1024).toFixed(1)} KB`);
