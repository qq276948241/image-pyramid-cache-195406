/*!
  Shared test helpers: isolated temp directories and freshly generated samples.
  Every test works on runtime-generated pixels (see lib/samples.mjs), never on
  pre-recorded golden logs.
*/

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSampleSet } from '../lib/samples.mjs';

/** @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>} */
export async function tempDir (prefix = 'pyramid-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

let cached;
/** @returns {Promise<Record<string, Buffer>>} */
export function samples () {
  cached ??= createSampleSet();
  return cached;
}

/**
 * Decode a level's base64 PNG payload back to raw pixels for assertions.
 * @param {string} base64
 * @returns {Promise<{ data: Buffer, info: object }>}
 */
export async function decodeLevel (base64) {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(base64, 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/**
 * Pixel-level SHA-256 of a level (hashes raw pixels, not container bytes).
 * @param {string} base64
 * @returns {Promise<string>}
 */
export async function rawPixelHash (base64) {
  const { createHash } = await import('node:crypto');
  const { data } = await decodeLevel(base64);
  return createHash('sha256').update(data).digest('hex');
}
