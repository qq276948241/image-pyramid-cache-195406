import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  PyramidPipeline,
  PyramidService,
  ErrorCode,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

// Every request sends `connection: close` so the response tears its socket
// down immediately. Without this, fetch's global keep-alive agent holds idle
// sockets open and server.close() blocks forever, pinning the test process.
const JSON_HEADERS = { 'content-type': 'application/json', connection: 'close' };

async function startService ({ cacheRoot, ...config } = {}) {
  const { dir, cleanup } = await tempDir();
  const pipeline = new PyramidPipeline({ cacheRoot: cacheRoot ?? dir });
  const service = new PyramidService(pipeline, { maxQueueDepth: 3, shutdownTimeoutMs: 2000, ...config });
  const port = await service.start();
  return {
    base: `http://127.0.0.1:${port}`,
    service,
    pipeline,
    cleanup: async () => {
      if (!service.shuttingDown) await service.shutdown().catch(() => {});
      await cleanup();
    },
  };
}

async function postJob (target, image, options = {}) {
  const base = typeof target === 'string' ? target : target.base;
  return fetch(`${base}/jobs`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ image: image.toString('base64'), options }),
  });
}

async function waitForJob (target, id, timeoutMs = 5000) {
  const base = typeof target === 'string' ? target : target.base;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { connection: 'close' } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return { res, body };
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
}

test('health endpoint responds and never runs image codecs', async () => {
  const env = await startService();
  try {
    const res = await fetch(`${env.base}/health`, { headers: { connection: 'close' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.eventLoopLagMs, 'number');
    assert.deepEqual(body.counters, { accepted: 0, succeeded: 0, failed: 0, rejected: 0 });
  } finally {
    await env.cleanup();
  }
});

test('health stays fast while synchronous-style encode jobs are in flight', async () => {
  const s = await samples();
  const env = await startService();
  try {
    // Submit several jobs, then immediately hammer /health during processing.
    const posts = await Promise.all([
      postJob(env, s['animated-4f.webp']),
      postJob(env, s['static-64x48.png']),
      postJob(env, s['multipage-4p.tiff']),
    ]);
    const ids = await Promise.all(posts.map(async r => (await r.json()).id));

    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const res = await fetch(`${env.base}/health`, { headers: { connection: 'close' } });
      latencies.push(performance.now() - start);
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, 5));
    }
    // Health is pure state + JSON; it must stay well below any codec-bound path.
    assert.ok(Math.max(...latencies) < 500, `health latency max ${Math.max(...latencies)}ms too high`);

    for (const id of ids) {
      const { body } = await waitForJob(env, id);
      assert.equal(body.status, 'succeeded');
    }
  } finally {
    await env.cleanup();
  }
});

test('queue overflow returns SERVICE_BUSY with 503', async () => {
  const s = await samples();
  const env = await startService({ maxQueueDepth: 1 });
  try {
    // Block the single worker slot with a slow injected builder.
    const processing = await import('../lib/processing.mjs');
    let release;
    const gate = new Promise(r => { release = r; });
    const real = processing.frameBuilder;
    const restore = processing.setFrameBuilder(async (frame, info, options) => {
      await gate;
      return real(frame, info, options);
    });
    try {
      const first = await postJob(env, s['animated-4f.webp']);
      assert.equal(first.status, 202);
      // Wait until the job is running so the slot is occupied.
      await new Promise(r => setTimeout(r, 100));
      const second = await postJob(env, s['static-64x48.png']);
      assert.equal(second.status, 503);
      const body = await second.json();
      assert.equal(body.code, ErrorCode.SERVICE_BUSY);
      release();
    } finally {
      restore();
    }
  } finally {
    await env.cleanup();
  }
});

test('corrupt input job fails with stable code and is queryable by id', async () => {
  const s = await samples();
  const env = await startService();
  try {
    const res = await postJob(env, s['corrupt-truncated.png']);
    assert.equal(res.status, 202);
    const { id } = await res.json();
    const { body } = await waitForJob(env, id);
    assert.equal(body.status, 'failed');
    assert.equal(body.code, ErrorCode.INPUT_CORRUPT);
    assert.equal(env.service.counters.failed, 1);
  } finally {
    await env.cleanup();
  }
});

test('unknown job id returns JOB_NOT_FOUND', async () => {
  const env = await startService();
  try {
    const res = await fetch(`${env.base}/jobs/does-not-exist`, { headers: { connection: 'close' } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, ErrorCode.JOB_NOT_FOUND);
  } finally {
    await env.cleanup();
  }
});

test('graceful shutdown waits for in-flight jobs within the deadline and cleans temp root', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  const pipeline = new PyramidPipeline({ cacheRoot: dir });
  const service = new PyramidService(pipeline, { shutdownTimeoutMs: 3000 });
  const port = await service.start();
  const base = `http://127.0.0.1:${port}`;
  const tempRoot = service.tempRoot;

  const res = await postJob(base, s['animated-4f.webp']);
  const { id } = await res.json();
  const outcome = await service.shutdown();
  assert.equal(outcome.timedOut, false);
  assert.ok(existsSync(tempRoot) === false, 'temp root must be removed');

  const { body } = await waitForJob(base, id).catch(() => ({ body: { status: 'gone' } }));
  // Server is closed: either the job completed before shutdown or connection failed.
  assert.ok(['succeeded', 'gone'].includes(body.status));
  await cleanup();
});

test('shutdown deadline forces failure on jobs that overrun', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  const pipeline = new PyramidPipeline({ cacheRoot: dir });
  const service = new PyramidService(pipeline, { shutdownTimeoutMs: 150 });
  const port = await service.start();
  const base = `http://127.0.0.1:${port}`;

  const processing = await import('../lib/processing.mjs');
  const real = processing.frameBuilder;
  const restore = processing.setFrameBuilder(async (frame, info, options) => {
    // unref so the overrun timer cannot keep the test process alive after
    // the shutdown deadline has already force-failed this job.
    await new Promise(r => { const t = setTimeout(r, 2000); t.unref(); });
    return real(frame, info, options);
  });
  try {
    const res = await postJob(base, s['static-64x48.png']);
    const { id } = await res.json();
    await new Promise(r => setTimeout(r, 100)); // let it enter running state
    const outcome = await service.shutdown();
    assert.equal(outcome.timedOut, true);
    const job = service.jobs.get(id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, ErrorCode.SERVICE_SHUTTING_DOWN);
    assert.ok(existsSync(service.tempRoot) === false);
  } finally {
    restore();
    await cleanup();
  }
});

test('submissions after shutdown starts are rejected with 503', async () => {
  const s = await samples();
  const env = await startService();
  try {
    // Gate flips while the socket still listens: the request must reach the
    // handler and get a 503, not a connection-level ECONNREFUSED.
    await env.service.beginShutdown();
    const res = await postJob(env, s['static-1x1.png']);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, ErrorCode.SERVICE_SHUTTING_DOWN);
    await env.service.shutdown();
  } finally {
    await env.cleanup();
  }
});
