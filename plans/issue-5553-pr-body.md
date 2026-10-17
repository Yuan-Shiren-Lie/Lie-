# PR title

```
feat(studio-server): support png-sequence from the Studio render route (#5553)
```

---

# PR body

> **Status: design-direction request.** This PR contains no code. Its purpose is to record the maintainer's call on five design questions before implementation begins. The implementation will land in a follow-up PR that references this one.

## What

Widen the Studio render route and its two adapter hosts so `format: "png-sequence"` works the same way `mp4` / `webm` / `mov` does today. The producer side already supports it; the route does not. The wire-shape decisions are the entire reason this PR exists.

## Why

The producer pipeline already renders png-sequence as a directory of `frame_NNNNNN.png` plus an optional `audio.m4a` sidecar. The CLI's render command already accepts `--format png-sequence` and writes directory outputs. Studio's render route does not, because every part of the route is single-file-shaped:

- `packages/studio-server/src/routes/render.ts:111-113` — request validation accepts only `mp4|webm|mov`.
- `packages/studio-server/src/routes/render.ts:154` — `outputPath = join(rendersDir, '${jobId}.mp4')` builds a file path, not a directory.
- `packages/studio-server/src/routes/render.ts:24, 26-35` — DELETE's `resolveRenderArtifacts` whitelist is `*.mp4 | *.webm | *.mov | *.meta.json`.
- `packages/studio-server/src/routes/render.ts:331-332` — `GET /projects/:id/renders` filters `readdirSync` to those three extensions.
- `packages/studio-server/src/types.ts:164` — the `StudioApiAdapter.startRender.format` union is the same three-member shape.

A Studio user asking for `format: "png-sequence"` today gets no listing row, no download endpoint, a DELETE that quietly tries to unlink a non-existent file extension, and an adapter contract that won't accept the format string.

## Related work

- Fixes heygen-com/hyperframes#5553
- Producer's directory-write path is the source of truth on writing side: `packages/producer/src/services/render/artifactTransaction.ts:2882-2886` (transaction with `kind: "directory"`) and `packages/producer/src/services/render/stages/encodeStage.ts:283-313` (PNG-sequence copy + `audio.m4a` sidecar).
- CLI's existing directory-output treatment is the precedent for the listing/delivery shape: `packages/cli/src/commands/render.ts:1892-1906` and `packages/cli/src/commands/render/plan.ts:42-62`.
- Existing path-safety helpers the implementation will reuse: `packages/studio-server/src/helpers/safePath.ts:24-79`. The file-traversal defence already tests on the existing file branch at `packages/studio-server/src/routes/renderDeletion.test.ts:103-112, 114-134`.

## How — five design questions for the maintainer

The implementation branches into roughly 12 files.

### Q1 — On-disk shape of a completed render

The producer publishes a directory. The route has to either (a) keep the directory as-is or (b) wrap it in a zip.

- **A. Directory named by job id.** `renders/<jobId>/{frame_*.png, audio.m4a}`. Route's listing / view / download / delete branches learn the directory shape; the on-disk state matches what the CLI does today.
- **B. Single zip written at completion.** Wrapper step zips the directory into `renders/<jobId>.zip`. Route's view / download code paths reuse single-file assumptions; listing gains a `*.zip` filter.

What changes either way: nothing in the producer. The widening is entirely in the route + two adapter hosts.

**My recommendation: A.** It matches the CLI precedent (`packages/cli/src/commands/render/plan.ts:42-62` already plans `png-sequence: ""` as a directory) and the producer already does the work.

- **Pros.**
  - Zero producer change. `ArtifactTransaction(kind: "directory")` already implements atomic directory publish at `packages/producer/src/services/renderOrchestrator.ts:2882-2886`, and `encodeStage.ts:283-313` already writes `frame_NNNNNN.png` plus `audio.m4a` into `outputPath`. The route just hands the directory path in unchanged.
  - Mental model is identical to the CLI's existing directory output. The CLI's `formatRenderSummaryDetail` at `packages/cli/src/ui/format.ts:21-25` already reports frame count for directory output today; nothing new for maintainers to remember.
  - Consumer tools read directly. After Effects, Nuke / Fusion, and `ffmpeg -i frame_%06d.png` glob the directory path — no unpack step.
- **Cons.**
  - The on-disk size of a directory is its inode size, not its deliverable footprint. The listing endpoint must report a *summed* `sizeBytes` (the workaround the CLI comment at `packages/cli/src/commands/render.ts:1894-1906` already documents).
  - Every other route endpoint — view, download, file/*, and DELETE — has to learn the directory shape. That's 4 endpoint branches in `packages/studio-server/src/routes/render.ts` plus the two `removeCancelledOutput` adapters below.
- **Trade-offs accepted.**
  - Producer remains a write-once directory source-of-truth. Rollback happens via `ArtifactTransaction.rollback()` at `packages/producer/src/services/render/artifactTransaction.ts:404-415` which already uses `rmSync(..., { recursive: true, force: true })` — same idiom the route will reuse.
  - Listing-directory size is a computed field, not a `statSync(...).size` read. Acceptable because the CLI precedent (`packages/cli/src/commands/render.ts:1892-1906`) shows how to sum nested-file bytes.

### Q2 — Listing payload format

Today the listing entry shape is one object. A directory render needs additional facts.

- **A. Discriminated union.** Each entry carries `kind: "file" | "directory"` (or omitted for back-compat). Directory entries add `frameCount`, summed `sizeBytes`, `audioSidecar` (whether an `audio.m4a` is present, defined in `packages/engine/src/services/audioMixer.ts:64`).
- **B. Reuse the CLI pattern.** Sum contained file sizes for `sizeBytes`; pre-compute `frameCount` from `readdirSync(<dir>)` per request. No schema change to the existing entries, but every listing call does directory I/O.

What changes either way: `RenderJobState` gains `kind?: "file" | "directory"` (per the resolution recorded at the end of this PR).

**My recommendation: A.** Option B requires walking every render directory on every list call, which is O(N) synchronous I/O today (the route already imports `readdirSync` + `statSync` at `packages/studio-server/src/routes/render.ts:3, 331, 338`).

- **Pros.**
  - Listing stays O(1) per entry at response time. Once the sidecar carries `frameCount` and `sizeBytes`, the route reads them once and returns — no per-request directory walk.
  - Backward-compat is automatic. The current sidecar reading path at `packages/studio-server/src/routes/render.ts:344-356` silently ignores unknown keys (a JSON.parse inside a `try { … } catch { /* ignore */ }`) — see `render.test.ts:47-65` for the precedent. The new fields land as additional keys under a discriminator.
  - The producer already has the data. After `runEncodeStage` finishes (`packages/producer/src/services/renderOrchestrator.ts:5076-5085`), `job.duration` and `framesRendered` are known. The sidecar write in the Vite / CLI adapters (`packages/studio/vite.adapter.ts:376-384` and `packages/cli/src/server/studioServer.ts:653-661`) is already the place where summary numbers land; adding two more keys is local to those adapters.
- **Cons.**
  - The meta sidecar widens by two keys. Any consumer that strict-validates the sidecar schema would break — no such consumer exists in this repo today (`packages/studio-server/src/routes/render.ts:344-356` is permissive).
  - The discriminator `kind?: "file" | "directory"` is a small runtime-shape choice; the route has to read it (or fall back to `lstatSync`).
- **Trade-offs accepted.**
  - One extra `lstatSync` syscall per entry to assert the directory shape *only* if the sidecar's `kind` field is absent — same fallback path as a deleted-on-import renders record. Tied to the resolution recorded below (RenderJobState gains `kind?`).
  - No synchronisation primitive between producer and route: both are this codebase, and the producer writes the sidecar with `JSON.stringify` at `packages/studio/vite.adapter.ts:376-384`. An external schema isn't required.

### Q3 — Download mechanism for a directory render

Two competing shape choices for the user-facing download:

- **A. Stream a zip on demand.** A new endpoint emits a `Response` body that wraps each entry with a `local file header` + `crc32` + entry bytes. Uses `node:zlib` (`crc32`, `deflateRaw`). No on-disk zip.
- **B. Pre-built zip at render completion.** Producer or adapter writes a zip next to the directory at commit time. The route's file-shaped code serves the `<jobId>.zip` directly.

Trade-offs: Option A contains the new code in one helper module and avoids writing frames twice. Option B keeps the route simpler. STORE-level (no compression) is the right default for A — PNGs are already compressed.

**My recommendation: A.** Aligns with the "no on-disk zip" decision in Q1. Memory is bounded by the largest single frame, not total frame count.

- **Pros.**
  - Frames are written once, on disk in the directory. The producer's directory publish at `packages/producer/src/services/renderOrchestrator.ts:2882-2890` is the only write path; the route never asks for frames to be re-encoded or re-zipped.
  - Memory is bounded by the largest single frame (a 1080p RGBA PNG is on the order of a few MB), not by total frame count. A 30-second render at 30 fps is ~900 frames; without streaming, that's ~900 MB of buffer before the first byte ships.
  - The dependency surface stays minimal. The PR introduces zip-record authoring in one helper module using only `node:zlib`'s `crc32` and `deflateRaw` (already used by `packages/engine/src/services/audioMixer.ts` for ADTS detection). No new third-party deps.
  - Recovery is automatic. If the user's download disconnects mid-flight, the directory stays on disk; a retry without re-render works, because the directory is still valid.
- **Cons.**
  - Streaming responses don't support HTTP byte-range with re-seek into the same body. A client that pauses mid-download can't resume at byte offset N — they re-request the whole zip.
  - ZIP record authorship is novel in this repo. No existing `archiver` / `jszip` / `adm-zip` dependency today (verified by absence in any `package.json` under `packages/*`). The PR introduces a hand-rolled module. Small but new.
  - `Content-Length` cannot be set up front because the body is assembled during emission. Some clients (and many proxy caches) prefer Content-Length for progress bars; browsers fall back to indeterminate-progress UI.
- **Trade-offs accepted.**
  - Zero disk cost for a download: nothing is double-written. The trade-off against Option B is paying the operator's SSD bandwidth on render completion to bake a zip — for a 30-second 1080p PNG sequence that's an extra ~900 MB of writes per render.
  - Re-seek support is sacrificed. Acceptable because zip downloads are download-and-go (not media playback with byte-position continuity) and the directory remains available on disk for any tool that wants to skip zipping.
  - STORE level (no compression) is the default. PNGs are already DEFLATE-compressed; running another DEFLATE rarely wins size and certainly costs CPU. The recommendation stands unless a maintainer wants DEFLATE-level consistency with `ffmpeg`-built zips.

### Q4 — DELETE while a render is in flight

User-initiated DELETE arriving while the producer is still writing has to choose:

- **A. 409 Conflict.** Reject DELETE while `state.status === "rendering"`. User retries after the producer commits or fails. The producer's own `ExecutionContext.defer("rollback staged artifact")` at `packages/producer/src/services/renderOrchestrator.ts:2931` only rolls back `stagingPath`, not the committed `outputPath`, so a mid-render DELETE today has no graceful path.
- **B. Best-effort / partial.** DELETE removes the directory mid-write; the producer's writer may fail afterward. Today's file-shaped DELETE tolerates this (`packages/studio-server/src/routes/renderDeletion.test.ts:96-101` returns 200 on a missing renders dir) — the same fallback logic.

Both work. The mid-flight race is the same race the file branch already has, only worse for directories (more files to mid-write).

**My recommendation: A.** Adding 409 is a single early-return in `packages/studio-server/src/routes/render.ts` DELETE handler, and prevents the user from seeing a partially-deleted directory.

- **Pros.**
  - Single-line safeguard: `if (state.status === "rendering") return c.json({ error: "render in flight" }, 409)` at the top of the DELETE handler — same shape as the existing 404 at `packages/studio-server/src/routes/render.ts:238-259`.
  - Closes the producer's race window. The producer's `ArtifactTransaction.commit()` at `packages/producer/src/services/render/artifactTransaction.ts:363-402` is the boundary where `stagingPath` becomes `destinationPath`; before commit, the directory is half-built. DELETE during that window is malformed operationally even before the safety question arises.
  - Honouring the producer's own design. `ExecutionContext.defer("rollback staged artifact", () => artifactTransaction.rollback())` at `packages/producer/src/services/renderOrchestrator.ts:2931` only rolls back `stagingPath` — not the committed `outputPath`. The route has always been responsible for the gate, not the producer.
- **Cons.**
  - Adds a non-200 case the UI has to render (a "wait" state, probably a brief toast or a disabled retry button until the SSE progress stream closes).
  - Some users will hit 409 legitimately; the UI must implement retry-after-409 with reasonable backoff. Same retry pattern as a transient network 5xx, basically.
- **Trade-offs accepted.**
  - DELETE on a `cancelled` render is still 200. After cancel, `state.status === "cancelled"` and the producer's own `removeCancelledOutput` (the symmetric cleanup at `vite.adapter.ts:322-336` and `studioServer.ts:596-610`) is the part that already handles the partial-output race.
  - DELETE on a `failed` render is still 200. A failed render may leave a partial directory; deleting it is exactly what the user wants. Today's file-shaped DELETE tolerates this — `packages/studio-server/src/routes/renderDeletion.test.ts:96-101` confirms `DELETE` returns 200 with a missing renders dir, no rebuild.

### Q5 — Meta sidecar schema change

The meta sidecar (`.meta.json`) at `packages/studio-server/src/routes/render.ts:344-356` already has a documented schema: `{ status, durationMs, audioLoweredDb? }`. Directory adds `frameCount` and `sizeBytes`.

- **A. Additive widening.** Two new optional fields. JSON parse everywhere silently ignores unknown keys (existing precedent: `format: undefined` at `packages/cli/src/telemetry/events.ts:220`).
- **B. Versioned schema.** New `schemaVersion: 2` field.

**My recommendation: A.** The route already does the additive thing (`packages/studio-server/src/routes/render.test.ts:47-65` reads `meta.status` and ignores new keys without version checks). The producer's `ArtifactTransaction` would write the new keys without coordination with the route.

- **Pros.**
  - No `schemaVersion` field means no migration logic. New keys arrive; old readers silently drop them at `JSON.parse(...)` inside `try { ... } catch { /* ignore */ }` (the pattern at `packages/studio-server/src/routes/render.ts:344-356`).
  - Forward-compat is automatic. Future sidecar additions (frameRate for screenshotted fps metadata, dimensions for output width/height, …) stay additive and don't surface to consumers that can't read them.
  - Producer and route stay in the same codebase. The "schema" is the producer's `meta` writer at `packages/studio/vite.adapter.ts:376-384` and `packages/cli/src/server/studioServer.ts:653-661`, and the route's reader at `packages/studio-server/src/routes/render.ts:344-356`. Both evolve together — no external contract to publish.
- **Cons.**
  - No machine-checked contract. A new maintainer adding a key to the producer's meta writer won't be told they're breaking the route, because there is no schema validator.
  - If a future sidecar consumer wants to *require* a key (e.g. for type-safe analysis), it'll have to negotiate the requirement outside the meta file. Reasonable but worth noting.
- **Trade-offs accepted.**
  - The metadata contract is implicit and owned by this codebase. Acceptable today because both writers and readers live in the same repo. Not acceptable as soon as third-party consumers (cloud-render plugins, public studios integrations) start reading the sidecar — at that point, versioned schema becomes a hard requirement.
  - No tests are required to validate schema widenings, which means a typo in one of the new keys (`frameCount` vs `frame_count`) would silently pass parser-grade tests but corrupt listing. Mitigation: route reads with explicit field names (`meta.frameCount`) — every read is a single source of truth for the spelling.
