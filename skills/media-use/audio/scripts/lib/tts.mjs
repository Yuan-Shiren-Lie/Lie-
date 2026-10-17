import { fetchMedia } from "../../../scripts/lib/media-fetch.mjs";
// tts.mjs — multi-provider TTS for the media audio engine. The provider chain,
// auto-detected from env, is the one documented in ../SKILL.md:
//
//   1. HeyGen (Starfish)  — $HEYGEN_API_KEY / $HYPERFRAMES_API_KEY / ~/.heygen.
//        Direct v3 REST (NOT `hyperframes tts`, which in the published build is
//        Kokoro-only and silently ignores a HeyGen key). Returns word_timestamps
//        in the same call, so no separate transcribe pass.
//   2. ElevenLabs         — $ELEVENLABS_API_KEY. Direct REST to /with-timestamps
//        (default model eleven_v4); character alignment gives word timings in
//        the same call, so no separate transcribe pass.
//   3. Kokoro-82M (local) — always available, via the published `hyperframes tts`
//        CLI. No word timings → caller chains transcribeWav().
//
// "HeyGen available" is decided by CREDENTIAL presence (heygenCredential), never
// by the CLI — see the note above.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { heygenAuthHeaders, heygenCredential, heygenJSON, heygenMessage } from "./heygen.mjs";
import { synthesizeGemini } from "./gemini-tts.mjs";
import { geminiConfigured } from "./gemini-auth.mjs";

// ── provider detection ────────────────────────────────────────────────────────
export function heygenAvailable() {
  return heygenCredential() !== null;
}
export function elevenlabsAvailable() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

// First available provider wins; an explicit choice is honored (and validated).
export function pickProvider(userProvider) {
  if (userProvider) {
    if (!["heygen", "elevenlabs", "kokoro", "gemini"].includes(userProvider))
      throw new Error(`invalid provider "${userProvider}" (heygen | elevenlabs | kokoro | gemini)`);
    if (userProvider === "gemini" && !geminiConfigured())
      throw new Error(
        "provider=gemini needs GEMINI_API_KEY or GOOGLE_API_KEY, or service-account credentials (GOOGLE_APPLICATION_CREDENTIALS or GCS_CREDS)",
      );
    // heygenAuthHeaders owns the reason and its fix: no credential, or a credentials path that cannot be read.
    if (userProvider === "heygen" && !heygenAvailable()) heygenAuthHeaders();
    if (userProvider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY)
      throw new Error("provider=elevenlabs but $ELEVENLABS_API_KEY is not set");
    return userProvider;
  }
  return heygenAvailable() ? "heygen" : elevenlabsAvailable() ? "elevenlabs" : "kokoro";
}

// ── voice resolution ──────────────────────────────────────────────────────────
// HeyGen /v3/voices/speech only accepts STARFISH voice_ids; auto-pick the first
// English public starfish voice when none is pinned. ElevenLabs/Kokoro have
// their own defaults.
export async function resolveVoiceId({ provider, userVoice, lang = "en" }) {
  if (userVoice) return userVoice;
  if (provider === "gemini") return "Kore";
  if (provider === "elevenlabs") return "21m00Tcm4TlvDq8ikWAM"; // Rachel
  if (provider === "kokoro") {
    if (lang === "en") return "am_michael";
    throw new Error("Kokoro non-English needs an explicit --voice (see references/tts.md)");
  }
  // heygen — pin a fixed English default so the choice is deterministic. The old
  // "first English voice the API returns" drifts whenever HeyGen re-sorts the
  // public catalog. Marcia (mature, low female). Override with --voice / request.voice.
  if (lang === "en") return "05f19352e8f74b0392a8f411eba40de1"; // Marcia · English · female
  // Non-English: no fixed default — fall back to the first matching catalog voice.
  const payload = await heygenJSON(`/voices?engine=starfish&type=public&limit=50`, {
    headers: heygenAuthHeaders(),
  });
  const voices = payload.data ?? payload.voices ?? [];
  const pick = voices.find((v) => v.language === "English") ?? voices[0];
  if (!pick) throw new Error("no public starfish voice to default to — pass --voice");
  return pick.voice_id;
}

// ── helpers ─────────────────────────────────────────────────────────────────
export function withWordIds(words) {
  return (words ?? []).map((w, i) => ({
    id: `w${i}`,
    text: w.text,
    start: w.start,
    end: w.end,
  }));
}

// `ffmpeg -i <file>` prints a `Duration: HH:MM:SS.ms` line to stderr even
// though it exits non-zero with no output requested. Parsing pulled out as
// a pure function so the ENOENT fallback below can be tested without
// depending on whether ffprobe/ffmpeg are actually installed on the
// machine running the tests.
export function parseFfmpegDurationBanner(stderrText) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrText ?? "");
  if (!match) return NaN;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// Some "essentials"-style ffmpeg distributions (common on Windows) ship
// ffmpeg.exe without ffprobe.exe. ffprobeDuration's caller (audio.mjs)
// otherwise reads a spurious NaN as "the WAV file is corrupt" and drops an
// already-successfully-synthesized TTS line, rather than "the tool for
// measuring it is missing".
function ffmpegDurationFallback(absPath) {
  const r = spawnSync("ffmpeg", ["-i", absPath], { encoding: "utf8" });
  return parseFfmpegDurationBanner(r.stderr);
}

export function ffprobeDuration(absPath) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", "--", absPath],
    { encoding: "utf8" },
  );
  if (r.error?.code === "ENOENT") return ffmpegDurationFallback(absPath);
  if (r.status !== 0) return NaN;
  return parseFloat(String(r.stdout).trim());
}

export function resolveNpxCliFromNpmExecPath(
  npmExecPath = process.env.npm_execpath,
  pathExists = existsSync,
) {
  if (!npmExecPath) return null;
  const fileName = npmExecPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const npxCliPath =
    fileName === "npx-cli.js" ? npmExecPath : join(dirname(npmExecPath), "npx-cli.js");
  return pathExists(npxCliPath) ? npxCliPath : null;
}

export function resolveNpxCliPath(
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.env.npm_node_execpath || process.execPath,
  pathExists = existsSync,
) {
  const fromNpm = resolveNpxCliFromNpmExecPath(npmExecPath, pathExists);
  if (fromNpm) return fromNpm;
  const besideNode = join(dirname(nodeExecPath), "node_modules", "npm", "bin", "npx-cli.js");
  return pathExists(besideNode) ? besideNode : null;
}

export function resolveSpawnCommand(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  env = process.env,
  pathExists = existsSync,
) {
  if (cmd !== "npx" || platform !== "win32") {
    return { cmd, args, opts: { stdio: "ignore", ...opts } };
  }

  // On Windows, npx resolves to npx.cmd, which Node cannot execute directly.
  // Avoid `shell:true` and the .cmd shim entirely by invoking npm's JS CLI with
  // node, preserving request-provided values as argv data instead of shell text.
  const nodeExecPath = env.npm_node_execpath || process.execPath;
  const npxCliPath = resolveNpxCliPath(env.npm_execpath, nodeExecPath, pathExists);
  if (!npxCliPath) return null;
  return {
    cmd: nodeExecPath,
    args: [npxCliPath, ...args.map((arg) => String(arg))],
    opts: { stdio: "ignore", windowsHide: true, ...opts },
  };
}

// `platform`/`spawnFn` params (default process.platform / the real spawn)
// exist so tests can exercise the win32 branch without mocking node:child_process
// (its ESM exports are non-configurable, so mock.method can't patch it).
// One-shot so a whole batch of TTS lines doesn't repeat the same diagnostic.
let _warnedNpxResolution = false;
/** Test-only: reset the one-shot npx-resolution warning latch. */
export function _resetNpxResolutionWarnForTests() {
  _warnedNpxResolution = false;
}

export function spawnP(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  spawnFn = spawn,
  env = process.env,
  pathExists = existsSync,
) {
  const resolved = resolveSpawnCommand(cmd, args, opts, platform, env, pathExists);
  if (!resolved) {
    // resolveSpawnCommand only returns null for the npx-on-win32 case where
    // neither npm's configured CLI nor the beside-node fallback exists. Without
    // this, every call silently returns status:-1 and stdio:"ignore" hides why.
    if (!_warnedNpxResolution) {
      _warnedNpxResolution = true;
      const reason = env.npm_execpath
        ? `npm_execpath (${env.npm_execpath}) and the beside-node npm fallback could not be found`
        : "npm_execpath is unset and the beside-node npm fallback could not be found";
      console.error(
        `[media-use] Cannot run "${cmd}" on Windows: ${reason}. ` +
          `Every "${cmd}" call is being skipped. Install npm with Node, or run via ` +
          `\`npx\`/\`npm run\` with a valid npm_execpath.`,
      );
    }
    return Promise.resolve({ status: -1 });
  }
  return new Promise((resolve) => {
    const p = spawnFn(resolved.cmd, resolved.args, resolved.opts);
    p.on("exit", (code) => resolve({ status: code ?? -1 }));
    p.on("error", () => resolve({ status: -1 }));
  });
}

// mp3/whatever bytes → wav 44.1k mono at destWav (ffmpeg detects true format).
function transcodeToWav(bytes, destWav) {
  const td = mkdtempSync(join(tmpdir(), "hf-tts-"));
  const tmp = join(td, "a.mp3");
  writeFileSync(tmp, bytes);
  mkdirSync(dirname(destWav), { recursive: true });
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", tmp, "-ar", "44100", "-ac", "1", destWav],
    { stdio: "ignore" },
  );
  rmSync(td, { recursive: true, force: true });
  return ff.status === 0 && existsSync(destWav);
}

export const ELEVENLABS_DEFAULT_MODEL = "eleven_v4";
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

// Character alignment → [{text,start,end}]. Audio tags such as [warm] are voiced
// as delivery cues but are not words, so they are dropped from the timings.
export function elevenlabsWords(alignment) {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  const words = [];
  let cur = null;
  let inTag = false;
  chars.forEach((ch, k) => {
    if (ch === "[") inTag = true;
    const gap = inTag || /\s/.test(ch);
    if (ch === "]") inTag = false;
    if (gap) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!isFinite(starts[k]) || !isFinite(ends[k])) return;
    if (cur) {
      cur.text += ch;
      cur.end = ends[k];
    } else cur = { text: ch, start: starts[k], end: ends[k] };
  });
  if (cur) words.push(cur);
  return words;
}

export async function synthesizeElevenLabs({ text, voiceId, lang, model, wavAbs }, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const transcode = deps.transcodeToWav ?? transcodeToWav;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, words: null, error: "$ELEVENLABS_API_KEY is not set" };
  const modelId = model || process.env.ELEVENLABS_MODEL_ID || ELEVENLABS_DEFAULT_MODEL;
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const post = (body) =>
    fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const body = { text, model_id: modelId };
    if (lang) body.language_code = lang;
    let res = await post(body);
    let detail = res.ok ? "" : await res.text();
    // Some models reject language_code; the text alone still sets the language.
    if (!res.ok && res.status === 400 && body.language_code && /language/i.test(detail)) {
      delete body.language_code;
      res = await post(body);
      detail = res.ok ? "" : await res.text();
    }
    if (!res.ok) {
      return {
        ok: false,
        words: null,
        error: `ElevenLabs ${modelId} HTTP ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const payload = await res.json();
    if (!payload.audio_base64) {
      return { ok: false, words: null, error: "ElevenLabs /with-timestamps returned no audio" };
    }
    const bytes = Buffer.from(payload.audio_base64, "base64");
    if (wavAbs.endsWith(".wav")) {
      if (!transcode(bytes, wavAbs)) {
        return { ok: false, words: null, error: "wav transcode failed (ffmpeg)" };
      }
    } else {
      mkdirSync(dirname(wavAbs), { recursive: true });
      writeFileSync(wavAbs, bytes);
    }
    return { ok: true, words: elevenlabsWords(payload.alignment ?? payload.normalized_alignment) };
  } catch (e) {
    return { ok: false, words: null, error: `ElevenLabs request failed: ${e?.message ?? e}` };
  }
}

// ── synthesize one line ───────────────────────────────────────────────────────
// Writes wav at wavAbs. Returns { ok, words, error } — words is the raw
// [{text,start,end}] array for HeyGen and ElevenLabs (native), or null for
// Kokoro/Gemini (caller must transcribeWav). Never throws; failures return { ok:false, error }
// where `error` states WHY (so the caller can surface it, not a bare "TTS failed").
export async function synthesizeOne({
  provider,
  text,
  voiceId,
  lang = "en",
  speed = 1.0,
  model,
  style,
  wavAbs,
  hyperframesDir,
}) {
  if (provider === "heygen") return synthesizeHeygen({ text, voiceId, lang, speed, wavAbs });
  if (provider === "gemini")
    return synthesizeGemini({ text, voiceId, model, style, speed, wavAbs });
  if (provider === "elevenlabs")
    return synthesizeElevenLabs({ text, voiceId, lang, model, wavAbs });
  // kokoro — via the published CLI; --output is relative to the project dir.
  const wavRel = relTo(hyperframesDir, wavAbs);
  return withTmpText(text, async (textPath) => {
    const args = ["hyperframes", "tts", textPath, "--voice", voiceId, "--output", wavRel];
    if (lang !== "en") args.push("--lang", lang);
    if (speed !== 1) args.push("--speed", String(speed));
    const r = await spawnP("npx", args, { cwd: hyperframesDir });
    return synthResult(r, wavAbs, "kokoro (npx hyperframes tts)");
  });
}

// Shape a spawn result into { ok, words, error }, naming why on failure so the
// caller surfaces it instead of a bare "TTS failed".
export function synthResult(r, wavAbs, label) {
  if (r.status === 0 && existsSync(wavAbs)) return { ok: true, words: null };
  const why =
    r.status !== 0 ? `${label} exited with status ${r.status}` : `${label} produced no wav file`;
  return { ok: false, words: null, error: why };
}

// `deps` is injectable for tests; production uses the real network/ffmpeg impls.
// Every failure path returns an `error` string so the caller can surface WHY a
// line was dropped instead of the bare "TTS failed" that hid the real cause
// (e.g. an HTTP 402 plan_upgrade_required thrown by heygenJSON was swallowed).
export async function synthesizeHeygen({ text, voiceId, lang, speed, wavAbs }, deps = {}) {
  const requestJSON = deps.heygenJSON ?? heygenJSON;
  const authHeaders = deps.heygenAuthHeaders ?? heygenAuthHeaders;
  const fetchImpl = deps.fetch ?? fetch;
  const transcode = deps.transcodeToWav ?? transcodeToWav;
  try {
    const body = { text, voice_id: voiceId, speed };
    if (lang !== "en") body.language = lang;
    const payload = await requestJSON(`/voices/speech`, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const inner = payload.data ?? payload;
    if (!inner.audio_url) {
      return { ok: false, words: null, error: "HeyGen /voices/speech returned no audio_url" };
    }
    const res = await fetchMedia(inner.audio_url, { fetchImpl });
    if (!res.ok) {
      return { ok: false, words: null, error: `audio_url fetch failed: HTTP ${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // .wav output → transcode to 44.1k mono; .mp3 → raw bytes (no ffmpeg). The
    // engine always asks for .wav; the standalone heygen-tts CLI may ask for .mp3.
    if (wavAbs.endsWith(".wav")) {
      if (!transcode(bytes, wavAbs)) {
        return {
          ok: false,
          words: null,
          error: "wav transcode failed (ffmpeg)",
        };
      }
    } else {
      mkdirSync(dirname(wavAbs), { recursive: true });
      writeFileSync(wavAbs, bytes);
    }
    const words = Array.isArray(inner.word_timestamps)
      ? inner.word_timestamps
          .filter((w) => w && typeof w.word === "string" && isFinite(w.start) && isFinite(w.end))
          .filter((w) => !/^<.*>$/.test(w.word.trim())) // drop <start>/<end> sentinels
          .map((w) => ({ text: w.word, start: w.start, end: w.end }))
      : [];
    return { ok: true, words };
  } catch (e) {
    return { ok: false, words: null, error: heygenMessage(e) };
  }
}

// Kokoro/Gemini have no word timings — run Whisper over the wav. Returns the
// flat [{id,text,start,end}] word array, or null. Each call uses a throwaway
// --dir so parallel scenes don't collide on transcript.json.
export async function transcribeWav({ wavRel, lang = "en", hyperframesDir }) {
  const model = lang === "en" ? "small.en" : "small";
  const td = mkdtempSync(join(tmpdir(), "hf-trans-"));
  const args = ["hyperframes", "transcribe", wavRel, "--model", model, "--dir", td];
  if (lang !== "en") args.push("--language", lang);
  const r = await spawnP("npx", args, { cwd: hyperframesDir });
  let words = null;
  if (r.status === 0) {
    const src = join(td, "transcript.json");
    if (existsSync(src)) {
      try {
        const arr = JSON.parse(readFileSync(src, "utf8"));
        if (Array.isArray(arr) && arr.length) words = arr;
      } catch {}
    }
  }
  rmSync(td, { recursive: true, force: true });
  return words;
}

// ── tiny local utils ──────────────────────────────────────────────────────────
async function withTmpText(text, run) {
  const td = mkdtempSync(join(tmpdir(), "hf-txt-"));
  try {
    const p = join(td, "line.txt");
    writeFileSync(p, text);
    return await run(p);
  } finally {
    // Cleanup must preserve the synthesis result or the original write/spawn error.
    try {
      rmSync(td, { recursive: true, force: true });
    } catch {}
  }
}
function relTo(base, abs) {
  return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
}
