/*!
  End-to-end pyramid pipeline: validation -> cache lookup -> frame processing
  -> atomic publication.

  In-flight de-duplication: identical submissions (same cache key) arriving
  concurrently share one computation; every caller receives the same result
  and a failed computation rejects every waiting caller — there is no path
  where a second caller is told "success" from a partial run.

  Failure semantics for animation/multi-page inputs: frames are processed
  independently; if any frame fails, the whole job rejects with
  FRAME_FAILED naming the frame index, nothing is written to the cache, and
  no partial result is returned. Per-frame timestamps (delayMs) and loop
  metadata are carried through verbatim.
*/

import { createHash } from 'node:crypto';
import { ErrorCode, PyramidError } from './errors.mjs';
import { normaliseOptions, RULE_VERSION } from './constants.mjs';
import { validateInput } from './validation.mjs';
import { buildFramePyramid, estimatePeakMemory, extractFrames } from './processing.mjs';
import { computeCacheKey, DiskCache } from './cache.mjs';

/**
 * Run an array of work items through a worker with bounded concurrency.
 * Items are invoked by index; output is placed at the same index, so the
 * returned array is identical regardless of completion order. The schedule
 * is injectable (tests shuffle it) to prove order-independence.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} concurrency
 * @param {(indices: number[]) => number[]} [schedule] maps remaining indices to pick order
 * @returns {Promise<R[]>}
 */
export async function runPool (items, worker, concurrency, schedule = indices => indices) {
  const results = new Array(items.length);
  const remaining = items.map((_, i) => i);
  const failures = [];

  async function workerLoop () {
    while (remaining.length > 0) {
      const [next] = schedule(remaining);
      const idx = remaining.splice(remaining.indexOf(next), 1)[0];
      if (idx === undefined) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        failures.push({ index: idx, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, workerLoop);
  await Promise.all(runners);
  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    const first = failures[0];
    throw new PyramidError(
      ErrorCode.FRAME_FAILED,
      `Frame ${first.index} failed: ${first.error.message}`,
      { cause: first.error, details: { failedFrames: failures.map(f => f.index), frameCount: items.length } },
    );
  }
  return results;
}

export class PyramidPipeline {
  /**
   * @param {object} [config]
   * @param {string} [config.cacheRoot] if omitted, caching is disabled
   * @param {Record<string, unknown>} [config.defaults] default pipeline options
   */
  constructor ({ cacheRoot, defaults = {} } = {}) {
    this.defaults = defaults;
    this.cache = cacheRoot ? new DiskCache(cacheRoot) : null;
    /** @type {Map<string, Promise<object>>} */
    this.inFlight = new Map();
  }

  /**
   * Generate (or fetch cached) pyramid for one input.
   *
   * @param {Buffer | Uint8Array} input encoded image bytes
   * @param {Record<string, unknown>} [callerOptions]
   * @param {{ schedule?: (indices: number[]) => number[] }} [internals]
   * @returns {Promise<object>} published pyramid result
   */
  async generate (input, callerOptions = {}, internals = {}) {
    let options;
    try {
      options = normaliseOptions({ ...this.defaults, ...callerOptions });
    } catch (err) {
      throw new PyramidError(
        ErrorCode.OPTION_INVALID,
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }

    // Validation happens BEFORE the cache key touches anything and before any
    // output allocation; rejected inputs leave zero artifacts.
    const descriptor = await validateInput(input, options);
    const key = computeCacheKey(descriptor.buffer, options);

    if (this.cache) {
      const cached = await this.cache.get(key).catch(err => {
        // Corrupt cache must never fail the request: fall through to rebuild.
        if (err instanceof PyramidError && err.code === ErrorCode.CACHE_CORRUPT) return null;
        throw err;
      });
      if (cached) return { ...cached, cacheHit: true };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = this.#runJob(key, descriptor, options, internals)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  /**
   * @param {string} key
   * @param {import('./validation.mjs').Descriptor} descriptor
   * @param {object} options
   * @param {{ schedule?: (indices: number[]) => number[] }} internals
   */
  async #runJob (key, descriptor, options, internals) {
    const peakMemory = estimatePeakMemory(descriptor, descriptor.hasAlpha ? 4 : Math.min(3, descriptor.channels));
    if (peakMemory > options.maxMemoryBytes) {
      throw new PyramidError(
        ErrorCode.INPUT_TOO_LARGE,
        `Estimated peak memory ${peakMemory} bytes exceeds maxMemoryBytes ${options.maxMemoryBytes}`,
        { details: { peakMemory, maxMemoryBytes: options.maxMemoryBytes } },
      );
    }

    const { frames, width, height, channels } = await extractFrames(descriptor.buffer, descriptor, options);

    // Each frame is an independent work item using only its own Buffer.
    const frameResults = await runPool(
      frames,
      (framePixels) => buildFramePyramid(framePixels, {
        width,
        height,
        channels,
      }, options),
      Math.max(1, options.frameConcurrency),
      internals.schedule,
    );

    // All frames succeeded: assemble the publication payload. Timing metadata
    // is copied positionally so frame i always pairs with delayMs[i].
    const published = {
      version: RULE_VERSION,
      key,
      createdAt: Date.now(),
      source: {
        format: descriptor.format,
        width: descriptor.width,
        pageHeight: descriptor.pageHeight,
        pages: descriptor.pages,
        channels: descriptor.channels,
        hasAlpha: descriptor.hasAlpha,
        // EXIF tag as stored in the source (1..8 or undefined); the pixels
        // below are already normalised when orientation === 'auto'.
        exifOrientation: descriptor.orientation ?? 1,
        orientationMode: options.orientation,
        sha256: createHash('sha256').update(descriptor.buffer).digest('hex'),
      },
      options: {
        colourspace: options.colourspace,
        orientation: options.orientation,
        mirror: options.mirror,
        kernel: options.kernel,
        maxLevels: options.maxLevels,
        minLevelDimension: options.minLevelDimension,
      },
      frames: frameResults.map((levels, frameIndex) => ({
        frame: frameIndex,
        delayMs: descriptor.delay?.[frameIndex] ?? 0,
        levels: levels.map(level => ({
          level: level.level,
          width: level.width,
          height: level.height,
          sha256: createHash('sha256').update(level.png).digest('hex'),
          data: level.png.toString('base64'),
        })),
      })),
      loop: descriptor.loop ?? 0,
      cacheHit: false,
    };

    // Publication is the single atomic write; nothing is cached on failure
    // because the frame failure above rejects before reaching this point.
    if (this.cache) {
      await this.cache.put(key, { ...published, cacheHit: undefined });
    }
    return published;
  }

  async close () {
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    // Ensure any lazy cache initialisation has settled so callers can safely
    // remove the cache root immediately after close() without racing mkdir.
    if (this.cache) {
      await this.cache.ready.catch(() => {});
    }
  }
}
