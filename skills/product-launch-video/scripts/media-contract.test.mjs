import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("frame worker documents the approved video-hoist contract", () => {
  const instructions = readFileSync(join(skillDir, "sub-agents", "frame-worker.md"), "utf8");

  assert.match(instructions, /data-frame-video="approved"/);
  assert.match(instructions, /assemble-index\.mjs.*hoists it to the host root/i);
  assert.match(instructions, /Audio remains orchestrator-owned/i);
});

test("assemble hoists an approved timed frame video to the host root", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-"));
  mkdirSync(join(project, "compositions"));
  const framePath = join(project, "compositions", "frame-1.html");
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1 — Demo\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    framePath,
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video data-frame-video="approved" data-frame-video-x="0" data-frame-video-y="0" data-frame-video-width="1920" data-frame-video-height="1080" src="https://cdn.example/clip.mp4" poster="poster.png" preload="auto" muted playsinline loop style="background:url(https://evil.example/x)" nonce="unsafe" onerror="alert(1)" srcdoc="<script>alert(2)</script>" data-start="0.25" data-duration="1.5" data-media-start="12.75" data-track-index="7"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(project, "index.html"), "utf8");
  const frame = readFileSync(framePath, "utf8");
  assert.match(index, /data-start="0\.25"/);
  assert.match(index, /data-duration="1\.5"/);
  assert.match(index, /data-media-start="12\.75"/);
  assert.match(index, /data-track-index="1007"/);
  assert.match(index, /src="https:\/\/cdn\.example\/clip\.mp4"/);
  assert.match(index, /poster="poster\.png"/);
  assert.match(index, /preload="auto"/);
  assert.match(index, /\smuted(?:\s|>)/);
  assert.match(index, /\splaysinline(?:\s|>)/);
  assert.match(index, /\sloop(?:\s|>)/);
  assert.doesNotMatch(index, /onerror=/i);
  assert.doesNotMatch(index, /srcdoc=/i);
  assert.doesNotMatch(index, /nonce=/i);
  assert.match(
    index,
    /style="position:absolute;left:0px;top:0px;width:1920px;height:1080px;object-fit:cover"/,
  );
  assert.doesNotMatch(frame, /<video\b/i);
});

const storyboardEntry = (n) =>
  `\n## Frame ${n}\n- status: built\n- duration: 2s\n- src: compositions/frame-${n}.html\n`;
const storyboard = (...frames) => `---\nformat: 16:9\n---\n${frames.map(storyboardEntry).join("")}`;
const hoistableAttrs = [
  'data-frame-video="approved"',
  'data-frame-video-x="0" data-frame-video-y="0"',
  'data-frame-video-width="960" data-frame-video-height="540"',
  'src="clip.mp4" data-start="0" data-duration="1" data-track-index="0"',
].join(" ");
const hoistable = (id) => `<video${id ? ` id="${id}"` : ""} ${hoistableAttrs}></video>`;
const frameHtml = (n, body) =>
  `<html><body><div id="root" data-composition-id="frame-${n}" data-width="1920" data-height="1080">${body}</div>` +
  `<script>window.__timelines = {}; window.__timelines["frame-${n}"] = gsap.timeline();</script></body></html>`;

test("assemble gives every hoisted video a document-unique id", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-ids-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(join(project, "STORYBOARD.md"), storyboard(1, 2));
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    frameHtml(1, hoistable() + hoistable() + hoistable("demo")),
  );
  writeFileSync(join(project, "compositions", "frame-2.html"), frameHtml(2, hoistable("demo")));

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(project, "index.html"), "utf8");
  const ids = [...index.matchAll(/<video id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["el-frame-1-video-0", "el-frame-1-video-1", "demo", "demo-2"]);
});

test("assemble isolates each frame host so its hoisted video stays on top", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-layer-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(join(project, "STORYBOARD.md"), storyboard(1));
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    frameHtml(1, '<div style="position:absolute;inset:0;z-index:5"></div>' + hoistable()),
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(project, "index.html"), "utf8");
  assert.match(index, /\.scene \{[^}]*isolation: isolate;[^}]*\}/);
  assert.ok(index.indexOf('class="scene"') < index.indexOf("<video "));
});

test("assemble preserves approved-video geometry through sanitized host CSS", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-layout-"));
  mkdirSync(join(project, "compositions"));
  const framePath = join(project, "compositions", "frame-1.html");
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    framePath,
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video class="clip approved-demo" data-frame-video="approved" data-frame-video-x="120" data-frame-video-y="240" data-frame-video-width="960" data-frame-video-height="540" data-frame-video-fit="cover" src="clip.mp4" style="position:fixed;background:url(https://evil.example/x)" nonce="unsafe" onerror="alert(1)" srcdoc="<script>alert(2)</script>" data-start="0" data-duration="1" data-track-index="7"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(project, "index.html"), "utf8");
  assert.match(
    index,
    /style="position:absolute;left:120px;top:240px;width:960px;height:540px;object-fit:cover"/,
  );
  assert.doesNotMatch(index, /approved-demo/);
  assert.doesNotMatch(index, /evil\.example/);
  assert.doesNotMatch(index, /position:fixed/);
  assert.doesNotMatch(index, /data-frame-video-(?:x|y|width|height|fit)=/);
  assert.doesNotMatch(index, /onerror=|srcdoc=|nonce=/i);
  assert.doesNotMatch(readFileSync(framePath, "utf8"), /<video\b/i);
});

test("rejects partial or unsafe approved-video layout geometry", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-layout-invalid-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video data-frame-video="approved" data-frame-video-x="0" data-frame-video-y="0" data-frame-video-width="calc(100% + 1px)" data-frame-video-height="1080" data-frame-video-fit="cover" src="clip.mp4" data-start="0" data-duration="1" data-track-index="0"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved frame video layout.*finite numeric/i);
  assert.equal(existsSync(join(project, "index.html")), false);
});

test("rejects an approved video without mandatory layout geometry", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-layout-missing-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video data-frame-video="approved" src="clip.mp4" data-start="0" data-duration="1" data-track-index="0"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved frame video layout.*finite numeric/i);
  assert.equal(existsSync(join(project, "index.html")), false);
});

test("rejects empty approved-video layout coordinates", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-layout-empty-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video data-frame-video="approved" data-frame-video-x="" data-frame-video-y="0" data-frame-video-width="1920" data-frame-video-height="1080" src="clip.mp4" data-start="0" data-duration="1" data-track-index="0"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );

  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved frame video layout.*finite numeric/i);
  assert.equal(existsSync(join(project, "index.html")), false);
});

test("rejects an approved video with missing admission timing", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-missing-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"><video data-frame-video="approved" src="clip.mp4" data-duration="1" data-track-index="0"></video></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline();</script></body></html>`,
  );
  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must declare quoted data-start/i);
});

test("does not hoist declarations hidden in comments or scripts", () => {
  const project = mkdtempSync(join(tmpdir(), "hf-frame-video-hidden-"));
  mkdirSync(join(project, "compositions"));
  writeFileSync(
    join(project, "STORYBOARD.md"),
    "---\nformat: 16:9\n---\n\n## Frame 1\n- status: built\n- duration: 2s\n- src: compositions/frame-1.html\n",
  );
  writeFileSync(
    join(project, "compositions", "frame-1.html"),
    `<html><body><div id="root" data-composition-id="frame-1" data-width="1920" data-height="1080"></div><script>window.__timelines = {}; window.__timelines["frame-1"] = gsap.timeline(); const s = '<video data-frame-video="approved" data-start="0" data-duration="1" data-track-index="1"></video>';</script><!-- <video data-frame-video="approved" data-start="0" data-duration="1" data-track-index="2"></video> --></body></html>`,
  );
  const result = spawnSync(
    process.execPath,
    [join(skillDir, "scripts", "assemble-index.mjs"), "--hyperframes", project],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(join(project, "index.html"), "utf8"), /data-track-index="1001"/);
});
