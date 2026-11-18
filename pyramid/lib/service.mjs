/*!
  Minimal dependency-free HTTP service around PyramidPipeline.

  Design points:
  - GET /health never touches image codecs: it reports event-loop lag and job
    counters from state maintained synchronously, so a slow synchronous
    encode in the worker pool cannot block a health response (regression test
    pins a latency upper bound while jobs are running).
  - POST /jobs enqueues work; a bounded queue rejects overflow with
    SERVICE_BUSY instead of exhausting memory.
  - Graceful shutdown on SIGTERM/SIGINT: stop accepting, wait up to
    shutdownTimeoutMs for in-flight jobs, then reject them, remove the temp
    upload directory, and close the server and cache.
*/

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode, PyramidError, toPyramidError } from './errors.mjs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export class PyramidService {
  /**
   * @param {import('./pipeline.mjs').PyramidPipeline} pipeline
   * @param {{ maxQueueDepth?: number, shutdownTimeoutMs?: number, port?: number }} [config]
   */
  constructor (pipeline, { maxQueueDepth = 8, shutdownTimeoutMs = 5000, port = 0 } = {}) {
    this.pipeline = pipeline;
    this.maxQueueDepth = maxQueueDepth;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.port = port;
    /** @type {Map<string, {status: 'queued'|'running'|'succeeded'|'failed', result?: object, error?: PyramidError, queuedAt: number}>} */
    this.jobs = new Map();
    this.counters = { accepted: 0, succeeded: 0, failed: 0, rejected: 0 };
    this.queueDepth = 0;
    this.shuttingDown = false;
    /** Job ids force-failed by a shutdown deadline; their late completions must not overwrite status. */
    this.cancelledJobs = new Set();
    this.tempRoot = null;
    this.server = null;
    this._healthTimer = null;
    this.eventLoopLagMs = 0;
    this._onSignal = () => { this.shutdown().catch(() => {}); };
  }

  async start () {
    this.tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pyramid-svc-'));
    this.server = createServer((req, res) => this.#handle(req, res));
    this._healthTimer = setInterval(() => {
      const start = performance.now();
      setImmediate(() => { this.eventLoopLagMs = performance.now() - start; });
    }, 250);
    this._healthTimer.unref();

    await new Promise(resolve => this.server.listen(this.port, resolve));
    this.address = this.server.address();
    this.port = typeof this.address === 'object' && this.address ? this.address.port : this.port;
    process.on('SIGTERM', this._onSignal);
    process.on('SIGINT', this._onSignal);
    return this.port;
  }

  async #handle (req, res) {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        this.#json(res, 200, {
          status: this.shuttingDown ? 'shutting_down' : 'ok',
          eventLoopLagMs: Math.round(this.eventLoopLagMs * 100) / 100,
          queueDepth: this.queueDepth,
          counters: { ...this.counters },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/jobs') {
        await this.#submitJob(req, res);
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
        const id = req.url.slice('/jobs/'.length);
        const job = this.jobs.get(id);
        if (!job) {
          this.#json(res, 404, { code: ErrorCode.JOB_NOT_FOUND, message: `No job with id ${id}` });
          return;
        }
        if (job.status === 'succeeded') this.#json(res, 200, { id, ...job, result: job.result });
        else if (job.status === 'failed') {
          this.#json(res, 422, { id, status: job.status, code: job.error?.code, message: job.error?.message });
        } else this.#json(res, 202, { id, status: job.status });
        return;
      }
      this.#json(res, 404, { code: ErrorCode.JOB_NOT_FOUND, message: 'Unknown route' });
    } catch (err) {
      const e = toPyramidError(err);
      this.#json(res, 500, { code: e.code, message: e.message });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #submitJob (req, res) {
    if (this.shuttingDown) {
      this.counters.rejected++;
      this.#json(res, 503, { code: ErrorCode.SERVICE_SHUTTING_DOWN, message: 'Service is shutting down' });
      return;
    }
    if (this.queueDepth >= this.maxQueueDepth) {
      this.counters.rejected++;
      this.#json(res, 503, {
        code: ErrorCode.SERVICE_BUSY,
        message: `Queue depth ${this.queueDepth} exceeds limit ${this.maxQueueDepth}`,
      });
      return;
    }

    const { body, tooLarge } = await readLimited(req, MAX_BODY_BYTES);
    if (tooLarge) {
      this.counters.rejected++;
      this.#json(res, 413, { code: ErrorCode.INPUT_TOO_LARGE, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      this.counters.rejected++;
      this.#json(res, 400, { code: ErrorCode.OPTION_INVALID, message: 'Request body must be JSON' });
      return;
    }
    if (!payload.image || typeof payload.image !== 'string') {
      this.counters.rejected++;
      this.#json(res, 400, { code: ErrorCode.OPTION_INVALID, message: "Body requires base64 'image' field" });
      return;
    }

    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(payload.image, 'base64');
    } catch {
      this.counters.rejected++;
      this.#json(res, 400, { code: ErrorCode.OPTION_INVALID, message: 'image field is not valid base64' });
      return;
    }

    this.jobs.set(id, { status: 'queued', queuedAt: Date.now() });
    this.queueDepth++;
    this.counters.accepted++;
    this.#json(res, 202, { id, status: 'queued' });

    // Detached promise: the response is already sent; outcome lands in the map.
    this.#runJob(id, imageBuffer, payload.options ?? {});
  }

  async #runJob (id, imageBuffer, options) {
    const record = this.jobs.get(id);
    if (this.shuttingDown) {
      // Submission raced with shutdown and was marked queued just before the gate closed.
      record.status = 'failed';
      record.error = new PyramidError(ErrorCode.SERVICE_SHUTTING_DOWN, 'Job rejected by shutdown');
      this.queueDepth = Math.max(0, this.queueDepth - 1);
      this.counters.failed++;
      return;
    }
    record.status = 'running';
    try {
      const result = await this.pipeline.generate(imageBuffer, options);
      if (this.cancelledJobs.has(id)) return; // shutdown already reported this job
      record.status = 'succeeded';
      record.result = result;
      this.counters.succeeded++;
    } catch (err) {
      if (this.cancelledJobs.has(id)) return;
      record.status = 'failed';
      record.error = toPyramidError(err);
      this.counters.failed++;
    } finally {
      this.queueDepth = Math.max(0, this.queueDepth - 1);
    }
  }

  /**
   * Phase 1 of shutdown: flip the acceptance gate while keeping the server
   * listening. New submissions now receive an explicit 503; in-flight jobs
   * continue. Pair with closeAfterGrace() to release network/OS resources.
   * @returns {Promise<void>}
   */
  async beginShutdown () {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
  }

  /**
   * Graceful shutdown with a bounded wait: beginShutdown() semantics plus the
   * deadline wait, explicit job failure, server close and temp cleanup.
   * Safe to call after beginShutdown(); then it performs the actual teardown.
   * @returns {Promise<{ timedOut: boolean, awaited: number }>}
   */
  async shutdown () {
    if (!this.shuttingDown) this.shuttingDown = true;
    // beginShutdown() may have flipped the gate without scheduling teardown.
    if (!this._shutdownPromise) {
      this._shutdownPromise = this.#doShutdown();
    }
    return this._shutdownPromise;
  }

  async #doShutdown () {
    // Phase 1: flip the acceptance gate. The server keeps listening so that
    // requests arriving in this window get an explicit 503 instead of a
    // connection refusal; /health keeps responding with 'shutting_down'.
    const deadline = Date.now() + this.shutdownTimeoutMs;
    const awaited = await waitFor(
      async () => {
        while (this.queueDepth > 0 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 25));
        }
      },
      this.shutdownTimeoutMs,
    );
    const timedOut = this.queueDepth > 0;
    // Anything still queued/running after the deadline is explicitly failed.
    for (const [id, job] of this.jobs) {
      if (job.status === 'queued' || job.status === 'running') {
        this.cancelledJobs.add(id);
        job.status = 'failed';
        job.error = new PyramidError(
          ErrorCode.SERVICE_SHUTTING_DOWN,
          'Job terminated by graceful-shutdown deadline',
        );
        this.counters.failed++;
      }
    }
    // Phase 2: stop accepting connections only after the wait window closes.
    if (this._healthTimer) clearInterval(this._healthTimer);
    process.removeListener('SIGTERM', this._onSignal);
    process.removeListener('SIGINT', this._onSignal);
    await new Promise(resolve => this.server?.close(resolve));
    await this.pipeline.close().catch(() => {});
    if (this.tempRoot) await rm(this.tempRoot, { recursive: true, force: true });
    return { timedOut, awaited };
  }

  #json (res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
}

/**
 * Read a request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ body: Buffer, tooLarge: boolean }>}
 */
async function readLimited (req, maxBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      req.destroy();
      break;
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), tooLarge };
}

/**
 * Resolve when `fn` settles or the timeout elapses, whichever comes first.
 * @param {() => Promise<void>} fn
 * @param {number} timeoutMs
 * @returns {Promise<number>} number of milliseconds actually waited
 */
async function waitFor (fn, timeoutMs) {
  const start = Date.now();
  await Promise.race([
    fn().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
  return Date.now() - start;
}
