import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  PyramidPipeline,
  computeCacheKey,
  normaliseOptions,
  ErrorCode,
} from '../lib/index.mjs';
import { samples, tempDir, decodeLevel } from './helpers.mjs';

test('EXIF orientation 6 auto mode swaps axes and normalises pixels', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['exif-orientation-6.jpg']);
    assert.equal(result.source.exifOrientation, 6);
    assert.equal(result.source.orientationMode, 'auto');
    // Source is 40x24 stored; orientation 6 (90 CW) must yield 24x40.
    assert.equal(result.frames[0].levels[0].width, 24);
    assert.equal(result.frames[0].levels[0].height, 40);

    // Pixels must match sharp's own auto-orient output, not merely have new dims.
    const expected = await sharp(s['exif-orientation-6.jpg']).rotate().raw().toBuffer();
    const { data: actual } = await decodeLevel(result.frames[0].levels[0].data);
    assert.ok(actual.equals(expected.subarray(0, actual.length)) || actual.length === expected.length);
    assert.deepEqual([...actual], [...expected]);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('orientation keep mode preserves stored dimensions and EXIF tag is recorded', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['exif-orientation-6.jpg'], { orientation: 'keep' });
    assert.equal(result.frames[0].levels[0].width, 40);
    assert.equal(result.frames[0].levels[0].height, 24);
    assert.equal(result.source.orientationMode, 'keep');
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('auto and keep outputs for an oriented image are distinct', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const auto = await pipeline.generate(s['exif-orientation-6.jpg'], { orientation: 'auto' });
    const keep = await pipeline.generate(s['exif-orientation-6.jpg'], { orientation: 'keep' });
    assert.notEqual(auto.key, keep.key);
    assert.notEqual(
      auto.frames[0].levels[0].sha256,
      keep.frames[0].levels[0].sha256,
    );
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('horizontal/vertical mirror change pixels and enter the cache key', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const plain = await pipeline.generate(s['static-33x17.png'], { mirror: 'none' });
    const horizontal = await pipeline.generate(s['static-33x17.png'], { mirror: 'horizontal' });
    const vertical = await pipeline.generate(s['static-33x17.png'], { mirror: 'vertical' });
    const both = await pipeline.generate(s['static-33x17.png'], { mirror: 'both' });

    const hashes = new Set([plain, horizontal, vertical, both].map(r => r.frames[0].levels[0].sha256));
    assert.equal(hashes.size, 4, 'all four mirror modes must yield distinct level-0 pixels');

    // Key-level proof that orientation/mirror parameters are part of the key.
    const baseKey = computeCacheKey(s['static-33x17.png'], normaliseOptions());
    for (const variant of [
      normaliseOptions({ mirror: 'horizontal' }),
      normaliseOptions({ mirror: 'vertical' }),
      normaliseOptions({ mirror: 'both' }),
    ]) {
      assert.notEqual(computeCacheKey(s['static-33x17.png'], variant), baseKey);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('mirror "both" equals horizontal then vertical on raw pixels', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['static-33x17.png'], { mirror: 'both' });
    const expected = await sharp(s['static-33x17.png']).flop().flip().raw().toBuffer();
    const { data } = await decodeLevel(result.frames[0].levels[0].data);
    assert.deepEqual([...data], [...expected]);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('validation rejects EXIF orientation values outside 1..8 with stable error', async () => {
  // The guard lives in validateInput; drive it with a stubbed metadata probe
  // so the boundary (values 0, 9, -1) is exercised deterministically without
  // depending on whether libvips itself tolerates unknown tags.
  const { setMetadataProbe, validateInput } = await import('../lib/validation.mjs');
  const s = await samples();
  const restore = setMetadataProbe(async () => ({
    width: 8,
    height: 8,
    channels: 4,
    hasAlpha: true,
    pages: 1,
    orientation: 0, // replaced per iteration below via closure
    format: 'png',
    delay: undefined,
    loop: undefined,
    space: 'srgb',
  }));
  try {
    for (const badOrientation of [0, 9, -1]) {
      setMetadataProbe(async () => ({
        width: 8,
        height: 8,
        channels: 4,
        hasAlpha: true,
        pages: 1,
        orientation: badOrientation,
        format: 'png',
        delay: undefined,
        loop: undefined,
        space: 'srgb',
      }));
      await assert.rejects(
        () => validateInput(s['static-1x1.png'], normaliseOptions()),
        err => err.code === ErrorCode.INPUT_DIMENSION_MISMATCH && /orientation/i.test(err.message),
      );
    }
  } finally {
    restore();
  }
});
