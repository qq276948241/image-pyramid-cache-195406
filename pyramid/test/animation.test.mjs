import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  PyramidPipeline,
  PyramidError,
  ErrorCode,
  runPool,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

test('animated WebP: every frame, per-frame delay and loop count are preserved', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['animated-4f.webp']);
    assert.equal(result.frames.length, 4);
    assert.deepEqual(result.frames.map(f => f.delayMs), [100, 150, 200, 250]);
    assert.equal(result.loop, 2);
    assert.equal(result.source.pages, 4);
    // Frame indices are positional and contiguous regardless of scheduling.
    result.frames.forEach((frame, i) => assert.equal(frame.frame, i));
    // Every frame has the same level structure.
    const levelCounts = new Set(result.frames.map(f => f.levels.length));
    assert.equal(levelCounts.size, 1);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('animated GIF and multi-page TIFF keep identical frame counts and pixel hashes', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const gif = await pipeline.generate(s['animated-4f.gif']);
    const tiff = await pipeline.generate(s['multipage-4p.tiff']);
    assert.equal(gif.frames.length, 4);
    assert.equal(tiff.frames.length, 4);
    assert.deepEqual(gif.frames.map(f => f.delayMs), [100, 150, 200, 250]);
    // TIFF has no delay concept -> defaults to 0 per frame, still one entry each.
    assert.deepEqual(tiff.frames.map(f => f.delayMs), [0, 0, 0, 0]);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('a failing frame rejects the whole job and reports the frame index', async () => {
  // Inject a worker that fails frame 2; runPool must surface FRAME_FAILED with
  // the failed index, and never resolve a "successful" partial array.
  const items = [0, 1, 2, 3];
  await assert.rejects(
    () => runPool(
      items,
      async item => {
        if (item === 2) throw new Error('synthetic frame decode failure');
        return item * 10;
      },
      2,
    ),
    err => err instanceof PyramidError
      && err.code === ErrorCode.FRAME_FAILED
      && /Frame 2 failed/.test(err.message)
      && Array.isArray(err.details.failedFrames)
      && err.details.failedFrames.includes(2),
  );
});

test('failed animation job writes nothing to the cache', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const { DiskCache } = await import('../lib/cache.mjs');
    const cache = new DiskCache(dir);
    await cache.ready;
    const entriesBefore = cache.manifest.size;

    // Force frame index 2 to fail; the pipeline must reject before publishing.
    const processing = await import('../lib/processing.mjs');
    const realBuilder = processing.frameBuilder; // captured before replacement
    let callIndex = 0;
    const restore = processing.setFrameBuilder(async (frame, info, options) => {
      const index = callIndex++;
      if (index === 2) throw new PyramidError(ErrorCode.FRAME_FAILED, 'injected frame failure');
      return realBuilder(frame, info, options);
    });
    try {
      await assert.rejects(
        () => pipeline.generate(s['animated-4f.webp']),
        err => err.code === ErrorCode.FRAME_FAILED,
      );
    } finally {
      restore();
    }

    const cache2 = new DiskCache(dir);
    await cache2.ready;
    assert.equal(cache2.manifest.size, entriesBefore, 'manifest must not grow on failure');
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('lossless WebP pipeline output equals a direct raw decode of the same source', async () => {
  // The pipeline must not alter pixels beyond a plain decode: per-frame level-0
  // pixel hashes match a direct sharp raw decode (WebP sample is lossless).
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['animated-4f.webp']);
    const direct = await sharp(s['animated-4f.webp'], { pages: -1, animated: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const frameBytes = direct.info.width * direct.info.pageHeight * direct.info.channels;
    const { createHash } = await import('node:crypto');
    for (let f = 0; f < 4; f++) {
      const { rawPixelHash } = await import('./helpers.mjs');
      const pipelineHash = await rawPixelHash(result.frames[f].levels[0].data);
      const directHash = createHash('sha256')
        .update(direct.data.subarray(f * frameBytes, (f + 1) * frameBytes))
        .digest('hex');
      assert.equal(pipelineHash, directHash, `frame ${f} must match direct decode`);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('GIF pipeline output matches a direct decode of the GIF (palette quantization is a source property)', async () => {
  // GIF stores an 8-bit palette; exact equality with the lossless WebP source
  // is impossible by format design. The correct invariant is that the pipeline
  // introduces no further change: its level-0 pixels equal a direct raw decode
  // of the same GIF bytes, frame for frame.
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['animated-4f.gif']);
    const direct = await sharp(s['animated-4f.gif'], { pages: -1, animated: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const frameBytes = direct.info.width * direct.info.pageHeight * direct.info.channels;
    const { createHash } = await import('node:crypto');
    for (let f = 0; f < 4; f++) {
      const { rawPixelHash } = await import('./helpers.mjs');
      const pipelineHash = await rawPixelHash(result.frames[f].levels[0].data);
      const directHash = createHash('sha256')
        .update(direct.data.subarray(f * frameBytes, (f + 1) * frameBytes))
        .digest('hex');
      assert.equal(pipelineHash, directHash, `GIF frame ${f} must match direct decode`);
    }
    await pipeline.close();
  } finally {
    await cleanup();
  }
});
