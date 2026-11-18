/*!
  Core pixel processing: frame extraction, orientation, per-frame pyramid
  levels and deterministic reassembly.

  Determinism guarantees
  ----------------------
  1. Coordinate system: origin (0,0) at the TOP-LEFT of the stored pixel
     array; x grows right, y grows down. Level 0 is the image AFTER the
     orientation directive is applied, so cache keys never depend on EXIF
     state that two decoders could interpret differently.
  2. Sampling: every level > 0 is produced by a single sharp resize using the
     Lanczos3 kernel, sourcing pixels exclusively from level 0 (never from an
     already-downsampled level). Boundary handling is libvips' default VIPS_EXTEND
     (edge clamp): out-of-range samples read the nearest edge pixel.
  3. Integer rounding: target dimensions come from levelDimensions()
     (ceil(N/2), clamped to >= 1); no fractional pixel sizes are ever passed
     to the encoder.
  4. Alpha semantics: when an alpha channel exists, sharp premultiplies colour
     values by alpha before resampling and unpremultiplies afterwards, so
     fully transparent pixels do not bleed RGB fringes. Alpha is retained
     end-to-end and encoded in the output PNG.
  5. No shared mutable state: every frame/level gets its own fresh sharp
     pipeline on its own Buffer; no buffer is ever passed to two pipelines.
     Results are placed into pre-sized arrays at fixed indices, therefore
     concurrent processing and reordered scheduling produce identical bytes.
  6. Encoding: PNG only, with metadata disabled, so encoded bytes depend solely
     on pixel content (verified byte-identical across reruns in the test suite).
*/

import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { ErrorCode, PyramidError } from './errors.mjs';
import { levelDimensions } from './constants.mjs';

/**
 * Apply mirror directive with flop()/flip() (no EXIF involved).
 * @param {import('sharp').Sharp} pipeline
 * @param {'none'|'horizontal'|'vertical'|'both'} mirror
 * @returns {import('sharp').Sharp}
 */
function applyMirror (pipeline, mirror) {
  if (mirror === 'horizontal' || mirror === 'both') pipeline.flop();
  if (mirror === 'vertical' || mirror === 'both') pipeline.flip();
  return pipeline;
}

/**
 * Extract frames as independent raw pixel buffers.
 *
 * One decode of the whole (possibly animated) input applies, in order:
 * EXIF auto-orientation (when options.orientation === 'auto'), mirror
 * directives and colour-space conversion — BEFORE raw pixel output. This
 * ordering matters because raw pixels carry no EXIF header; orientation can
 * only be honoured during the decode that still sees it. Each frame is then
 * copied into its own Buffer so downstream pipelines never share memory.
 *
 * @param {Buffer} buffer encoded input
 * @param {import('./validation.mjs').Descriptor} descriptor validated metadata
 * @param {object} options normalised options
 * @returns {Promise<{ frames: Buffer[], width: number, height: number, channels: number, hasAlpha: boolean }>}
 */
export async function extractFrames (buffer, descriptor, options) {
  let data;
  let info;
  let pipeline;
  try {
    pipeline = sharp(buffer, {
      pages: -1,
      animated: true,
      limitInputPixels: options.maxPixels,
    });
    if (options.orientation === 'auto' && descriptor.orientation && descriptor.orientation !== 1) {
      pipeline.rotate(); // applies EXIF orientation to every page and clears the tag
    }
    applyMirror(pipeline, options.mirror);
    // Only convert when the requested interpretation actually differs from the
    // source: an unconditional conversion would round-trip RGB16/scRGB data
    // through 8-bit sRGB and change pixels despite "identical" colour spaces.
    const targetSpace = options.colourspace === 'grey' ? 'b-w' : options.colourspace;
    if (descriptor.space !== targetSpace) {
      pipeline.toColourspace(targetSpace);
    }

    ({ data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw new PyramidError(
      ErrorCode.INPUT_CORRUPT,
      `Pixel decode failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      { cause: err },
    );
  }

  const pages = info.pages ?? 1;
  const frameHeight = info.pageHeight ?? info.height;
  if (pages !== descriptor.pages) {
    throw new PyramidError(
      ErrorCode.INPUT_DIMENSION_MISMATCH,
      `Decoded page count ${pages} disagrees with validated metadata ${descriptor.pages}`,
    );
  }
  const frameBytes = info.width * frameHeight * info.channels;
  /** @type {Buffer[]} */
  const frames = [];
  for (let p = 0; p < pages; p++) {
    // Independent copy: subarray() would alias the parent buffer.
    frames.push(Buffer.from(data.subarray(p * frameBytes, (p + 1) * frameBytes)));
  }
  return {
    frames,
    width: info.width,
    height: frameHeight,
    channels: info.channels,
    hasAlpha: info.channels === 4,
  };
}

/**
 * Build every pyramid level for ONE already-normalised raw frame.
 *
 * Frames arrive here AFTER decode-time orientation/mirror/colourspace work,
 * so no EXIF interpretation remains: level 0 is exactly the frame's stored
 * pixels. Higher levels are independent resamplings of level 0.
 *
 * @param {Buffer} frame raw pixels of one frame (no EXIF, pre-normalised)
 * @param {{width: number, height: number, channels: number}} frameInfo
 * @param {object} options normalised options
 * @returns {Promise<{ level: number, width: number, height: number, png: Buffer }[]>}
 */
export async function buildFramePyramid (frame, frameInfo, options) {
  return frameBuilder(frame, frameInfo, options);
}

/**
 * Mutable seam used by buildFramePyramid. Production uses the default
 * implementation below; tests inject a failing builder via setFrameBuilder()
 * to exercise the failed-frame path deterministically.
 * @type {(frame: Buffer, info: object, options: object) => Promise<object[]>}
 */
export let frameBuilder = defaultBuildFramePyramid;

/** Test-only seam: replace the per-frame builder. Returns a restore function. */
export function setFrameBuilder (builder) {
  const previous = frameBuilder;
  frameBuilder = builder;
  return () => { frameBuilder = previous; };
}

/**
 * @param {Buffer} frame
 * @param {{width: number, height: number, channels: number}} frameInfo
 * @param {object} options
 */
async function defaultBuildFramePyramid (frame, frameInfo, options) {
  const basePixels = frame;
  const baseWidth = frameInfo.width;
  const baseHeight = frameInfo.height;
  const channels = frameInfo.channels;

  const levels = levelDimensions(baseWidth, baseHeight, options.maxLevels, options.minLevelDimension);
  /** @type {{ level: number, width: number, height: number, png: Buffer }[]} */
  const result = new Array(levels.length);

  // Level 0: encode normalised base pixels.
  result[0] = {
    level: 0,
    width: baseWidth,
    height: baseHeight,
    png: await encodePng(basePixels, baseWidth, baseHeight, channels, options),
  };

  // Levels > 0: each resamples level 0 independently. Scheduling is sequential
  // here; the per-frame caller may run frames concurrently, but a single
  // frame's levels stay ordered to keep peak RAM bounded and output order fixed.
  for (let i = 1; i < levels.length; i++) {
    const target = levels[i];
    let resized;
    try {
      resized = await sharp(basePixels, {
        raw: { width: baseWidth, height: baseHeight, channels },
        limitInputPixels: options.maxPixels,
      })
        .resize(target.width, target.height, { kernel: options.kernel, fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (err) {
      throw new PyramidError(
        ErrorCode.FRAME_FAILED,
        `Level ${target.level} resample failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        { cause: err, details: { level: target.level } },
      );
    }
    result[i] = {
      level: target.level,
      width: target.width,
      height: target.height,
      png: await encodePng(resized.data, target.width, target.height, channels, options),
    };
    // resized buffer goes out of scope here; nothing retains it but the PNG.
  }
  return result;
}

/**
 * Deterministic PNG encode of raw pixels.
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {object} options
 * @returns {Promise<Buffer>}
 */
async function encodePng (pixels, width, height, channels, options) {
  try {
    return await sharp(pixels, {
      raw: { width, height, channels },
      limitInputPixels: options.maxPixels,
    })
      .png({ compressionLevel: 9 })
      .withMetadata(false)
      .toBuffer();
  } catch (err) {
    throw new PyramidError(
      ErrorCode.FRAME_FAILED,
      `PNG encode failed at ${width}x${height}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Concatenate per-frame PNG bytes of one level into a vertical-strip animated
 * PNG (APNG-capable decoders see frames; ordinary decoders see the strip).
 * Frames are taken in index order regardless of how they were scheduled.
 *
 * @param {Buffer[]} framePngs one PNG per frame, all sharing dimensions
 * @param {number} width
 * @param {number} frameHeight
 * @param {number} channels
 * @param {object} options
 * @returns {Promise<Buffer>}
 */
export async function joinLevelFrames (framePngs, width, frameHeight, channels, options) {
  /** @type {Buffer[]} */
  const rawFrames = [];
  for (const png of framePngs) {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== frameHeight || info.channels !== channels) {
      throw new PyramidError(
        ErrorCode.FRAME_FAILED,
        `Frame join dimension mismatch: got ${info.width}x${info.height}x${info.channels}, expected ${width}x${frameHeight}x${channels}`,
      );
    }
    rawFrames.push(data);
  }
  const strip = Buffer.concat(rawFrames);
  return encodePng(strip, width, frameHeight * framePngs.length, channels, options);
}

/**
 * Estimate peak RAM for a job so callers can reject pathological inputs before
 * allocating. The estimate covers decoded level-0 pixels plus one resample
 * buffer at a time (levels are produced sequentially and released).
 *
 * @param {import('./validation.mjs').Descriptor} descriptor
 * @param {number} channels decoded channel count
 * @returns {number}
 */
export function estimatePeakMemory (descriptor, channels) {
  const framePixels = descriptor.width * descriptor.pageHeight * channels;
  // Whole decoded input + one frame base + one resample (<= base) + PNG slack.
  return descriptor.pages * framePixels + framePixels * 2 + framePixels;
}
