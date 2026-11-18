# Image Pyramid Cache — cross-module delivery

A deterministic image-pyramid generator with a validated disk cache, frame-aware
animation handling and an HTTP service whose health check never runs image
codecs. It is an **additive subsystem** under `./pyramid/`: the upstream sharp
package entry points, source tree and existing tests are untouched.

- Runtime: Node.js >= 20.9, ESM only
- Imaging: sharp 0.35.5 (libvips 8.18.7), installed from prebuilt binaries
- Zero production dependencies beyond sharp

## Quick start

```bash
cd pyramid
npm install          # fetches the prebuilt sharp binary

npm test             # 73 real assertions across 11 test files
npm run acceptance   # full-chain harness; writes acceptance/summary.json
npm run serve        # starts the HTTP service (use --port, --cache-root ...)
```

Run the acceptance harness twice; `acceptance/summary.json` is byte-identical
between runs because it contains only content-derived fields.

## Module boundaries

| File | Responsibility | Key exports |
| --- | --- | --- |
| `lib/errors.mjs` | Stable error codes and typed errors | `ErrorCode`, `PyramidError`, `toPyramidError` |
| `lib/constants.mjs` | Rule version, option whitelists, pure pyramid geometry | `RULE_VERSION`, `normaliseOptions`, `levelDimensions` |
| `lib/validation.mjs` | All input rejection before any write; metadata + decode preflight | `validateInput`, `probeMetadata` |
| `lib/processing.mjs` | Decode, orientation/mirror/colourspace, per-frame pyramid levels | `extractFrames`, `buildFramePyramid`, `estimatePeakMemory` |
| `lib/cache.mjs` | Content-addressed disk cache, atomic writes, TTL/LRU, quarantine | `DiskCache`, `computeCacheKey`, `hashFile` |
| `lib/pipeline.mjs` | Orchestration, in-flight de-dup, bounded frame pool, atomic publication | `PyramidPipeline`, `runPool` |
| `lib/service.mjs` | HTTP API, non-blocking health, bounded queue, graceful shutdown | `PyramidService` |
| `lib/samples.mjs` | Offline runtime-generated sample images (no golden logs) | `createSampleSet` |

## Processing contract

1. **Coordinate system.** Origin `(0,0)` is the top-left of the stored pixel
   array; `x` grows right, `y` grows down. Level 0 is the image *after* the
   orientation directive is applied, so cached pixels never depend on an EXIF
   interpretation.
2. **Sampling and boundaries.** Every level > 0 is one Lanczos3 resize (the
   kernel is whitelisted in `KERNELS`) sourced exclusively from level 0 (never
   from an already downsampled level). Out-of-range samples use libvips
   edge-clamp extension.
3. **Integer rounding.** Target dimensions come from `levelDimensions`:
   `ceil(N/2)`, clamped to a minimum of 1, so odd sizes never produce a zero
   dimension and the final level is always at least 1×1. The chain stops at
   `maxLevels`, at 1×1, or when the next candidate's longest side would fall
   below `minLevelDimension` (default 1 = full chain).
4. **Alpha semantics.** Alpha is retained end-to-end. Resampling runs on
   premultiplied colour and unpremultiplies afterwards, so fully transparent
   pixels cannot bleed RGB fringes into opaque neighbours (asserted in
   `test/alpha.test.mjs`).
5. **Colour space.** Conversion is skipped when the source already matches the
   requested interpretation, preventing an 8-bit sRGB round-trip from altering
   RGB16/scRGB data.
6. **Determinism.** Each frame/level gets a fresh pipeline on its own copied
   Buffer; results are placed at fixed array indices. Concurrency level and
   scheduling order therefore cannot change output bytes. PNG encoding uses a
   fixed configuration with metadata disabled.

## Input validation and failure semantics

`validateInput` runs before the cache key is computed and before any output
allocation, so a rejected request leaves no partial artifact. It verifies
buffer presence, dimensions, the EXIF orientation range (1–8), channel count,
page/page-height divisibility, per-frame delay arrays, and then forces a real
pixel decode (`.stats()`, sequential read) because header-only metadata accepts
truncated streams. Every rejection carries a stable `ErrorCode`:

| Code | Trigger |
| --- | --- |
| `PYR_INPUT_EMPTY` | missing or zero-length input |
| `PYR_INPUT_TOO_LARGE` | dimension/pixel/memory cap exceeded |
| `PYR_INPUT_UNREADABLE` | input cannot be opened |
| `PYR_INPUT_CORRUPT` | corrupt header/body, truncated or undecodable pixels |
| `PYR_INPUT_UNSUPPORTED` | unrecognised format |
| `PYR_INPUT_DIMENSION_MISMATCH` | geometry, orientation, page or delay inconsistency |
| `PYR_OPTION_INVALID` | unknown option or value outside the whitelist |
| `PYR_FRAME_FAILED` | a frame/level failed; the whole job rejects |
| `PYR_CACHE_CORRUPT` | on-disk entry failed shape/version/hash checks |
| `PYR_CACHE_IO` | cache write/read failure |
| `PYR_SERVICE_BUSY` / `PYR_SERVICE_SHUTTING_DOWN` / `PYR_JOB_NOT_FOUND` | service layer |

For animation/multi-page inputs, any failing frame rejects the entire job with
the frame index in `details.failedFrames`; nothing is cached and no partial
result is returned. Per-frame `delayMs` and the loop count are carried through
positionally.

## Cache key and invalidation

```
sha256( RULE_VERSION | sha256(input bytes) | colourspace | orientation
        | mirror | kernel | maxLevels | minLevelDimension )
```

- `RULE_VERSION` (`pyr-rule-1`) bumps whenever pixel/encoding rules change.
- Colour-space, orientation and mirror parameters are part of the key, so
  parameter variants never share output.
- Entries are written to a temp file and atomically renamed; the manifest uses
  the same temp+rename pattern. Reads verify every payload hash and the stored
  rule version; failures move the entry to `quarantine/` and the request
  rebuilds rather than failing.
- TTL expiry and an LRU-ish `maxEntries` cap provide eviction.

## HTTP service

- `GET /health` — pure state (event-loop lag, queue depth, counters); never
  touches image codecs, so it stays responsive while encodes run.
- `POST /jobs` — body `{ "image": "<base64>", "options": { ... } }`; returns
  `202 { id }`. A bounded queue returns `503 PYR_SERVICE_BUSY` on overflow.
- `GET /jobs/:id` — `202` while queued/running, `200` on success, `422` with a
  stable code on failure, `404 PYR_JOB_NOT_FOUND` otherwise.
- Shutdown is two-phase: `beginShutdown()` flips the acceptance gate while still
  listening (new requests get an explicit 503), then `shutdown()` waits up to
  `shutdownTimeoutMs`, force-fails anything still running, closes the server and
  removes the temp upload directory. SIGINT/SIGTERM are wired in `serve.mjs`.

## Test map

| File | Focus |
| --- | --- |
| `test/geometry.test.mjs` | boundary sizes, ceil rounding, option whitelist, size cap |
| `test/orientation.test.mjs` | EXIF auto/keep, all mirror modes, orientation range guard |
| `test/alpha.test.mjs` | alpha retention, premultiplied no-bleed, semi-transparency |
| `test/animation.test.mjs` | frame count, delays, loop, failed-frame rejection, direct-decode equality |
| `test/concurrency.test.mjs` | pool ordering, in-flight de-dup, concurrency invariance, key composition |
| `test/cache.test.mjs` | restart hits, tamper quarantine, version guard, TTL, LRU, temp cleanup |
| `test/validation-failure.test.mjs` | every corrupt input, stable codes, no artifacts, metadata inconsistencies |
| `test/determinism.test.mjs` | stable rerun summaries, operational-config invariance |
| `test/service.test.mjs` | health non-blocking, queue cap, shutdown deadline, temp cleanup |
| `test/utilities.test.mjs` | frame-strip join, file hashing, peak-memory estimate |
| `test/e2e.test.mjs` | full HTTP→pipeline→cache chain and mid-sequence restart regression |

See `DIAGNOSTICS.md` for the assertion-to-code traceability matrix and the
explicit list of conditions not covered.
