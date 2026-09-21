# REAL Mode Social MP4 Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a persistent social-media MP4 in REAL mode with normalized dynamic video, audible voiceover and music, burned Chinese subtitles, selectable canvas presets, strict failure semantics, and downloadable artifacts.

**Architecture:** Keep the existing Express + Mastra two-phase workflow and One-API providers. Add focused media modules for canvas/model resolution, audio timing, FFmpeg processing, artifact storage, and validation; make REAL workflow strict while preserving explicitly labeled DEMO storyboard behavior. Resolve and validate delivery prerequisites before paid generation, derive the final timeline from per-line TTS durations, standardize every visual asset before downstream use, and expose only validated persistent artifacts to the approval UI.

**Tech Stack:** Node.js ESM, Express 4, Mastra 1.63, Zod 3, native `fetch`, FFmpeg/ffprobe/libass, `node:test`, single-file HTML/CSS/JS frontend.

**Design spec:** `docs/superpowers/specs/2026-09-20-real-mp4-delivery-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `src/media/canvas.js` | Canvas preset registry, validation, prompt/FFmpeg dimensions and subtitle-safe styles |
| `src/media/model-selection.js` | REAL video/TTS model validation and deterministic automatic selection |
| `src/media/artifacts.js` | Run-scoped safe paths, atomic promotion, manifests, retention deletion and safe download names |
| `src/media/materialize.js` | Bounded, scheme-safe data/http/file ingestion shared by image, video and audio |
| `src/media/audio.js` | Audio probing, per-line timeline and SRT generation |
| `src/media/ffmpeg.js` | Image/video normalization, voice/music mix, subtitle burn-in, poster extraction and final validation |
| `src/schemas.js` | `canvasPreset` request schema and default |
| `src/models-gateway.js` | Recognize `minimax-h3` and expose raw model entries needed by selection |
| `src/mastra/providers.js` | Provider calls only; per-line TTS and music responses passed to media modules |
| `src/mastra/workflow.js` | Strict REAL ordering and removal of success fallbacks |
| `src/store.js` | Artifact metadata and safe artifact cleanup when runs are trimmed |
| `src/server.js` | Async preflight, artifact routes, rerun endpoint and validated final-review payload |
| `src/runtime-config.js` | Default provider mode is REAL when no override is configured |
| `public/index.html` | Canvas selector, automatic model display, strict error/retry state and artifact downloads |
| `docs/openapi.json` | OpenAPI 3.1 contract for generation, rerun and artifact endpoints |
| `tests/*.test.mjs` | Unit, integration, API and frontend regressions |

## Named limits

Define and test these constants instead of scattering literals:

```js
export const MEDIA_LIMITS = {
  downloadTimeoutMs: 30_000,
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
  maxAudioBytes: 50 * 1024 * 1024,
  minFinalVideoBytes: 10_000,
  durationToleranceSec: 0.75,
  subtitlePixelDiffRatio: 0.005,
  voiceGapMs: 120,
};
```

`file:` inputs must resolve inside the run's server-created workspace. Never accept arbitrary local paths from the client or provider response.

---

### Task 1: Canvas presets and Brief contract

**Files:**
- Create: `src/media/canvas.js`
- Modify: `src/schemas.js`
- Modify: `src/mastra/providers.js`
- Test: `tests/canvas.test.mjs`
- Test: `tests/providers-real.test.mjs`

- [ ] **Step 1: Write failing canvas registry tests**

Cover the default and exact enum mapping:

```js
assert.deepEqual(resolveCanvas(), {
  id: "social-portrait", width: 1080, height: 1920, aspectRatio: "9:16",
  subtitle: { fontSize: 52, marginV: 250, maxCharsPerLine: 16 },
});
assert.equal(resolveCanvas("social-landscape").aspectRatio, "16:9");
assert.equal(resolveCanvas("social-square").width, 1080);
assert.throws(() => resolveCanvas("4096x4096"), /不支持的画布/);
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/canvas.test.mjs tests/providers-real.test.mjs`

Expected: FAIL because `src/media/canvas.js` does not exist.

- [ ] **Step 3: Implement the immutable preset registry**

Export `CANVAS_PRESETS`, `DEFAULT_CANVAS_PRESET`, `resolveCanvas(id)`, and `canvasPrompt(brief)`. Keep arbitrary width/height out of the public API.

- [ ] **Step 4: Add `canvasPreset` to Brief parsing**

Use a Zod enum with `.default("social-portrait")`. Update image/storyboard prompts to use the resolved aspect ratio and centered subject-safe composition.

- [ ] **Step 5: Verify focused tests**

Run: `node --import ./tests/setup.mjs --test tests/canvas.test.mjs tests/providers-real.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the canvas contract**

```powershell
git add src/media/canvas.js src/schemas.js src/mastra/providers.js tests/canvas.test.mjs tests/providers-real.test.mjs
git commit -m "feat(brand-promo): add social canvas presets"
```

### Task 2: Deterministic video/TTS model resolution and preflight

**Files:**
- Create: `src/media/model-selection.js`
- Create: `src/media/artifacts.js` (path/workspace subset used by preflight; Task 3 extends lifecycle behavior)
- Modify: `src/models-gateway.js`
- Modify: `src/runtime-config.js`
- Modify: `.env.example`
- Modify: `src/server.js`
- Modify: `src/mastra/workflow.js`
- Test: `tests/model-selection.test.mjs`
- Test: `tests/models-gateway.test.mjs`
- Test: `tests/server.test.mjs`
- Test: `tests/radar-server.test.mjs`
- Modify: `tests/setup.mjs`
- Modify: `tests/providers-real.test.mjs`
- Modify: `tests/radar-core.test.mjs`
- Modify: `tests/radar-sentiment.test.mjs`
- Modify: `tests/radar-server.test.mjs`
- Modify: `tests/radar-topics.test.mjs`
- Modify: `tests/video-provider.test.mjs`

- [ ] **Step 1: Write failing selection tests**

Test exact priority and stable fallback:

```js
assert.equal(selectVideoModel(["seedance-2.0", "7zhe-seedance", "minimax-h3"]), "minimax-h3");
assert.equal(selectVideoModel(["seedance-2.0", "7zhe-seedance"]), "7zhe-seedance");
assert.equal(selectVideoModel(["doubao-seedance-2-0-mini-260615", "doubao-seedance-2-0-260128"]), "doubao-seedance-2-0-260128");
assert.throws(() => selectVideoModel([]), /没有可用的动态视频模型/);
assert.equal(validateSelectedVideoModel("seedance-2.0", ["seedance-2.0"]), "seedance-2.0");
```

Also assert `classifyModelId("minimax-h3") === "video"`, default TTS resolves to `speech-02-hd` when available, and `getProviderMode()` returns `real` when neither env nor runtime override is present. Preserve precedence as persisted runtime override (`real` or `demo`) > explicit env (`real` or `demo`) > implicit default `real`; an explicit persisted `demo` remains supported.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/model-selection.test.mjs tests/models-gateway.test.mjs`

Expected: FAIL because the resolver is missing and `minimax-h3` is currently classified as LLM.

- [ ] **Step 3: Implement pure model selectors**

Use exact IDs before normalized regex fallbacks. Manual `brief.videoModel` always overrides auto-selection but must appear in the live video set. Return `{ videoModel, ttsModel, source }` for audit.

- [ ] **Step 4: Add async REAL preflight to `POST /api/generate`**

Extract one `prepareGenerationBrief(rawBrief)` function and require every run-creation entry point to call it before `createRun`, including `POST /api/generate`, `POST /api/runs/:runId/rerun`, and `POST /api/radar/topics/:id/dispatch`. The function performs:

1. require One-API base/key;
2. run `ffmpeg -version`, `ffprobe -version`, and verify the `subtitles` filter;
3. verify configured Chinese font;
4. fetch live models and resolve video/TTS;
5. require a configured music endpoint/model and validate any catalog-listed music model against the live raw list;
6. create the run workspace through `artifactPaths` and verify that exact output root is writable;
7. write resolved video/TTS/music model and canvas defaults into the parsed Brief.

Do not make paid provider calls in preflight. Return 503 with a field-safe error on environment failure and 400 on an invalid manual model. Set the code and `.env.example` implicit/default mode to `real`; retain explicit `PROMO_PROVIDER_MODE=demo` and persisted runtime `providerMode=demo` as supported ways to enter DEMO.

- [ ] **Step 5: Test preflight error and success API paths**

Mock only subprocess/model boundaries. Assert failed preflight creates no run; successful preflight stores resolved `brief.videoModel`. In `tests/radar-server.test.mjs`, assert topic dispatch invokes the same preflight, rejects before paid script work when prerequisites fail, and stores resolved canvas/video/TTS/music fields when it succeeds.

Update tests that previously used `delete process.env.PROMO_PROVIDER_MODE` to force DEMO: set `PROMO_PROVIDER_MODE="demo"` explicitly and restore the previous value in cleanup. `tests/setup.mjs` sets DEMO for the ordinary suite; REAL-specific tests continue overriding it before importing providers/server. Update the old “unset means demo” assertion to “unset means real” and add persisted demo precedence coverage.

- [ ] **Step 6: Run focused tests**

Run: `node --import ./tests/setup.mjs --test tests/model-selection.test.mjs tests/models-gateway.test.mjs tests/providers-real.test.mjs tests/radar-core.test.mjs tests/radar-sentiment.test.mjs tests/radar-server.test.mjs tests/radar-topics.test.mjs tests/video-provider.test.mjs tests/server.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit model resolution and preflight**

```powershell
git add src/media/model-selection.js src/media/artifacts.js src/models-gateway.js src/runtime-config.js .env.example src/server.js src/mastra/workflow.js tests/setup.mjs tests/model-selection.test.mjs tests/models-gateway.test.mjs tests/providers-real.test.mjs tests/radar-core.test.mjs tests/radar-sentiment.test.mjs tests/radar-server.test.mjs tests/radar-topics.test.mjs tests/video-provider.test.mjs tests/server.test.mjs
git commit -m "feat(brand-promo): resolve real delivery models"
```

### Task 3: Safe media workspace and artifact lifecycle

**Files:**
- Modify: `src/media/artifacts.js`
- Create: `src/media/materialize.js`
- Modify: `src/store.js`
- Test: `tests/artifacts.test.mjs`
- Test: `tests/materialize.test.mjs`
- Test: `tests/store-persist.test.mjs`

- [ ] **Step 1: Write failing path-safety and lifecycle tests**

Cover run IDs, containment, atomic promotion, safe Chinese filenames, cleanup, and shared media ingestion:

```js
const paths = artifactPaths("run-123");
assert.ok(paths.finalVideo.startsWith(outputRoot + path.sep));
assert.throws(() => artifactPaths("../escape"), /非法 runId/);
assert.equal(safeDownloadName("铭星链 / Demo", "run-123", "mp4"), "铭星链-Demo-run-123.mp4");
```

Assert trimming the oldest run removes only `data/outputs/<exact-runId>` and never follows a path outside `outputRoot`, both with `PROMO_PERSIST=1` and `PROMO_PERSIST=0`. Set `PROMO_DATA_DIR` to a test temp directory.

For `materializeMedia`, test image/video/audio data URLs, HTTP fixtures and workspace-contained file paths. Enforce `MEDIA_LIMITS.downloadTimeoutMs`, type-specific byte limits, expected MIME/magic bytes, redirect scheme validation, empty-body rejection and path containment.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/artifacts.test.mjs tests/materialize.test.mjs tests/store-persist.test.mjs`

Expected: FAIL because artifact helpers and cleanup hooks are missing.

- [ ] **Step 3: Implement run workspace and artifact paths**

Export safe creation/resolution helpers, `MEDIA_LIMITS`, `writeManifest`, `promoteArtifacts`, `removeRunArtifacts`, and `safeDownloadName`. Use `path.resolve` containment checks before any read, move, or recursive removal. Implement `materializeMedia({ source, kind, workspace })` once in `src/media/materialize.js`; all image, video and audio paths must use it.

- [ ] **Step 4: Connect cleanup to `trimRuns`**

Delete artifacts after the corresponding run is removed from the map regardless of `PROMO_PERSIST`; that flag controls `runs.json` write-through, not output lifecycle. Cleanup failure logs a warning but does not corrupt store state.

- [ ] **Step 5: Run focused tests**

Run: `node --import ./tests/setup.mjs --test tests/artifacts.test.mjs tests/materialize.test.mjs tests/store-persist.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit artifact lifecycle**

```powershell
git add src/media/artifacts.js src/media/materialize.js src/store.js tests/artifacts.test.mjs tests/materialize.test.mjs tests/store-persist.test.mjs
git commit -m "feat(brand-promo): persist run media artifacts"
```

### Task 4: Per-line TTS, authoritative timeline, and SRT

**Files:**
- Create: `src/media/audio.js`
- Modify: `src/mastra/providers.js`
- Test: `tests/audio.test.mjs`
- Test: `tests/providers-real.test.mjs`

- [ ] **Step 1: Write failing materialization and timeline tests**

Reuse `materializeMedia` coverage from Task 3. Here, test audio probing, concatenation, timeline construction and malformed timestamps.

Use generated audio fixtures to assert:

```js
const timeline = buildVoiceTimeline([
  { text: "第一句", durationSec: 1.4 },
  { text: "第二句", durationSec: 2.1 },
], { gapMs: 120 });
assert.equal(timeline.cues[0].startMs, 0);
assert.equal(timeline.cues[0].endMs, 1400);
assert.equal(timeline.cues[1].startMs, 1520);
assert.match(timeline.srt, /00:00:01,520 --> 00:00:03,620/);
assert.deepEqual(timeline.sceneDurationsMs, [1520, 2100]); // non-final line includes 120ms gap
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/audio.test.mjs tests/providers-real.test.mjs`

Expected: FAIL because safe materialization and actual-duration timing do not exist.

- [ ] **Step 3: Integrate shared bounded media materialization**

Call `materializeMedia({ kind: "audio" })` for every TTS/music response and probe every resulting file with ffprobe. Keep provider-specific response parsing in `providers.js` and all byte/path safety in the shared module.

- [ ] **Step 4: Change TTS to per-line generation**

Call `/audio/speech` once per confirmed voiceover line, save each segment, probe actual duration, concatenate with 120ms gaps, and return `{ voicePath, cues, srt, durationSec, model, _usage }`. Empty text or an empty/undecodable response throws.

- [ ] **Step 5: Generate UTF-8 standard SRT**

Format `HH:MM:SS,mmm`, remove control characters, preserve Chinese punctuation, enforce monotonic non-overlapping cues, and cap the last cue at the authoritative voice duration. Export `sceneDurationsMs`: each non-final scene equals measured speech duration plus the 120ms inter-line gap; the final scene equals its measured speech duration with no trailing gap.

Wrap text by Unicode code points using the canvas preset's `maxCharsPerLine`. If a confirmed line needs more than two rendered lines, split it into consecutive subtitle sub-cues of at most two lines and divide that voice segment's measured duration proportionally by character count. Never truncate or replace dialogue. Validation reconstructs the normalized text from sub-cues and requires it to equal the original confirmed line.

- [ ] **Step 6: Run focused tests**

Run: `node --import ./tests/setup.mjs --test tests/audio.test.mjs tests/providers-real.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit authoritative audio timing**

```powershell
git add src/media/audio.js src/mastra/providers.js tests/audio.test.mjs tests/providers-real.test.mjs
git commit -m "feat(brand-promo): align subtitles to real voice timing"
```

### Task 5: Normalize social-media visual assets

**Files:**
- Create: `src/media/ffmpeg.js`
- Modify: `src/mastra/providers.js`
- Test: `tests/media-normalization.test.mjs`
- Test: `tests/video-provider.test.mjs`

- [ ] **Step 1: Write failing normalization tests**

Generate landscape, portrait, and square synthetic images/videos with FFmpeg. For every target preset, assert normalized output has exact width/height, 25fps, square sample aspect ratio, H.264/yuv420p for video, and expected duration including last-frame extension. Provider request tests must assert the chosen `aspect_ratio`/pixel dimensions are sent to both image and video endpoints before normalization.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/media-normalization.test.mjs tests/video-provider.test.mjs`

Expected: FAIL because normalization helpers are missing.

- [ ] **Step 3: Implement image normalization**

Pass the selected canvas ratio/size in the provider request, materialize the response through `materializeMedia({ kind: "image" })`, then use scale-to-fill plus centered crop to create a target-canvas PNG/JPEG in the run workspace. Return its server-safe URL/path for preview and image-to-video input.

- [ ] **Step 4: Implement dynamic clip normalization**

Pass the selected canvas ratio/size in the video request, materialize the provider response through `materializeMedia({ kind: "video" })`, and transcode it to target dimensions, 25fps, H.264/yuv420p, no inherited audio, and the authoritative scene duration. Use trim for long clips and `tpad=stop_mode=clone` for short clips.

- [ ] **Step 5: Make provider outputs feed standardized assets only**

Keep raw provider files inside the temporary workspace. Store normalized `mediaPath`/`videoPath` on scenes and expose only controlled preview routes, never arbitrary provider or local paths. Add malicious redirect, oversize image/video, wrong MIME and out-of-workspace file regression cases to `tests/media-normalization.test.mjs` using the Task 3 materializer.

- [ ] **Step 6: Run focused tests**

Run: `node --import ./tests/setup.mjs --test tests/media-normalization.test.mjs tests/video-provider.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit visual normalization**

```powershell
git add src/media/ffmpeg.js src/mastra/providers.js tests/media-normalization.test.mjs tests/video-provider.test.mjs
git commit -m "feat(brand-promo): normalize social video assets"
```

### Task 6: FFmpeg audio mix, Chinese subtitle burn-in, and final validation

**Files:**
- Modify: `src/media/ffmpeg.js`
- Modify: `src/mastra/providers.js`
- Replace/extend: `tests/composite-real.test.mjs`

- [x] **Step 1: Write failing end-to-end compositor tests**

For each canvas preset, generate two normalized clips, voiced Chinese cues, and background music. Assert:

- exact dimensions, H.264/yuv420p and AAC stereo/48kHz;
- duration within `MEDIA_LIMITS.durationToleranceSec` of the voice-derived timeline;
- final file size is at least `MEDIA_LIMITS.minFinalVideoBytes`;
- both voice and music inputs are accepted from data/HTTP/file fixtures;
- `final.mp4`, `subtitles.srt`, `poster.jpg`, and `manifest.json` are present;
- first/last cue midpoint bottom-30% crops differ from a subtitle-free baseline by more than 0.5%;
- SRT contains every confirmed line exactly once and all artifact paths resolve inside the persistent run directory;
- manifest contains canvas, resolved models, cue/scene durations, FFmpeg version, file sizes and SHA-256 checksums matching the files;
- rendering `中文测试` differs from rendering explicit tofu squares `□□□□`, catching missing Chinese glyph fallback;
- FFmpeg EBU analysis reports integrated voice-first mix near `-16 LUFS` and true peak no higher than `-1.5 dBTP` (allow 0.2dB measurement tolerance);
- missing video/voice/music/font/subtitles filter or malformed output rejects instead of returning a fallback.

- [x] **Step 2: Run compositor tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/composite-real.test.mjs`

Expected: FAIL because subtitles are not burned, outputs are temporary, and REAL still falls back.

- [x] **Step 3: Implement filter-concat video assembly**

Use already-normalized clips as inputs, apply a defensive parameter check, and concatenate with the filter graph rather than concat demuxer assumptions.

- [x] **Step 4: Implement voice-first audio mixing**

Normalize voice to `-16 LUFS` with `TP=-1.5`, lower music to `0.18`, mix to AAC stereo/48kHz, trim music at the authoritative duration, and never truncate voice. After encoding, run FFmpeg EBU/loudnorm analysis and reject a measured true peak above `-1.3 dBTP` (the 0.2dB tolerance around the `-1.5` target).

- [x] **Step 5: Burn Chinese subtitles**

Write UTF-8 SRT plus an explicit `PlayResX`/`PlayResY` ASS in the workspace; burn the ASS with the FFmpeg `ass` filter using a relative filename and the workspace as process `cwd`. Do not feed the SRT to `subtitles` directly (default PlayRes 384x288 misplaces the bottom margin). Apply preset-derived styling (white text, outline, `Alignment=2`, `WrapStyle: 2`) using `PROMO_SUBTITLE_FONT` or verified `Microsoft YaHei` fallback. Preflight known Chinese font files, render a Chinese glyph probe and a tofu-square control, and require a non-identical pixel signature. Fail if the filter, font file or Chinese glyph coverage is unavailable.

- [x] **Step 6: Validate and atomically promote output**

Require file size ≥ `MEDIA_LIMITS.minFinalVideoBytes`; probe container, streams, codec, dimensions, pixel format, duration, audio presence and true peak; verify reconstructed SRT text contains every confirmed line without truncation; perform fixed subtitle frame comparisons; extract the first valid frame as poster; write all required manifest fields and SHA-256 checksums; require MP4/SRT/manifest to resolve inside the persistent run directory after atomic promotion. Missing or mismatched artifacts fail validation.

- [x] **Step 7: Remove REAL fallback from `composite`**

DEMO may return a labeled storyboard result. REAL catches no compositor error; it propagates failure to the workflow boundary.

- [x] **Step 8: Run compositor tests**

Run: `node --import ./tests/setup.mjs --test tests/composite-real.test.mjs`

Expected: PASS on the installed FFmpeg build; do not skip missing libass/font cases in the configured development environment.

- [x] **Step 9: Commit final compositor**

```powershell
git add src/media/ffmpeg.js src/mastra/providers.js tests/composite-real.test.mjs
git commit -m "feat(brand-promo): burn subtitles into persistent mp4"
```

### Task 7: Strict REAL workflow ordering and failure semantics

**Files:**
- Modify: `src/mastra/workflow.js`
- Modify: `src/server.js`
- Test: `tests/workflow-real-budget.test.mjs`
- Test: `tests/run-recovery.test.mjs`
- Test: `tests/server.test.mjs`

- [x] **Step 1: Write failing workflow tests**

Assert order `prepareVideo → voiceover → music → storyboard → generateScenes → composite`; TTS/music execute before image/video calls; storyboard count equals confirmed voiceover-line count; each scene duration equals the corresponding measured speech duration plus 120ms except the final scene, which has no trailing gap; summed Scene duration equals the authoritative timeline; every REAL scene requires normalized video; each provider/compositor error produces one `run-failed`; no failure reaches `awaiting_delivery` or `success`. Assert composite emits `{ step:"composite", status:"step-progress", phase:"validating", message:"正在校验成片" }` before artifact validation and final review.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/workflow-real-budget.test.mjs tests/run-recovery.test.mjs tests/server.test.mjs`

Expected: FAIL because the current workflow orders visuals first and catches failures as successful degradation.

- [x] **Step 3: Reorder steps and thread authoritative timing**

Pass `{ brief, script, voice, music, timeline }` into storyboard; require one scene per confirmed voiceover line and overwrite each model-proposed duration with `timeline.sceneDurationsMs[index] / 1000`; pass normalized workspace paths through scenes into composite.

- [x] **Step 4: Remove REAL catches that return null/static fallbacks**

Keep DEMO behavior behind explicit provider-mode branches. In REAL, throw typed errors carrying safe `stage` and `message`; let the existing server phase boundary publish the single terminal failure.

- [x] **Step 5: Gate final review on validated artifacts**

At the start of final artifact validation, emit the defined composite `step-progress` event. Before setting `awaiting_delivery`, require `artifactManifest.validated === true` and persistent files. Send the persistent `/api/video/:runId` URL in `final-review`.

- [x] **Step 6: Run focused tests**

Run: `node --import ./tests/setup.mjs --test tests/workflow-real-budget.test.mjs tests/run-recovery.test.mjs tests/server.test.mjs`

Expected: PASS.

- [x] **Step 7: Commit strict workflow semantics**

```powershell
git add src/mastra/workflow.js src/server.js tests/workflow-real-budget.test.mjs tests/run-recovery.test.mjs tests/server.test.mjs
git commit -m "fix(brand-promo): fail incomplete real deliveries"
```

### Task 8: Artifact APIs and full rerun

**Files:**
- Modify: `src/server.js`
- Modify: `src/store.js`
- Create: `docs/openapi.json`
- Test: `tests/server.test.mjs`
- Test: `tests/openapi.test.mjs`

- [ ] **Step 1: Write failing API tests**

Cover Range playback, attachment headers, SRT MIME/UTF-8, poster MIME, missing/failed run 404/409 responses, path traversal rejection, rerun behavior, and two concurrent rerun requests for the same failed run producing only one new run.

Rerun test:

```js
const retry = await fetch(`${base}/api/runs/${failedRunId}/rerun`, { method: "POST" });
assert.equal(retry.status, 201);
const { runId: nextId } = await retry.json();
assert.notEqual(nextId, failedRunId);
assert.deepEqual(getRun(nextId).brief, getRun(failedRunId).brief);
assert.equal(getRun(failedRunId).status, "failed");
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `node --import ./tests/setup.mjs --test tests/server.test.mjs tests/openapi.test.mjs`

Expected: FAIL because download and rerun endpoints do not exist.

- [ ] **Step 3: Implement controlled artifact routes**

Resolve files only through `artifactPaths(runId)`. Use `sendFile`/streaming with explicit content types, safe attachment names, existence checks, and status checks.

- [ ] **Step 4: Implement full rerun endpoint with an in-flight guard**

Accept only failed run IDs, clone the stored parsed Brief, run the same preflight, create a new run, and invoke the existing script phase. Use an in-memory `rerunsInFlight` map keyed by failed runId so concurrent requests share/return the same newly created run instead of double billing; clear the guard after creation. This is a process-local duplicate guard, not a new external idempotency-key contract. Return 201 with the new runId. Do not mutate or delete the old run.

- [ ] **Step 5: Add and validate the OpenAPI 3.1 contract**

Document `POST /api/generate`, `POST /api/runs/{runId}/rerun`, `GET /api/video/{runId}`, and all artifact endpoints with request schemas, status codes, content types and Range/attachment behavior. `tests/openapi.test.mjs` parses JSON, asserts `openapi: "3.1.0"`, and verifies every new route/method exists.

- [ ] **Step 6: Run API tests**

Run: `node --import ./tests/setup.mjs --test tests/server.test.mjs tests/openapi.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit delivery APIs**

```powershell
git add src/server.js src/store.js docs/openapi.json tests/server.test.mjs tests/openapi.test.mjs
git commit -m "feat(brand-promo): expose validated delivery artifacts"
```

### Task 9: Frontend canvas, automatic model, delivery, and failure UI

**Files:**
- Modify: `public/index.html`
- Modify: `tests/frontend-recovery.test.mjs`
- Create: `tests/frontend-delivery.test.mjs`

- [ ] **Step 1: Read the required PC design spec before editing UI**

Read: `../spec/design/pc-design.md`.

- [ ] **Step 2: Write failing frontend tests**

Extract/evaluate the inline script using the existing VM harness. Assert:

- default canvas is `social-portrait` and request includes it;
- all three human-readable canvas choices are rendered;
- video default shows the resolved automatic model rather than “不启用”;
- validated success renders MP4/SRT/poster buttons;
- failed snapshot closes approval gates, shows the stage/reason, and offers rerun;
- composite progress renders an explicit “正在校验成片” substate before final review;
- rerun response switches to the new runId and opens a fresh SSE stream;
- historical fallback run is labeled and has no MP4-delivery claim.

- [ ] **Step 3: Run frontend tests and verify RED**

Run: `node --test tests/frontend-recovery.test.mjs tests/frontend-delivery.test.mjs`

Expected: FAIL for missing canvas/default/delivery/retry UI.

- [ ] **Step 4: Add canvas and automatic model controls**

Use existing fieldset/token styles. Default to “竖屏短视频 1080×1920”; options are “横屏 1920×1080” and “方形 1080×1080”. Display “自动（当前：model）” as the default video choice and preserve manual selection.

- [ ] **Step 5: Update final review and delivery rendering**

Use `/api/video/:runId` in a `<video controls>` player and render explicit artifact download buttons. Display canvas, resolved video/TTS/music models, duration and validation state from manifest-safe run fields.

During composite validation, consume the server progress event and set the composite step metadata to “正在校验成片”; clear it only when the validated snapshot/final-review arrives. Add a VM assertion so this state cannot regress.

- [ ] **Step 6: Implement failure rerun UI**

Show the safe error stage/reason. POST `/api/runs/:runId/rerun`; while pending disable the button; after 201 call `selectRun(newRunId)` and `openStream(newRunId)`.

- [ ] **Step 7: Run frontend tests**

Run: `node --test tests/frontend-recovery.test.mjs tests/frontend-delivery.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit frontend delivery UX**

```powershell
git add public/index.html tests/frontend-recovery.test.mjs tests/frontend-delivery.test.mjs
git commit -m "feat(brand-promo): add social mp4 delivery ui"
```

### Task 10: End-to-end verification and documentation

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `prd/PRD.md`
- Modify: `.env.example`
- Modify: `HANDOFF-UI-REDESIGN.md`
- Create: `tools/verify-real-delivery.mjs`
- Create: `tests/ui-delivery-smoke.spec.mjs`
- Modify: `docs/superpowers/specs/2026-09-20-real-mp4-delivery-design.md` only if implementation requires an approved spec correction
- Test: all `tests/**/*.test.mjs`

- [ ] **Step 1: Document the final contract and configuration**

Update PRD FR-5/7/8 and current implementation notes. Add `PROMO_FFMPEG_BIN`, `PROMO_FFPROBE_BIN`, `PROMO_SUBTITLE_FONT`, default TTS/music models, media limits and output path to `.env.example`. Record REAL strict failure and canvas options in the handoff.

Add `@playwright/test@1.45.0` as a pinned dev dependency matching the repository's approved Playwright Docker image. Create `tools/verify-real-delivery.mjs` to submit one `hitlEnabled:false`, `finalGateEnabled:false`, `social-portrait` REAL job, poll to terminal status, download artifacts, run ffprobe, and write `test/_preview/real-delivery-evidence.json` containing runId, resolved models, codecs, dimensions, duration, sizes and HTTP checks without secrets.

Create `tests/ui-delivery-smoke.spec.mjs` to read `REAL_RUN_ID`, visit `/?runId=<id>` at 1440×900, 768×900 and 375×812, collect `pageerror`, assert `scrollWidth <= innerWidth`, wait for the video element to have metadata, assert the canvas/model labels, and request each download URL expecting 200 plus the documented MIME type.

- [ ] **Step 2: Run static checks**

```powershell
node --input-type=module -e 'import fs from "node:fs"; const h=fs.readFileSync("public/index.html","utf8"); new Function(h.match(/<script>([\s\S]*?)<\/script>/)[1]); console.log("inline JS OK")'
git diff --check
```

Expected: `inline JS OK`; `git diff --check` exits 0.

- [ ] **Step 3: Run the complete automated suite**

Run: `pnpm test`

Expected: all tests pass, zero failures, no FFmpeg integration skips on the configured Windows development host.

- [ ] **Step 4: Run browser acceptance at required viewports**

Start the app on 6777 in REAL mode from PowerShell:

```powershell
$env:PORT = '6777'
$brandPromoNode = (Get-Command node).Source
$brandPromoProcess = Start-Process -FilePath $brandPromoNode -ArgumentList '--env-file=.env','src/server.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput 'test/_preview/acceptance-server.log' -RedirectStandardError 'test/_preview/acceptance-server-error.log' -PassThru
Invoke-RestMethod -Uri http://127.0.0.1:6777/api/config -Method Post -ContentType 'application/json' -Body '{"providerMode":"real"}' | Out-Null
Invoke-RestMethod http://127.0.0.1:6777/api/config -TimeoutSec 10
```

Expected: the persisted runtime override is explicitly set to REAL; config reports `mode=real`, configured base/key, and process listens on 6777. This command deliberately preserves the existing base/key while overriding a stale persisted DEMO mode.

After Step 5 produces a runId, run the browser test in the approved Linux container:

```powershell
$env:REAL_RUN_ID = (Get-Content test/_preview/real-delivery-evidence.json | ConvertFrom-Json).runId
docker run --rm --add-host=host.docker.internal:host-gateway -v "${PWD}:/work" -w /work -e BASE_URL=http://host.docker.internal:6777 -e REAL_RUN_ID=$env:REAL_RUN_ID mcr.microsoft.com/playwright:v1.45.0-jammy bash -lc "corepack enable && pnpm install --frozen-lockfile && pnpm exec playwright test tests/ui-delivery-smoke.spec.mjs --reporter=line"
```

Expected: 3/3 viewport cases pass; zero page errors; no horizontal overflow; video metadata loads; MP4/SRT/poster endpoints return 200 and expected MIME types.

- [ ] **Step 5: Run one paid REAL acceptance job**

Use the approved One-API configuration and automatic default video model:

```powershell
node --env-file=.env tools/verify-real-delivery.mjs --base http://127.0.0.1:6777 --canvas social-portrait
```

Expected: exit 0; evidence JSON reports status `success`, `1080x1920`, H.264 video, AAC audio, all scenes dynamic, burned-subtitle pixel checks above threshold, valid MP4/SRT/poster downloads, and no fallback note. Then manually play the downloaded MP4 once to confirm intelligible voice and audible lower-volume music; record that manual observation and a screenshot path in the handoff.

- [ ] **Step 6: Commit documentation and verification evidence**

```powershell
git add package.json pnpm-lock.yaml prd/PRD.md .env.example HANDOFF-UI-REDESIGN.md tools/verify-real-delivery.mjs tests/ui-delivery-smoke.spec.mjs
git commit -m "docs(brand-promo): document strict mp4 delivery"
```

- [ ] **Step 7: Review branch diff**

Run: `git diff --check HEAD~10..HEAD` and inspect `git status --short` so unrelated workspace files are not committed.

Expected: clean checks; only intended branch changes remain.
