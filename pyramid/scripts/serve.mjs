#!/usr/bin/env node
/*!
  Service launcher.

  Usage:
    node scripts/serve.mjs [--cache-root DIR] [--port N]
                           [--max-queue N] [--shutdown-timeout MS]

  The server starts on an ephemeral port when --port is omitted and prints the
  chosen base URL and health endpoint to stdout. SIGINT/SIGTERM trigger the
  bounded graceful shutdown implemented in lib/service.mjs.
*/

import path from 'node:path';
import { PyramidPipeline, PyramidService } from '../lib/index.mjs';

function parseArgs (argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) {
      throw new Error(`Malformed argument near '${key}'. Expected --flag value pairs.`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

async function main () {
  const args = parseArgs(process.argv);
  const cacheRoot = args['cache-root']
    ? path.resolve(args['cache-root'])
    : path.join(process.cwd(), '.pyramid-cache');
  const port = args.port ? Number.parseInt(args.port, 10) : 0;
  const maxQueueDepth = args['max-queue'] ? Number.parseInt(args['max-queue'], 10) : 8;
  const shutdownTimeoutMs = args['shutdown-timeout']
    ? Number.parseInt(args['shutdown-timeout'], 10)
    : 5000;

  for (const [name, value] of [['port', port], ['max-queue', maxQueueDepth], ['shutdown-timeout', shutdownTimeoutMs]]) {
    if (Number.isNaN(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative integer, got '${args[name]}'`);
    }
  }

  const pipeline = new PyramidPipeline({ cacheRoot });
  const service = new PyramidService(pipeline, { maxQueueDepth, shutdownTimeoutMs, port });
  const boundPort = await service.start();
  const base = `http://127.0.0.1:${boundPort}`;
  console.log(JSON.stringify({
    service: 'pyramid-cache',
    base,
    health: `${base}/health`,
    jobs: `${base}/jobs`,
    cacheRoot,
    shutdownTimeoutMs,
  }, null, 2));

  const shutdown = async signal => {
    console.error(`received ${signal}, shutting down (timeout ${shutdownTimeoutMs}ms)...`);
    const outcome = await service.shutdown();
    console.error(`shutdown complete: timedOut=${outcome.timedOut}`);
    process.exit(outcome.timedOut ? 1 : 0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('failed to start pyramid service:', err.message);
  process.exit(1);
});
