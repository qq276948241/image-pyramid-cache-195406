/*!
  Rule versioning, option defaults and pure pyramid geometry.

  RULE_VERSION is embedded in every cache key: any change to the deterministic
  processing rules below (sampling kernel, rounding, level math, frame order,
  encoding) MUST bump RULE_VERSION so old cache entries are never reused for
  new outputs. Cache entries also carry the version explicitly and are
  rejected on mismatch (see cache.mjs).
*/

/** Bump on any change that alters produced pixels or encoded bytes. */
export const RULE_VERSION = 'pyr-rule-1';

/** Allowed output colour spaces; sharp silently ignores unknown values, so we validate. */
export const COLOURSPACES = Object.freeze(['srgb', 'rgb16', 'grey', 'scrgb']);

/** Allowed orientation directives in pipeline options. */
export const ORIENTATIONS = Object.freeze(['auto', 'keep']);

/** Allowed flop/flip directives. */
export const MIRROR_MODES = Object.freeze(['none', 'horizontal', 'vertical', 'both']);

/** Allowed resampling kernels (sharp validates these; we reject others up front). */
export const KERNELS = Object.freeze(['nearest', 'cubic', 'mitchell', 'lanczos2', 'lanczos3']);

export const DEFAULTS = Object.freeze({
  /** Maximum level-0 dimension (longest side) the pipeline accepts. */
  maxDimension: 16384,
  /** Maximum number of pixels (width * height * pages) the pipeline accepts. */
  maxPixels: 268_435_456, // 16384^2
  /** Minimum level dimension; levels stop once the longest side reaches this. */
  minLevelDimension: 1,
  /** Max levels a caller may request. */
  maxLevels: 16,
  /** Sampling kernel used for every level (> level 0). */
  kernel: 'lanczos3',
  colourspace: 'srgb',
  orientation: 'auto',
  mirror: 'none',
  /** Output container for encoded pyramid data. */
  format: 'png',
  /** Per-frame processing concurrency inside one job. */
  frameConcurrency: 1,
  /** Reject (rather than spill) if estimated peak RAM exceeds this many bytes. */
  maxMemoryBytes: 512 * 1024 * 1024,
});

/**
 * Level dimensions with documented rounding.
 *
 * Coordinate system: origin (0,0) at the TOP-LEFT of the stored pixel array,
 * x grows right, y grows down. Level 0 is the stored (post-orientation) image.
 * Each level halves the previous level's dimensions. Integer rounding is
 * "round half up" (ceil) so an odd dimension N maps to ceil(N/2); the minimum
 * dimension is clamped to 1, meaning the final level is always >= 1x1.
 *
 * Halting: levels stop at maxLevels, at convergence (1x1), or when the next
 * candidate's longest side would be smaller than minLevelDimension — whichever
 * comes first. minLevelDimension = 1 yields the full chain down to 1x1.
 *
 * @param {number} width level-0 width in pixels
 * @param {number} height level-0 height in pixels
 * @param {number} [maxLevels]
 * @param {number} [minLevelDimension]
 * @returns {{ level: number, width: number, height: number }[]}
 */
export function levelDimensions (width, height, maxLevels = DEFAULTS.maxLevels, minLevelDimension = 1) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('levelDimensions: positive integer width/height required');
  }
  if (!Number.isInteger(maxLevels) || maxLevels < 1) {
    throw new TypeError('levelDimensions: positive integer maxLevels required');
  }
  if (!Number.isInteger(minLevelDimension) || minLevelDimension < 1) {
    throw new TypeError('levelDimensions: positive integer minLevelDimension required');
  }
  const levels = [{ level: 0, width, height }];
  let w = width;
  let h = height;
  while (levels.length < maxLevels) {
    const nextW = Math.max(1, Math.ceil(w / 2));
    const nextH = Math.max(1, Math.ceil(h / 2));
    if (nextW === w && nextH === h) break; // converged at 1x1
    if (Math.max(nextW, nextH) < minLevelDimension) break;
    w = nextW;
    h = nextH;
    levels.push({ level: levels.length, width: w, height: h });
  }
  return levels;
}

/**
 * Normalise and validate the public pipeline options against the whitelists.
 * Unknown keys are rejected rather than ignored so callers cannot silently
 * rely on a typo'd parameter.
 *
 * @param {Record<string, unknown>} [input]
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function normaliseOptions (input = {}) {
  const out = { ...DEFAULTS };
  const known = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new TypeError(`Unknown option '${key}'`);
    }
  }
  const integerKeys = ['maxDimension', 'maxPixels', 'minLevelDimension', 'maxLevels', 'frameConcurrency', 'maxMemoryBytes'];
  for (const key of integerKeys) {
    const v = input[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 1) {
      throw new TypeError(`Option '${key}' must be a positive integer, got ${JSON.stringify(v)}`);
    }
    out[key] = v;
  }
  if (input.colourspace !== undefined) {
    if (!COLOURSPACES.includes(input.colourspace)) {
      throw new TypeError(`Option 'colourspace' must be one of ${COLOURSPACES.join('/')}, got ${JSON.stringify(input.colourspace)}`);
    }
    out.colourspace = input.colourspace;
  }
  if (input.orientation !== undefined) {
    if (!ORIENTATIONS.includes(input.orientation)) {
      throw new TypeError(`Option 'orientation' must be one of ${ORIENTATIONS.join('/')}`);
    }
    out.orientation = input.orientation;
  }
  if (input.mirror !== undefined) {
    if (!MIRROR_MODES.includes(input.mirror)) {
      throw new TypeError(`Option 'mirror' must be one of ${MIRROR_MODES.join('/')}`);
    }
    out.mirror = input.mirror;
  }
  if (input.kernel !== undefined) {
    if (!KERNELS.includes(input.kernel)) {
      throw new TypeError(`Option 'kernel' must be one of ${KERNELS.join('/')}, got ${JSON.stringify(input.kernel)}`);
    }
    out.kernel = input.kernel;
  }
  if (input.format !== undefined) {
    if (input.format !== 'png') {
      throw new TypeError("Option 'format' only supports 'png' (deterministic lossless container)");
    }
  }
  return Object.freeze(out);
}
