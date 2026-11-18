import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PyramidPipeline,
  runPool,
  computeCacheKey,
  normaliseOptions,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

test('runPool: output positions are fixed regardless of completion order', async () => {
  // Workers resolve out of order (later indices finish first); results must
  // still land at their own index.
  const items = [10, 20, 30, 40, 50];
  const results = await runPool(
    items,
    async item => new Promise(resolve => setTimeout(() => resolve(item * 2), 60 - item)),
    3,
  );
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
});

test('runPool: a shuffled pick schedule produces identical output', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const worker = async item => item * item;
  const sequential = await runPool(items, worker, 1);
  const shuffled = await runPool(
    items,
    worker,
    4,
    indices => [...indices].sort(() => Math.random() - 0.5),
  );
  assert.deepEqual(shuffled, sequential);
});

test('repeated identical submissions return identical payloads and use the cache', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const first = await pipeline.generate(s['static-64x48.png']);
    const second = await pipeline.generate(s['static-64x48.png']);
    const third = await pipeline.generate(s['static-64x48.png']);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(third.cacheHit, true);
    assert.equal(second.key, first.key);
    // Full payload equality (hashes, dimensions, encoded bytes).
    assert.deepEqual(
      second.frames.map(f => f.levels.map(l => l.sha256)),
      first.frames.map(f => f.levels.map(l => l.sha256)),
    );
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('concurrent identical submissions share one computation (in-flight de-dup)', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir, defaults: { frameConcurrency: 1 } });
    const [a, b, c, d] = await Promise.all([
      pipeline.generate(s['animated-4f.webp']),
      pipeline.generate(s['animated-4f.webp']),
      pipeline.generate(s['animated-4f.webp']),
      pipeline.generate(s['animated-4f.webp']),
    ]);
    const keys = new Set([a, b, c, d].map(r => r.key));
    assert.equal(keys.size, 1);
    const hashes = [a, b, c, d].map(r => JSON.stringify(r.frames.map(f => f.levels.map(l => l.sha256))));
    assert.equal(new Set(hashes).size, 1, 'all concurrent callers get byte-identical results');
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('concurrent DISTINCT submissions all succeed and never share buffers', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir, defaults: { frameConcurrency: 4 } });
    const inputs = [
      s['static-33x17.png'],
      s['static-64x48.png'],
      s['transparent-16x16.png'],
      s['animated-4f.webp'],
      s['multipage-4p.tiff'],
    ];
    const results = await Promise.all(inputs.map(buf => pipeline.generate(buf)));
    assert.equal(results.length, 5);
    const keys = results.map(r => r.key);
    assert.equal(new Set(keys).size, 5, 'distinct inputs must produce distinct keys');
    // Re-run sequentially and confirm the concurrent outputs match exactly.
    for (let i = 0; i < inputs.length; i++) {
      const again = await pipeline.generate(inputs[i]);
      assert.equal(again.cacheHit, true);
      assert.deepEqual(
        again.frames.map(f => f.levels.map(l => l.sha256)),
        results[i].frames.map(f => f.levels.map(l => l.sha256)),
      );
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('frameConcurrency 1 vs 8 yields byte-identical pyramids for the same input', async () => {
  const s = await samples();
  const { dir: dir1, cleanup: c1 } = await tempDir();
  const { dir: dir2, cleanup: c2 } = await tempDir();
  try {
    const serial = new PyramidPipeline({ cacheRoot: dir1, defaults: { frameConcurrency: 1 } });
    const parallel = new PyramidPipeline({ cacheRoot: dir2, defaults: { frameConcurrency: 8 } });
    const [r1, r2] = await Promise.all([
      serial.generate(s['animated-4f.webp']),
      parallel.generate(s['animated-4f.webp'], {}, {
        schedule: indices => [...indices].sort(() => Math.random() - 0.5),
      }),
    ]);
    assert.equal(r1.key, r2.key);
    assert.deepEqual(
      r1.frames.map(f => f.levels.map(l => l.sha256)),
      r2.frames.map(f => f.levels.map(l => l.sha256)),
    );
    await Promise.all([serial.close(), parallel.close()]);
  } finally {
    await c1(); await c2();
  }
});

test('cache key includes rule version and colour/orientation parameters', async () => {
  const s = await samples();
  const base = normaliseOptions();
  const baselineKey = computeCacheKey(s['static-64x48.png'], base);
  assert.equal(baselineKey.length, 64); // sha256 hex
  for (const variant of [
    normaliseOptions({ colourspace: 'grey' }),
    normaliseOptions({ colourspace: 'rgb16' }),
    normaliseOptions({ orientation: 'keep' }),
    normaliseOptions({ mirror: 'horizontal' }),
    normaliseOptions({ minLevelDimension: 8 }),
  ]) {
    assert.notEqual(
      computeCacheKey(s['static-64x48.png'], variant),
      baselineKey,
      `variant ${JSON.stringify(variant)} must change the key`,
    );
  }
  // Two different image contents with identical options get different keys.
  assert.notEqual(
    computeCacheKey(s['static-64x48.png'], base),
    computeCacheKey(s['static-33x17.png'], base),
  );
});
