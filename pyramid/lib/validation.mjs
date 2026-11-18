/*!
  Input validation and metadata probing.

  Contract:
  - validateInput() performs ALL rejection checks before any output or cache
    write happens, so a rejected submission never leaves a partial pyramid.
  - Errors always carry a stable ErrorCode and a deterministic message.
  - Inconsistencies covered: dimension sanity, colour space / channel layout,
    EXIF orientation, and animation/page frame metadata (page count, height
    divisibility, per-frame timing arrays).
*/

import sharp from 'sharp';
import { ErrorCode, PyramidError } from './errors.mjs';

/**
 * Probe metadata without decoding pixels.
 *
 * Held as a mutable module binding (`metadataProbe`) so tests can inject a
 * deterministic stub for metadata-level boundary checks; production code only
 * ever calls the default sharp-backed implementation.
 *
 * @param {Buffer} buffer encoded input image
 * @param {object} options normalised pipeline options
 * @returns {Promise<import('sharp').Metadata>}
 */
export async function probeMetadata (buffer, options) {
  return metadataProbe(buffer, options);
}

/** @type {(buffer: Buffer, options: object) => Promise<import('sharp').Metadata>} */
export let metadataProbe = async function defaultMetadataProbe (buffer, options) {
  try {
    return await sharp(buffer, {
      pages: -1,
      limitInputPixels: options.maxPixels,
      animated: true,
    }).metadata();
  } catch (err) {
    throw mapSharpInputError(err);
  }
};

/** Test-only seam: replace the metadata probe. Returns a restore function. */
export function setMetadataProbe (probe) {
  const previous = metadataProbe;
  metadataProbe = probe;
  return () => { metadataProbe = previous; };
}

/**
 * Map a sharp/libvips error to a stable PyramidError.
 * @param {unknown} err
 * @returns {PyramidError}
 */
export function mapSharpInputError (err) {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n')[0];
  if (/empty/i.test(firstLine)) {
    return new PyramidError(ErrorCode.INPUT_EMPTY, 'Input buffer is empty', { cause: err });
  }
  if (/exceeds pixel limit/i.test(firstLine)) {
    return new PyramidError(ErrorCode.INPUT_TOO_LARGE, firstLine, { cause: err });
  }
  if (/corrupt|truncat|bad magic|not a/i.test(firstLine)) {
    return new PyramidError(ErrorCode.INPUT_CORRUPT, `Input image is corrupt: ${firstLine}`, { cause: err });
  }
  if (/unsupported/i.test(firstLine)) {
    return new PyramidError(ErrorCode.INPUT_UNSUPPORTED, `Unsupported input format: ${firstLine}`, { cause: err });
  }
  if (/missing|unable to read|cannot open/i.test(firstLine)) {
    return new PyramidError(ErrorCode.INPUT_UNREADABLE, `Input cannot be read: ${firstLine}`, { cause: err });
  }
  return new PyramidError(ErrorCode.INPUT_CORRUPT, `Input could not be decoded: ${firstLine}`, { cause: err });
}

/**
 * Full validation pass. Returns a frozen descriptor the pipeline consumes;
 * throws PyramidError on any inconsistency.
 *
 * @param {Buffer | Uint8Array} input
 * @param {object} options normalised options (from normaliseOptions)
 * @returns {Promise<{
 *   buffer: Buffer,
 *   format: string,
 *   width: number,
 *   height: number,
 *   pageHeight: number,
 *   pages: number,
 *   channels: number,
 *   hasAlpha: boolean,
 *   orientation: number | undefined,
 *   density: number | undefined,
 *   delay: number[] | undefined,
 *   loop: number | undefined,
 *   space: string | undefined,
 * }>}
 */
export async function validateInput (input, options) {
  // --- buffer / size checks -------------------------------------------------
  if (input === undefined || input === null) {
    throw new PyramidError(ErrorCode.INPUT_EMPTY, 'Input is required but was not provided');
  }
  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (input instanceof Uint8Array) {
    buffer = Buffer.from(input);
  } else {
    throw new PyramidError(
      ErrorCode.OPTION_INVALID,
      `Input must be a Buffer/Uint8Array, got ${input?.constructor?.name ?? typeof input}`,
    );
  }
  if (buffer.length === 0) {
    throw new PyramidError(ErrorCode.INPUT_EMPTY, 'Input buffer is empty');
  }

  // --- metadata probe (format, dimensions, orientation, frames) -------------
  const meta = await probeMetadata(buffer, options);

  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1) {
    throw new PyramidError(
      ErrorCode.INPUT_DIMENSION_MISMATCH,
      `Input reports invalid dimensions ${meta.width}x${meta.height}`,
    );
  }
  if (meta.width > options.maxDimension || meta.height > options.maxDimension) {
    throw new PyramidError(
      ErrorCode.INPUT_TOO_LARGE,
      `Input dimension ${Math.max(meta.width, meta.height)} exceeds maxDimension ${options.maxDimension}`,
      { details: { width: meta.width, height: meta.height, maxDimension: options.maxDimension } },
    );
  }

  // --- orientation consistency ----------------------------------------------
  // EXIF orientation is 1..8; anything else is treated as a corrupt header.
  const orientation = meta.orientation;
  if (orientation !== undefined && (
    !Number.isInteger(orientation) || orientation < 1 || orientation > 8
  )) {
    throw new PyramidError(
      ErrorCode.INPUT_DIMENSION_MISMATCH,
      `Input EXIF orientation ${orientation} is outside the valid range 1..8`,
    );
  }

  // --- colour space / channel layout ----------------------------------------
  if (!Number.isInteger(meta.channels) || meta.channels < 1 || meta.channels > 4) {
    throw new PyramidError(
      ErrorCode.INPUT_DIMENSION_MISMATCH,
      `Input reports unsupported channel count ${meta.channels}`,
    );
  }

  // --- frame / page consistency ----------------------------------------------
  const pages = meta.pages ?? 1;
  if (!Number.isInteger(pages) || pages < 1) {
    throw new PyramidError(
      ErrorCode.INPUT_DIMENSION_MISMATCH,
      `Input reports invalid page count ${pages}`,
    );
  }
  // For multi-page inputs libvips exposes total height and a per-page height.
  const pageHeight = meta.pageHeight ?? meta.height;
  if (pages > 1) {
    if (!Number.isInteger(pageHeight) || pageHeight < 1) {
      throw new PyramidError(
        ErrorCode.INPUT_DIMENSION_MISMATCH,
        `Multi-page input reports invalid pageHeight ${pageHeight}`,
      );
    }
    if (meta.height !== pageHeight * pages) {
      throw new PyramidError(
        ErrorCode.INPUT_DIMENSION_MISMATCH,
        `Multi-page height ${meta.height} is not pageHeight ${pageHeight} x pages ${pages}`,
      );
    }
    if (meta.delay !== undefined) {
      if (!Array.isArray(meta.delay) || meta.delay.length !== pages) {
        throw new PyramidError(
          ErrorCode.INPUT_DIMENSION_MISMATCH,
          `Frame delay array length ${meta.delay?.length} does not match page count ${pages}`,
        );
      }
      if (meta.delay.some(d => !Number.isInteger(d) || d < 0)) {
        throw new PyramidError(
          ErrorCode.INPUT_DIMENSION_MISMATCH,
          'Frame delay entries must be non-negative integers (milliseconds)',
        );
      }
    }
  }

  // --- pixel decode preflight ------------------------------------------------
  // metadata() only parses headers, so a truncated stream can pass it. Force a
  // real (sequential, low-memory) decode while validation still owns the
  // request — before any cache/pipeline write — so corrupt payloads are
  // rejected here and never leave partial artifacts downstream.
  try {
    await sharp(buffer, {
      pages: -1,
      animated: true,
      limitInputPixels: options.maxPixels,
      sequentialRead: true,
    }).stats();
  } catch (err) {
    throw mapSharpInputError(err);
  }

  return Object.freeze({
    buffer,
    format: meta.format ?? 'unknown',
    width: meta.width,
    height: meta.height,
    pageHeight,
    pages,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha === true,
    orientation,
    density: meta.density,
    delay: meta.delay ? [...meta.delay] : undefined,
    loop: meta.loop,
    space: meta.space,
  });
}
