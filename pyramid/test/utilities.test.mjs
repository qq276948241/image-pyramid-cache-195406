import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  joinLevelFrames,
  hashFile,
  estimatePeakMemory,
  normaliseOptions,
  PyramidError,
  ErrorCode,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

test('joinLevelFrames: concatenates same-sized frame PNGs into one vertical strip', async () => {
  const s = await samples();
  // Three single-frame PNGs of identical dimensions.
  const frame = s['static-3x7.png'];
  const { info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
  const pngs = [frame, frame, frame];

  const strip = await joinLevelFrames(pngs, info.width, info.height, info.channels, normaliseOptions());
  const decoded = await sharp(strip).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, info.width);
  assert.equal(decoded.info.height, info.height * 3, 'three frames stacked vertically');
  assert.equal(decoded.info.channels, info.channels);
});

test('joinLevelFrames: rejects frames with mismatched dimensions', async () => {
  const s = await samples();
  const a = s['static-3x7.png'];
  const b = s['static-7x3.png'];
  const infoA = await sharp(a).metadata();
  await assert.rejects(
    () => joinLevelFrames([a, b], infoA.width, infoA.height, infoA.channels, normaliseOptions()),
    err => err instanceof PyramidError && err.code === ErrorCode.FRAME_FAILED && /mismatch/.test(err.message),
  );
});

test('hashFile: matches an in-memory sha256 of the same bytes', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const payload = Buffer.from('pyramid-cache-hash-contract');
    const filePath = path.join(dir, 'sample.bin');
    await writeFile(filePath, payload);
    const onDisk = await hashFile(filePath);
    const expected = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex');
    assert.equal(onDisk, expected);
    assert.match(onDisk, /^[0-9a-f]{64}$/);
  } finally {
    await cleanup();
  }
});

test('estimatePeakMemory: grows with page count and frame size, stays a positive integer', async () => {
  const descriptor = {
    width: 100,
    pageHeight: 50,
    pages: 4,
    channels: 4,
    hasAlpha: true,
  };
  const estimate = estimatePeakMemory(descriptor, 4);
  assert.ok(Number.isInteger(estimate));
  assert.ok(estimate > 100 * 50 * 4 * 4);
  const single = estimatePeakMemory({ ...descriptor, pages: 1 }, 4);
  assert.ok(estimate > single, 'more frames must raise the estimate');
});
