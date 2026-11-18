import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PyramidPipeline,
  levelDimensions,
} from '../lib/index.mjs';
import { samples, tempDir, rawPixelHash } from './helpers.mjs';

/**
 * Compute a stable summary of a pyramid: pure pixel hashes and geometry,
 * excluding timestamps, cache-hit flags and absolute paths.
 */
async function pixelSummary (result) {
  const frames = [];
  for (const frame of result.frames) {
    const levels = [];
    for (const level of frame.levels) {
      levels.push({
        level: level.level,
        width: level.width,
        height: level.height,
        pixels: await rawPixelHash(level.data),
      });
    }
    frames.push({ frame: frame.frame, delayMs: frame.delayMs, levels });
  }
  return {
    key: result.key,
    loop: result.loop,
    source: { pages: result.source.pages, hasAlpha: result.source.hasAlpha },
    frames,
  };
}

test('same input processed twice in separate processes-style runs yields identical summary', async () => {
  const s = await samples();
  const { dir: dir1, cleanup: c1 } = await tempDir();
  const { dir: dir2, cleanup: c2 } = await tempDir();
  try {
    const p1 = new PyramidPipeline({ cacheRoot: dir1 });
    const p2 = new PyramidPipeline({ cacheRoot: dir2 });
    const inputs = [
      s['static-33x17.png'],
      s['transparent-16x16.png'],
      s['exif-orientation-6.jpg'],
      s['animated-4f.webp'],
      s['multipage-4p.tiff'],
    ];
    const [runA, runB] = await Promise.all([
      Promise.all(inputs.map(buf => p1.generate(buf))),
      Promise.all(inputs.map(buf => p2.generate(buf))),
    ]);
    for (let i = 0; i < inputs.length; i++) {
      const [a, b] = await Promise.all([pixelSummary(runA[i]), pixelSummary(runB[i])]);
      assert.deepEqual(b, a, `input index ${i} summaries must match across independent runs`);
    }
    await Promise.all([p1.close(), p2.close()]);
  } finally {
    await c1(); await c2();
  }
});

test('irrelevant configuration changes do not alter pixel results', async () => {
  // Cache root, TTL and maxEntries are operational config, not pixel rules:
  // the level pixels (and cache key) must be identical.
  const s = await samples();
  const { dir: dir1, cleanup: c1 } = await tempDir();
  const { dir: dir2, cleanup: c2 } = await tempDir();
  try {
    const p1 = new PyramidPipeline({ cacheRoot: dir1 });
    const p2 = new PyramidPipeline({ cacheRoot: dir2, defaults: { maxMemoryBytes: 256 * 1024 * 1024 } });
    const [r1, r2] = await Promise.all([
      p1.generate(s['animated-4f.webp']),
      p2.generate(s['animated-4f.webp']),
    ]);
    assert.equal(r1.key, r2.key, 'operational config must not enter the cache key');
    const [a, b] = await Promise.all([pixelSummary(r1), pixelSummary(r2)]);
    assert.deepEqual(b, a);
    await Promise.all([p1.close(), p2.close()]);
  } finally {
    await c1(); await c2();
  }
});

test('relevant option changes DO change pixels (control for the invariant above)', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const colour = await pipeline.generate(s['static-64x48.png']);
    const grey = await pipeline.generate(s['static-64x48.png'], { colourspace: 'grey' });
    assert.notEqual(colour.key, grey.key);
    const [a, b] = await Promise.all([
      rawPixelHash(colour.frames[0].levels[0].data),
      rawPixelHash(grey.frames[0].levels[0].data),
    ]);
    assert.notEqual(a, b);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('geometry summary is stable across every boundary sample', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    for (const [name, w, h] of [
      ['static-1x1.png', 1, 1],
      ['static-3x7.png', 3, 7],
      ['static-7x3.png', 7, 3],
      ['static-33x17.png', 33, 17],
      ['static-64x48.png', 64, 48],
    ]) {
      const result = await pipeline.generate(s[name]);
      const expected = levelDimensions(w, h).map(l => [l.width, l.height]);
      const actual = result.frames[0].levels.map(l => [l.width, l.height]);
      assert.deepEqual(actual, expected, name);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});
