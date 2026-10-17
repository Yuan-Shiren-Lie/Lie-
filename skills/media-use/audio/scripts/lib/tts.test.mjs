import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFfmpegDurationBanner,
  ffprobeDuration,
  synthesizeOne,
  synthesizeHeygen,
  synthesizeElevenLabs,
  elevenlabsWords,
  synthResult,
  pickProvider,
} from "./tts.mjs";

test("parseFfmpegDurationBanner reads ffmpeg's stderr Duration line", () => {
  const stderr = [
    "ffmpeg version 6.0",
    "Input #0, wav, from 'a.wav':",
    "  Duration: 00:00:03.42, bitrate: 705 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  assert.equal(parseFfmpegDurationBanner(stderr), 3.42);
});

test("parseFfmpegDurationBanner handles an hours component", () => {
  const stderr = "  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s";
  assert.equal(parseFfmpegDurationBanner(stderr), 3723.5);
});

test("parseFfmpegDurationBanner returns NaN when there is no Duration line", () => {
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("ffmpeg: command not found")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner(undefined)));
});

// Regression for the actual bug: ffprobeDuration used to collapse "ffprobe
// binary is missing" (ENOENT — the "essentials"-style Windows ffmpeg build
// with no ffprobe.exe) and "file is genuinely unreadable" into the same NaN,
// giving audio.mjs no way to tell "measure differently" from "give up".
//
// Builds an isolated PATH containing only a fake `ffmpeg` stub (no `ffprobe`
// at all) so ffprobeDuration's spawnSync("ffprobe", ...) call ENOENTs for
// real, then verifies it recovers the duration via the ffmpeg fallback
// instead of returning NaN.
test("ffprobeDuration falls back to ffmpeg when the ffprobe binary itself is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-ffprobe-fallback-"));
  const fakeFfmpeg = join(dir, "ffmpeg");
  writeFileSync(
    fakeFfmpeg,
    "#!/bin/sh\necho 'Duration: 00:00:02.50, start: 0.000000, bitrate: 128 kb/s' 1>&2\nexit 1\n",
  );
  chmodSync(fakeFfmpeg, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // only the fake ffmpeg resolves; no real ffprobe on this PATH
    assert.equal(ffprobeDuration("/does/not/matter.wav"), 2.5);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffprobeDuration returns NaN when neither ffprobe nor ffmpeg resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-no-binaries-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // empty directory — nothing resolves
    assert.ok(Number.isNaN(ffprobeDuration("/does/not/matter.wav")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

function alignmentFor(text, step = 0.05) {
  const chars = [...text];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, k) => k * step),
    character_end_times_seconds: chars.map((_, k) => (k + 1) * step),
  };
}

function elevenlabsResponse(text, status = 200) {
  return {
    ok: status === 200,
    status,
    text: async () => (status === 200 ? "" : `{"detail":"language_code not supported"}`),
    json: async () => ({
      audio_base64: Buffer.from("mp3").toString("base64"),
      alignment: alignmentFor(text),
    }),
  };
}

async function withElevenLabsKey(run) {
  const saved = process.env.ELEVENLABS_API_KEY;
  const savedModel = process.env.ELEVENLABS_MODEL_ID;
  process.env.ELEVENLABS_API_KEY = "test-key";
  delete process.env.ELEVENLABS_MODEL_ID;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = saved;
    if (savedModel !== undefined) process.env.ELEVENLABS_MODEL_ID = savedModel;
  }
}

test("elevenlabsWords keeps audio tags out of the word timings", () => {
  const words = elevenlabsWords(alignmentFor("[slightly wry] It worked."));
  assert.deepEqual(
    words.map((w) => w.text),
    ["It", "worked."],
  );
  assert.equal(words[0].start, 15 * 0.05);
  assert.equal(words[1].end, 25 * 0.05);
});

test("synthesizeElevenLabs calls /with-timestamps with eleven_v4 and returns native words", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), key: init.headers["xi-api-key"] });
    return elevenlabsResponse("[warm] Built in Rust.");
  };
  let transcoded = null;
  const transcodeToWav = (bytes, dest) => ((transcoded = { bytes: String(bytes), dest }), true);
  const res = await withElevenLabsKey(() =>
    synthesizeElevenLabs(
      { text: "[warm] Built in Rust.", voiceId: "voice/1", lang: "es", wavAbs: "/x/line.wav" },
      { fetch, transcodeToWav },
    ),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.words.map((w) => w.text),
    ["Built", "in", "Rust."],
  );
  assert.match(calls[0].url, /\/text-to-speech\/voice%2F1\/with-timestamps\?/);
  assert.deepEqual(calls[0].body, {
    text: "[warm] Built in Rust.",
    model_id: "eleven_v4",
    language_code: "es",
  });
  assert.equal(calls[0].key, "test-key");
  assert.deepEqual(transcoded, { bytes: "mp3", dest: "/x/line.wav" });
});

test("synthesizeElevenLabs honors an explicit model and retries without a rejected language_code", async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return elevenlabsResponse("Hola.", body.language_code ? 400 : 200);
  };
  const res = await withElevenLabsKey(() =>
    synthesizeElevenLabs(
      { text: "Hola.", voiceId: "v", lang: "es", model: "eleven_flash_v2", wavAbs: "/x/a.wav" },
      { fetch, transcodeToWav: () => true },
    ),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(bodies, [
    { text: "Hola.", model_id: "eleven_flash_v2", language_code: "es" },
    { text: "Hola.", model_id: "eleven_flash_v2" },
  ]);
});

test("synthesizeElevenLabs writes mp3 output into a fresh directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-el-mp3-"));
  try {
    const out = join(dir, "assets", "voice", "line.mp3");
    const res = await withElevenLabsKey(() =>
      synthesizeElevenLabs(
        { text: "Hi.", voiceId: "v", wavAbs: out },
        { fetch: async () => elevenlabsResponse("Hi.") },
      ),
    );
    assert.equal(res.ok, true);
    assert.equal(readFileSync(out, "utf8"), "mp3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeElevenLabs reports a missing key and HTTP failures", async () => {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    const res = await synthesizeOne({
      provider: "elevenlabs",
      text: "hi",
      voiceId: "v",
      wavAbs: "/x/a.wav",
    });
    assert.deepEqual(res, { ok: false, words: null, error: "$ELEVENLABS_API_KEY is not set" });
  } finally {
    if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
  }
  const res = await withElevenLabsKey(() =>
    synthesizeElevenLabs(
      { text: "hi", voiceId: "v", wavAbs: "/x/a.wav" },
      { fetch: async () => ({ ok: false, status: 401, text: async () => "invalid_api_key" }) },
    ),
  );
  assert.deepEqual(res, {
    ok: false,
    words: null,
    error: "ElevenLabs eleven_v4 HTTP 401: invalid_api_key",
  });
});

test("synthesizeHeygen surfaces a thrown HTTP error (e.g. 402) instead of swallowing it", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => {
        throw new Error("HeyGen POST /voices/speech → HTTP 402\nplan_upgrade_required");
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /402/);
  assert.match(res.error, /plan_upgrade_required/);
});

test("synthesizeHeygen surfaces a failed audio_url fetch with its status", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
      fetch: async () => ({ ok: false, status: 403 }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 403/);
});

test("synthesizeHeygen reports a missing audio_url", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    { heygenAuthHeaders: () => ({}), heygenJSON: async () => ({}) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio_url/);
});

test("synthesizeHeygen reports wav transcode failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-tts-test-"));
  try {
    const res = await synthesizeHeygen(
      { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: join(dir, "voice.wav") },
      {
        heygenAuthHeaders: () => ({}),
        heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
        transcodeToWav: () => false,
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "wav transcode failed (ffmpeg)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthResult names a non-zero subprocess exit", () => {
  const res = synthResult({ status: 2 }, "/tmp/none.wav", "kokoro (npx hyperframes tts)");
  assert.equal(res.ok, false);
  assert.match(res.error, /kokoro .* exited with status 2/);
});

// Kokoro shells out to `npx hyperframes tts`; a fake npx on PATH records the argv
// synthesizeOne really builds, so a dropped flag fails here. Windows runs npx via
// node directly, so the stub never resolves there.
async function kokoroArgv(options) {
  const dir = mkdtempSync(join(tmpdir(), "tts-kokoro-argv-"));
  const argvLog = join(dir, "argv.txt");
  writeFileSync(join(dir, "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\n`);
  chmodSync(join(dir, "npx"), 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    await synthesizeOne({
      provider: "kokoro",
      text: "hi",
      voiceId: "am_michael",
      wavAbs: join(dir, "line-0.wav"),
      hyperframesDir: dir,
      ...options,
    });
    return readFileSync(argvLog, "utf8").trim().split("\n");
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "synthesizeOne(kokoro) forwards a non-default speed to the CLI",
  { skip: process.platform === "win32" },
  async () => {
    const argv = await kokoroArgv({ speed: 0.8, lang: "es" });
    assert.deepEqual(argv.slice(-4), ["--lang", "es", "--speed", "0.8"]);
  },
);

test(
  "synthesizeOne(kokoro) leaves --speed off at the default",
  { skip: process.platform === "win32" },
  async () => {
    assert.ok(!(await kokoroArgv({})).includes("--speed"));
  },
);

test("pickProvider heygen with an unreadable credentials path says to fix that path", () => {
  const saved = ["HEYGEN_API_KEY", "HYPERFRAMES_API_KEY", "HEYGEN_CONFIG_DIR"].map((k) => [
    k,
    process.env[k],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "tts-cred-"));
  try {
    delete process.env.HEYGEN_API_KEY;
    delete process.env.HYPERFRAMES_API_KEY;
    process.env.HEYGEN_CONFIG_DIR = dir;
    mkdirSync(join(dir, "credentials"));
    assert.throws(() => pickProvider("heygen"), /fix or remove that path/);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
