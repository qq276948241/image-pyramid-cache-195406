/*!
  Public entry point of the pyramid-cache subsystem.

  The upstream sharp package entry points (root ./lib, ./dist) are untouched;
  this module is a separate, additive surface under ./pyramid.
*/

export { PyramidPipeline, runPool } from './pipeline.mjs';
export { DiskCache, computeCacheKey, hashFile } from './cache.mjs';
export { validateInput, probeMetadata, setMetadataProbe } from './validation.mjs';
export { buildFramePyramid, setFrameBuilder, extractFrames, joinLevelFrames, estimatePeakMemory } from './processing.mjs';
export { PyramidService } from './service.mjs';
export {
  RULE_VERSION,
  DEFAULTS,
  COLOURSPACES,
  ORIENTATIONS,
  MIRROR_MODES,
  levelDimensions,
  normaliseOptions,
} from './constants.mjs';
export { ErrorCode, PyramidError, toPyramidError } from './errors.mjs';
export { createSampleSet } from './samples.mjs';
