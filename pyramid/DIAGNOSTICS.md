# Diagnostics and traceability

This document maps every asserted behaviour to (a) the test file and line,
(b) the production function it exercises, and (c) the observable output it
checks. It also lists, explicitly rather than implicitly, the conditions this
delivery does **not** cover.

## How to reproduce

```bash
cd pyramid
npm install
npm test            # node:test, 73 assertions across 11 files, non-zero exit on failure
npm run acceptance  # 10 cross-module checks, rerun-stable acceptance/summary.json
```

Both commands exit `0` only when every assertion passes. The acceptance harness
runs the full chain twice and fails if the two content summaries differ.

## Assertion traceability matrix

### Geometry, boundary sizes and rounding — `test/geometry.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| 1x1 stays a single level (`:7`) | `levelDimensions` `lib/constants.mjs` | level array `[{0,1,1}]` |
| odd sizes use ceil(N/2) (`:11`) | `levelDimensions` | `3x7 → 2x4 → 1x2 → 1x1` |
| non-square halve + clamp at 1 (`:20`) | `levelDimensions` | `7x3 → 4x2 → 2x1 → 1x1` |
| maxLevels truncates (`:25`) | `levelDimensions` | returned level count |
| rejects non-positive/non-integer (`:30`) | `levelDimensions` | thrown `TypeError` |
| unknown keys / bad whitelist values (`:36`) | `normaliseOptions` `lib/constants.mjs` | thrown `TypeError` naming the option |
| every whitelisted kernel accepted (`:45`) | `normaliseOptions` (`KERNELS`) | echoed kernel value |
| minLevelDimension halts chain before floor (`:51`) | `levelDimensions` | chain stops at `9x5` for floor 8 |
| minLevelDimension shortens pipeline output (`:60`) | `generate` + `computeCacheKey` | fewer levels; distinct cache key |
| boundary sizes produce valid pyramids (`:78`) | `PyramidPipeline.generate` `lib/pipeline.mjs` | per-level `width/height` equals pure geometry |
| over-limit dimensions (`:109`) | `validateInput` `lib/validation.mjs` | `PYR_INPUT_TOO_LARGE` |

### Rotation and mirror — `test/orientation.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| EXIF 6 auto swaps 40x24→24x40 and pixels match sharp `.rotate()` (`:12`) | `extractFrames` `lib/processing.mjs` | level-0 dimensions + raw pixel equality |
| keep mode preserves stored dims (`:35`) | `extractFrames` (rotate skipped) | level-0 `40x24`, `orientationMode:'keep'` |
| auto vs keep differ (`:50`) | `computeCacheKey` `lib/cache.mjs` + pixels | distinct key and level-0 sha256 |
| four mirror modes distinct and keyed (`:68`) | `applyMirror`/`extractFrames`, `computeCacheKey` | 4 distinct hashes; 4 distinct keys |
| mirror both == flop+flip (`:96`) | `applyMirror` | raw pixel equality with sharp reference |
| orientation outside 1..8 rejected (`:111`) | `validateInput` via `setMetadataProbe` seam | `PYR_INPUT_DIMENSION_MISMATCH` |

### Alpha semantics — `test/alpha.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| alpha retained on every level (`:8`) | `buildFramePyramid` `lib/processing.mjs` | decoded `channels === 4` per level |
| no RGB bleed from transparent pixels (`:25`) | Lanczos3 premultiplied resize | transparent px `[0,0,0,0]`; opaque px blue-dominant |
| 50% alpha pixel survives level 0 (`:78`) | `buildFramePyramid` | alpha byte `128` at column 8 |
| no invented alpha for opaque input (`:95`) | `extractFrames` | decoded channels `<= 3` |

### Animation / multi-page — `test/animation.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| WebP frame count, delays, loop (`:12`) | `PyramidPipeline.#runJob` | 4 frames, `[100,150,200,250]`, loop 2 |
| GIF/TIFF counts and TIFF default delays (`:33`) | `#runJob` | 4 frames; GIF delays preserved; TIFF delays 0 |
| failing frame rejects whole job (`:51`) | `runPool` `lib/pipeline.mjs` | `PYR_FRAME_FAILED`, `details.failedFrames=[2]` |
| failed job writes nothing (`:72`) | `setFrameBuilder` seam + `DiskCache` | manifest size unchanged |
| WebP output == direct raw decode (`:109`) | full processing path | per-frame pixel sha256 equality |
| GIF output == direct GIF decode (`:136`) | full processing path | per-frame pixel sha256 equality |

### Concurrency and ordering — `test/concurrency.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| fixed output positions under out-of-order completion (`:11`) | `runPool` | `[20,40,60,80,100]` |
| shuffled schedule identical output (`:23`) | `runPool` (injected schedule) | deep-equal arrays |
| repeat submissions use cache (`:36`) | `generate` + `DiskCache.get` | `cacheHit` false→true→true |
| concurrent identical submissions de-dup (`:59`) | in-flight `Map` in `generate` | one key, four identical payloads |
| concurrent distinct inputs independent (`:80`) | `generate` | 5 distinct keys; reruns are hits with equal hashes |
| concurrency 1 vs 8 byte-identical (`:111`) | `runPool` + processing | equal key and all level hashes |
| key encodes version/colour/orientation (`:135`) | `computeCacheKey` | variants change the 64-char key |

### Disk cache and invalidation — `test/cache.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| cache hit after restart (`:25`) | `DiskCache` init + `get` | `cacheHit:true`, equal hashes |
| on-disk version and option fingerprint (`:48`) | `DiskCache.put` | entry `version`, `options.*`, source sha256 |
| tampered payload quarantined + rebuilt (`:66`) | `DiskCache.get` hash check | `PYR_CACHE_CORRUPT`, quarantine file, rebuild |
| foreign rule version rejected (`:101`) | `validateEntry` | `PYR_CACHE_CORRUPT` mentioning version |
| TTL expiry (`:124`) | `DiskCache.get` TTL branch | first `get` ok, later `get` null |
| LRU eviction (`:158`) | `#enforceMaxEntries` | oldest key removed, size capped |
| no temp files after writes (`:180`) | atomic temp+rename | `tmp/` has no `.tmp` |
| clear() empties everything (`:195`) | `DiskCache.clear` | empty manifest/entries/quarantine |

### Corrupt input and failure paths — `test/validation-failure.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| empty buffer (`:14`) | `validateInput` | `PYR_INPUT_EMPTY` |
| garbage bytes (`:22`) | `mapSharpInputError` | `PYR_INPUT_UNSUPPORTED` |
| truncated / bad-body PNG (`:30`) | decode preflight `.stats()` | `PYR_INPUT_CORRUPT` |
| non-Buffer rejected pre-decode (`:40`) | `validateInput` type guard | `PYR_OPTION_INVALID`/`INPUT_EMPTY` |
| rejection leaves no artifacts (`:57`) | whole pipeline | empty `entries/` and `tmp/` |
| every rejection carries a stable code (`:81`) | `mapSharpInputError` | exact code per sample |
| delay length mismatch (`:101`) | `validateInput` frame checks | `PYR_INPUT_DIMENSION_MISMATCH` |
| height not divisible by pageHeight (`:126`) | `validateInput` | `PYR_INPUT_DIMENSION_MISMATCH` |
| negative delay (`:151`) | `validateInput` | `PYR_INPUT_DIMENSION_MISMATCH` |
| memory cap (`:176`) | `estimatePeakMemory` + `#runJob` | `PYR_INPUT_TOO_LARGE` |
| invalid kernel pre-decode (`:194`) | `normaliseOptions` kernel whitelist | `PYR_OPTION_INVALID` mentioning kernel |

### Determinism — `test/determinism.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| two independent runs identical (`:35`) | full pipeline, separate cache roots | equal pixel-summary objects |
| operational config invariance (`:63`) | `computeCacheKey` (config excluded) | equal key and summary |
| relevant option changes do change pixels (`:85`) | colourspace path | different key and pixel hash |
| geometry stable across boundary samples (`:104`) | `levelDimensions` vs output | equal dimension arrays |

### Service — `test/service.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| health shape and counters (`:53`) | `PyramidService.#handle` GET /health | 200 JSON, no codec call |
| health stays fast during encodes (`:67`) | health path under load | max latency < 500 ms |
| queue overflow (`:99`) | `#submitJob` capacity gate | 503 `PYR_SERVICE_BUSY` |
| corrupt job queryable failure (`:130`) | `#runJob` | 422 + stable code, counter |
| unknown job (`:146`) | GET /jobs/:id | 404 `PYR_JOB_NOT_FOUND` |
| graceful shutdown + temp cleanup (`:158`) | `shutdown`/`#doShutdown` | `timedOut:false`, temp root gone |
| deadline force-fails overrun job (`:179`) | `#doShutdown` + `cancelledJobs` | `timedOut:true`, job `PYR_SERVICE_SHUTTING_DOWN` |
| 503 while gate closed but listening (`:211`) | `beginShutdown` then POST | 503 (not ECONNREFUSED) |

### Utility functions — `test/utilities.test.mjs`

| Assertion (file:line) | Function under test | Observable output |
| --- | --- | --- |
| frame PNGs joined into a vertical strip (`:17`) | `joinLevelFrames` `lib/processing.mjs` | decoded height = 3× frame height |
| mismatched frame dimensions rejected (`:31`) | `joinLevelFrames` | `PYR_FRAME_FAILED` mentioning mismatch |
| file hash equals in-memory sha256 (`:42`) | `hashFile` `lib/cache.mjs` | 64-char hex equality |
| peak-memory estimate monotonic and integral (`:57`) | `estimatePeakMemory` | larger for more pages; positive integer |

### Cross-module regression — `test/e2e.test.mjs`

| Assertion (file:line) | Chain exercised | Observable output |
| --- | --- | --- |
| full HTTP→pipeline→cache chain (`:39`) | service → validation → processing → disk | persisted entry with version/options; health counters |
| corrupt HTTP job never cached (`:89`) | service → validation | failed status, empty manifest |
| mid-sequence restart (`:120`) | new pipeline/service on same root | `cacheHit:true`, identical hashes and delays |
| shutdown temp cleanup (`:162`) | service lifecycle | temp root removed, clean close |

### Acceptance harness — `scripts/acceptance.mjs`

Ten checks covering dual-run summary stability, boundary geometry, EXIF
rotation, alpha, animation timing, repeat/cache-key rules, corrupt-input
artifact absence, restart hits, service health/shutdown and operational-config
invariance. Output: `acceptance/summary.json` (rerun-stable) and stdout
PASS/FAIL lines; non-zero exit on any failure.

## Conditions NOT covered

These are deliberate, stated limitations rather than silent gaps:

1. **Full 16-bit / floating-point pixel fidelity.** The pipeline can request
   `rgb16`/`scrgb`, but the deterministic output container is 8-bit PNG, so
   >8-bit sources are quantised on output. No test asserts bit-exact 16-bit
   round-trips.
2. **Every one of the 8 EXIF orientations.** Tests pin orientation 6 (the
   common 90° CW swap) plus the 1..8 validation guard; orientations 2–5 and
   7–8 rely on libvips' own tested `.rotate()` rather than dedicated fixtures.
3. **ICCP colour-profile transforms and CMYK.** Profile-based gamut mapping and
   CMYK→sRGB are delegated to libvips and are not asserted with profile
   fixtures; only the interpretation whitelist and skip-if-matching logic are
   tested.
4. **Very large images under real memory pressure.** The memory strategy is a
   pre-flight estimate (`estimatePeakMemory`) and sequential validation decode;
   behaviour near physical RAM limits is not exercised (no multi-gigabyte
   fixtures), only the cap's rejection path.
5. **Disk-full / filesystem-permission failures.** Atomic rename and write
   error mapping (`PYR_CACHE_IO`) exist, but injecting ENOSPC/EACCES requires
   platform-specific fault injection and is not tested.
6. **Network deployment concerns.** The service binds 127.0.0.1 only; TLS,
   authentication, rate limiting and multi-instance cache sharing are out of
   scope. The disk cache is single-process-safe by atomic write, not designed
   for concurrent writers from multiple hosts.
7. **APNG animation of the joined strip.** `joinLevelFrames` is provided and
   unit-usable but the published per-frame payloads are independent PNGs;
   playback of an animated strip container is not asserted end-to-end.
8. **Concurrent-process cache coherence.** Tests cover threads/event-loop
   concurrency within one process and restart-on-disk reuse, not two processes
   writing the same key simultaneously.
9. **Garbage-collection/leak measurements.** No long-running leak detector is
   wired (the upstream repo has its own leak harness outside this subsystem).
