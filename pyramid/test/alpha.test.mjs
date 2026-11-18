import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import { PyramidPipeline } from '../lib/index.mjs';
import { samples, tempDir, decodeLevel } from './helpers.mjs';

test('alpha channel is retained on every level, including fully transparent input', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['transparent-16x16.png']);
    assert.equal(result.source.hasAlpha, true);
    for (const level of result.frames[0].levels) {
      const { info } = await decodeLevel(level.data);
      assert.equal(info.channels, 4, `level ${level.level} must keep 4 channels`);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('fully transparent pixels do not bleed RGB after downsampling', async () => {
  // 8x2 image: top 4 columns transparent red (alpha 0), bottom row opaque blue.
  // With correct premultiplied resampling, shrinking must not paint the
  // transparent region's RGB into opaque neighbours.
  const width = 8;
  const height = 2;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const transparent = x < 4;
      raw[o] = transparent ? 255 : 0;
      raw[o + 1] = 0;
      raw[o + 2] = transparent ? 0 : 255;
      raw[o + 3] = transparent ? 0 : 255;
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();

  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(png);
    const half = result.frames[0].levels.find(l => l.width === 4 && l.height === 1);
    assert.ok(half, 'expected a 4x1 level');
    const { data, info } = await decodeLevel(half.data);
    assert.equal(info.channels, 4);
    // Premultiplied resampling semantics:
    //  - fully transparent region keeps alpha 0 and carries no red fringe;
    //  - fully opaque region keeps alpha 255 and stays blue-dominant
    //    (the transparent red's RGB never bleeds in);
    //  - intermediate pixels may exist only at the single alpha boundary.
    for (let x = 0; x < 4; x++) {
      const [r, g, b, a] = [data[x * 4], data[x * 4 + 1], data[x * 4 + 2], data[x * 4 + 3]];
      if (a === 0) {
        assert.deepEqual([r, g, b], [0, 0, 0], `transparent pixel ${x} must not carry RGB fringe`);
      } else if (a === 255) {
        assert.ok(b > r, `opaque pixel ${x}: blue ${b} must dominate red ${r}`);
      } else {
        // Boundary transition pixel: red must never exceed blue.
        assert.ok(r <= b, `boundary pixel ${x}: red ${r} must not exceed blue ${b}`);
      }
    }
    // At least one fully transparent and one fully opaque pixel survive.
    const alphas = [0, 1, 2, 3].map(x => data[x * 4 + 3]);
    assert.ok(alphas.includes(0));
    assert.ok(alphas.includes(255));
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('semi-transparent pixel (alpha 128) survives level 0 unchanged', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['transparent-16x16.png']);
    const { data, info } = await decodeLevel(result.frames[0].levels[0].data);
    assert.equal(info.width, 16);
    // Column 8 is the 50% alpha band.
    const idx = (0 * 16 + 8) * 4 + 3;
    assert.equal(data[idx], 128);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('output without alpha input does not invent an alpha channel', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['grey-20x12.png']);
    const { info } = await decodeLevel(result.frames[0].levels[0].data);
    assert.ok(info.channels <= 3);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});
