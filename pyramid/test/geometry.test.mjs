import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelDimensions, normaliseOptions, ErrorCode } from '../lib/index.mjs';
import { PyramidPipeline } from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

test('levelDimensions: 1x1 stays a single level and never reaches zero', () => {
  assert.deepEqual(levelDimensions(1, 1), [{ level: 0, width: 1, height: 1 }]);
});

test('levelDimensions: odd dimensions use ceil(N/2) rounding', () => {
  assert.deepEqual(levelDimensions(3, 7), [
    { level: 0, width: 3, height: 7 },
    { level: 1, width: 2, height: 4 },
    { level: 2, width: 1, height: 2 },
    { level: 3, width: 1, height: 1 },
  ]);
});

test('levelDimensions: non-square images halve both axes and clamp at 1', () => {
  const levels = levelDimensions(7, 3);
  assert.deepEqual(levels.map(l => [l.width, l.height]), [[7, 3], [4, 2], [2, 1], [1, 1]]);
});

test('levelDimensions: maxLevels truncates the chain', () => {
  assert.equal(levelDimensions(33, 17, 2).length, 2);
  assert.equal(levelDimensions(33, 17, 1)[0].level, 0);
});

test('levelDimensions: rejects non-positive or non-integer inputs', () => {
  assert.throws(() => levelDimensions(0, 4), TypeError);
  assert.throws(() => levelDimensions(4, -1), TypeError);
  assert.throws(() => levelDimensions(2.5, 4), TypeError);
});

test('normaliseOptions: rejects unknown keys and bad whitelist values', () => {
  assert.throws(() => normaliseOptions({ colourspace: 'lab' }), /colourspace/);
  assert.throws(() => normaliseOptions({ orientation: 'sideways' }), /orientation/);
  assert.throws(() => normaliseOptions({ mirror: 'diagonal' }), /mirror/);
  assert.throws(() => normaliseOptions({ kernel: 'bogus-kernel' }), /kernel/);
  assert.throws(() => normaliseOptions({ maxPixels: 0 }), /maxPixels/);
  assert.throws(() => normaliseOptions({ unexpected: 1 }), /Unknown option/);
});

test('normaliseOptions: accepts every whitelisted kernel', () => {
  for (const kernel of ['nearest', 'cubic', 'mitchell', 'lanczos2', 'lanczos3']) {
    assert.equal(normaliseOptions({ kernel }).kernel, kernel);
  }
});

test('levelDimensions: minLevelDimension halts the chain before sub-threshold sizes', () => {
  // 33x17 chain is 33x17,17x9,9x5,5x3,3x2,2x1,1x1. A floor of 8 stops at 9x5.
  const dims = levelDimensions(33, 17, 16, 8);
  assert.deepEqual(dims.map(l => [l.width, l.height]), [[33, 17], [17, 9], [9, 5]]);
  for (const l of dims) assert.ok(Math.max(l.width, l.height) >= 8);
  // minLevelDimension = 1 preserves the full chain (backward compatible).
  assert.equal(levelDimensions(33, 17, 16, 1).length, 7);
});

test('pipeline: minLevelDimension option shortens the produced pyramid', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const full = await pipeline.generate(s['static-33x17.png']);
    const capped = await pipeline.generate(s['static-33x17.png'], { minLevelDimension: 8 });
    assert.ok(capped.frames[0].levels.length < full.frames[0].levels.length);
    assert.ok(Math.max(
      capped.frames[0].levels.at(-1).width,
      capped.frames[0].levels.at(-1).height,
    ) >= 8);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('pipeline: boundary sizes 1x1 and odd dimensions produce valid pyramids', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    for (const [name, expectedL0] of [
      ['static-1x1.png', [1, 1]],
      ['static-3x7.png', [3, 7]],
      ['static-7x3.png', [7, 3]],
      ['static-33x17.png', [33, 17]],
    ]) {
      const result = await pipeline.generate(s[name]);
      const l0 = result.frames[0].levels[0];
      assert.equal(l0.width, expectedL0[0], `${name} level-0 width`);
      assert.equal(l0.height, expectedL0[1], `${name} level-0 height`);
      // Every level is >= 1x1 and matches pure geometry function.
      const geometry = levelDimensions(expectedL0[0], expectedL0[1]);
      assert.deepEqual(
        result.frames[0].levels.map(l => [l.width, l.height]),
        geometry.map(l => [l.width, l.height]),
        `${name} level geometry`,
      );
      assert.ok(result.frames[0].levels.at(-1).width >= 1);
      assert.ok(result.frames[0].levels.at(-1).height >= 1);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('pipeline: over-limit dimensions are rejected with INPUT_TOO_LARGE', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir, defaults: { maxDimension: 10 } });
    await assert.rejects(
      () => pipeline.generate(s['static-33x17.png']),
      err => err.code === ErrorCode.INPUT_TOO_LARGE,
    );
    await pipeline.close();
  } finally {
    await cleanup();
  }
});
