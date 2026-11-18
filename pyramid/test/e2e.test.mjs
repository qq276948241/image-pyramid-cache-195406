/*!
  Cross-module end-to-end regression.

  Unlike the module-scoped tests, this file drives one request through every
  layer in order — PyramidService HTTP -> PyramidPipeline -> validation ->
  processing -> DiskCache — and then verifies recovery after a mid-sequence
  restart. It is the regression guard that the public chain stays wired
  correctly when any single module changes.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PyramidPipeline,
  PyramidService,
  DiskCache,
  ErrorCode,
  RULE_VERSION,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

const CLOSE = { headers: { connection: 'close' } };

async function boot (cacheRoot, config = {}) {
  const pipeline = new PyramidPipeline({ cacheRoot });
  const service = new PyramidService(pipeline, { shutdownTimeoutMs: 3000, ...config });
  const port = await service.start();
  return {
    base: `http://127.0.0.1:${port}`,
    pipeline,
    service,
    stop: () => service.shutdown(),
  };
}

test('E2E: HTTP submission flows through every layer and lands in the disk cache', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  const env = await boot(dir);
  try {
    const post = await fetch(`${env.base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ image: s['static-64x48.png'].toString('base64') }),
    });
    assert.equal(post.status, 202);
    const { id } = await post.json();

    // Poll the same HTTP surface the client would use.
    let result;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const res = await fetch(`${env.base}/jobs/${id}`, CLOSE);
      const body = await res.json();
      if (body.status === 'succeeded') { result = body; break; }
      if (body.status === 'failed') throw new Error(`job failed: ${body.code}`);
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(result, 'job never reached succeeded');
    assert.equal(result.result.version, RULE_VERSION);
    assert.ok(result.result.frames[0].levels.length >= 2);

    // Disk-cache layer: the entry physically exists with version + options.
    const cache = new DiskCache(dir);
    await cache.ready;
    assert.equal(cache.manifest.size, 1);
    const key = result.result.key;
    const onDisk = JSON.parse(await readFile(
      path.join(dir, 'entries', key.slice(0, 2), `${key}.json`),
      'utf8',
    ));
    assert.equal(onDisk.version, RULE_VERSION);
    assert.equal(onDisk.options.colourspace, 'srgb');

    // Counters surfaced via the non-codec health path.
    const health = await (await fetch(`${env.base}/health`, CLOSE)).json();
    assert.equal(health.counters.accepted, 1);
    assert.equal(health.counters.succeeded, 1);
    assert.equal(health.counters.failed, 0);
  } finally {
    await env.stop();
    await cleanup();
  }
});

test('E2E: corrupt HTTP job is failed with a stable code and never reaches the cache', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  const env = await boot(dir);
  try {
    const post = await fetch(`${env.base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ image: s['corrupt-truncated.png'].toString('base64') }),
    });
    const { id } = await post.json();
    let body;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      body = await (await fetch(`${env.base}/jobs/${id}`, CLOSE)).json();
      if (body.status === 'failed' || body.status === 'succeeded') break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(body.status, 'failed');
    assert.equal(body.code, ErrorCode.INPUT_CORRUPT);

    const cache = new DiskCache(dir);
    await cache.ready;
    assert.equal(cache.manifest.size, 0);
    assert.equal(env.service.counters.failed, 1);
  } finally {
    await env.stop();
    await cleanup();
  }
});

test('E2E: mid-sequence restart rebuilds from cache without pixel changes', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    // First process lifetime: generate through the full chain.
    const first = await boot(dir);
    const post = await fetch(`${first.base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ image: s['animated-4f.webp'].toString('base64') }),
    });
    const { id } = await post.json();
    let firstBody;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const body = await (await fetch(`${first.base}/jobs/${id}`, CLOSE)).json();
      if (body.status === 'succeeded') { firstBody = body; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(firstBody);
    await first.stop();

    // Simulate process restart: brand-new pipeline/service over the same root.
    const second = await boot(dir);
    try {
      const restarted = await second.pipeline.generate(s['animated-4f.webp']);
      assert.equal(restarted.cacheHit, true, 'restart must serve from the persisted cache');
      assert.equal(restarted.key, firstBody.result.key);
      assert.deepEqual(
        restarted.frames.map(f => f.levels.map(l => l.sha256)),
        firstBody.result.frames.map(f => f.levels.map(l => l.sha256)),
      );
      // Frame timing survives the restart round trip.
      assert.deepEqual(restarted.frames.map(f => f.delayMs), [100, 150, 200, 250]);
    } finally {
      await second.stop();
    }
  } finally {
    await cleanup();
  }
});

test('E2E: graceful shutdown removes the service temp root and closes cleanly', async () => {
  const { dir, cleanup } = await tempDir();
  const env = await boot(dir);
  const tempRoot = env.service.tempRoot;
  assert.ok(existsSync(tempRoot));
  const outcome = await env.stop();
  assert.equal(outcome.timedOut, false);
  assert.equal(existsSync(tempRoot), false);
  await cleanup();
});
