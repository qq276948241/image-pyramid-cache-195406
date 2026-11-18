import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  PyramidPipeline,
  ErrorCode,
  validateInput,
  normaliseOptions,
  setMetadataProbe,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

test('empty buffer is rejected with INPUT_EMPTY', async () => {
  const s = await samples();
  await assert.rejects(
    () => validateInput(s['corrupt-empty.bin'], normaliseOptions()),
    err => err.code === ErrorCode.INPUT_EMPTY,
  );
});

test('garbage bytes are rejected with INPUT_UNSUPPORTED', async () => {
  const s = await samples();
  await assert.rejects(
    () => validateInput(s['corrupt-garbage.bin'], normaliseOptions()),
    err => err.code === ErrorCode.INPUT_UNSUPPORTED,
  );
});

test('truncated and bad-body PNGs are rejected with INPUT_CORRUPT', async () => {
  const s = await samples();
  for (const name of ['corrupt-truncated.png', 'corrupt-bad-body.png']) {
    await assert.rejects(
      () => validateInput(s[name], normaliseOptions()),
      err => err.code === ErrorCode.INPUT_CORRUPT,
    );
  }
});

test('non-Buffer input is rejected with OPTION_INVALID before any decode', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    for (const bad of [undefined, null, 'not-a-buffer', { x: 1 }, 42]) {
      await assert.rejects(
        // @ts-expect-error deliberately wrong type
        () => pipeline.generate(bad),
        err => err.code === ErrorCode.INPUT_EMPTY || err.code === ErrorCode.OPTION_INVALID,
      );
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('a rejected submission leaves no cache entry and no temp artifacts', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const attempts = [
      () => pipeline.generate(s['corrupt-empty.bin']),
      () => pipeline.generate(s['corrupt-garbage.bin']),
      () => pipeline.generate(s['corrupt-truncated.png']),
      () => pipeline.generate(s['static-64x48.png'], { colourspace: 'invalid' }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt);
    }
    const entries = await readdir(path.join(dir, 'entries'), { recursive: true });
    assert.deepEqual(entries.filter(f => !String(f).endsWith('.gitkeep')), []);
    const tmp = await readdir(path.join(dir, 'tmp'));
    assert.deepEqual(tmp, []);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('error codes are stable strings and every rejection carries one', async () => {
  const s = await samples();
  const expected = [
    ['corrupt-empty.bin', ErrorCode.INPUT_EMPTY],
    ['corrupt-garbage.bin', ErrorCode.INPUT_UNSUPPORTED],
    ['corrupt-truncated.png', ErrorCode.INPUT_CORRUPT],
    ['corrupt-bad-body.png', ErrorCode.INPUT_CORRUPT],
  ];
  for (const [name, code] of expected) {
    try {
      await validateInput(s[name], normaliseOptions());
      assert.fail(`${name} should have been rejected`);
    } catch (err) {
      assert.equal(err.code, code, `${name} -> expected ${code}`);
      assert.equal(typeof err.message, 'string');
      assert.ok(err.message.length > 0);
    }
  }
});

test('frame metadata inconsistency: delay length mismatch is rejected', async () => {
  const restore = setMetadataProbe(async () => ({
    width: 8,
    height: 24,
    pageHeight: 8,
    channels: 4,
    hasAlpha: true,
    pages: 3,
    orientation: 1,
    format: 'webp',
    delay: [100, 200], // only 2 delays for 3 pages
    loop: 0,
    space: 'srgb',
  }));
  try {
    const s = await samples();
    await assert.rejects(
      () => validateInput(s['static-1x1.png'], normaliseOptions()),
      err => err.code === ErrorCode.INPUT_DIMENSION_MISMATCH && /delay/i.test(err.message),
    );
  } finally {
    restore();
  }
});

test('frame metadata inconsistency: height not divisible by pageHeight is rejected', async () => {
  const restore = setMetadataProbe(async () => ({
    width: 8,
    height: 25, // not 8 * 3
    pageHeight: 8,
    channels: 4,
    hasAlpha: true,
    pages: 3,
    orientation: 1,
    format: 'webp',
    delay: [10, 20, 30],
    loop: 0,
    space: 'srgb',
  }));
  try {
    const s = await samples();
    await assert.rejects(
      () => validateInput(s['static-1x1.png'], normaliseOptions()),
      err => err.code === ErrorCode.INPUT_DIMENSION_MISMATCH && /pageHeight/i.test(err.message),
    );
  } finally {
    restore();
  }
});

test('negative delay values are rejected', async () => {
  const restore = setMetadataProbe(async () => ({
    width: 8,
    height: 16,
    pageHeight: 8,
    channels: 4,
    hasAlpha: true,
    pages: 2,
    orientation: 1,
    format: 'webp',
    delay: [100, -5],
    loop: 0,
    space: 'srgb',
  }));
  try {
    const s = await samples();
    await assert.rejects(
      () => validateInput(s['static-1x1.png'], normaliseOptions()),
      err => err.code === ErrorCode.INPUT_DIMENSION_MISMATCH && /delay/i.test(err.message),
    );
  } finally {
    restore();
  }
});

test('oversize pixel estimate is rejected with INPUT_TOO_LARGE', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({
      cacheRoot: dir,
      defaults: { maxMemoryBytes: 64 }, // impossibly small
    });
    await assert.rejects(
      () => pipeline.generate(s['static-33x17.png']),
      err => err.code === ErrorCode.INPUT_TOO_LARGE && /peak memory/i.test(err.message),
    );
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('invalid kernel is rejected with OPTION_INVALID before decoding', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    await assert.rejects(
      () => pipeline.generate(s['static-33x17.png'], { kernel: 'bogus-kernel' }),
      err => err.code === ErrorCode.OPTION_INVALID && /kernel/.test(err.message),
    );
    await pipeline.close();
  } finally {
    await cleanup();
  }
});
