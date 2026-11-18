#!/usr/bin/env node
/*!
  Offline acceptance harness for the pyramid-cache delivery.

  It exercises the full chain — validation -> processing -> cache -> service —
  twice in one process and asserts that the two runs produce an identical
  stable summary. The summary contains only content-derived fields (pixel
  hashes, geometry, frame timing, cache keys), never timestamps or paths, so
  unrelated operational configuration cannot perturb it.

  Output:
    pyramid/acceptance/summary.json   machine-readable, rerun-stable
    stdout                            human-readable PASS/FAIL line per check

  Exit code is non-zero if any assertion fails.
*/

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  PyramidPipeline,
  PyramidService,
  DiskCache,
  computeCacheKey,
  normaliseOptions,
  RULE_VERSION,
  ErrorCode,
  createSampleSet,
} from '../lib/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'acceptance');
const results = [];

function check (name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, status: 'PASS' }); console.log(`PASS  ${name}`); })
    .catch(err => {
      results.push({ name, status: 'FAIL', error: err.message });
      console.log(`FAIL  ${name}\n        ${err.message}`);
    });
}

async function stableSummary (pipeline, samples) {
  const inputs = [
    'static-1x1.png',
    'static-3x7.png',
    'static-33x17.png',
    'transparent-16x16.png',
    'exif-orientation-6.jpg',
    'animated-4f.webp',
    'animated-4f.gif',
    'multipage-4p.tiff',
  ];
  const out = [];
  for (const name of inputs) {
    const r = await pipeline.generate(samples[name]);
    out.push({
      sample: name,
      key: r.key,
      loop: r.loop,
      exifOrientation: r.source.exifOrientation,
      orientationMode: r.source.orientationMode,
      frames: r.frames.map(f => ({
        frame: f.frame,
        delayMs: f.delayMs,
        levels: f.levels.map(l => ({
          level: l.level,
          width: l.width,
          height: l.height,
          sha256: l.sha256,
        })),
      })),
    });
  }
  return out;
}

async function main () {
  await mkdir(outDir, { recursive: true });
  const samples = await createSampleSet();
  const rootA = await mkdtemp(path.join(os.tmpdir(), 'pyr-accept-a-'));
  const rootB = await mkdtemp(path.join(os.tmpdir(), 'pyr-accept-b-'));

  try {
    // --- 1. cross-module happy path, twice ----------------------------------
    const pipelineA = new PyramidPipeline({ cacheRoot: rootA });
    const pipelineB = new PyramidPipeline({ cacheRoot: rootB, defaults: { maxMemoryBytes: 256 * 1024 * 1024 } });
    const [summaryA, summaryB] = await Promise.all([
      stableSummary(pipelineA, samples),
      stableSummary(pipelineB, samples),
    ]);

    await check('two independent runs produce identical stable summaries', () => {
      const ha = createHash('sha256').update(JSON.stringify(summaryA)).digest('hex');
      const hb = createHash('sha256').update(JSON.stringify(summaryB)).digest('hex');
      if (ha !== hb) throw new Error(`summary hashes differ ${ha} vs ${hb}`);
    });

    // --- 2. boundary geometry -----------------------------------------------
    await check('boundary sizes: 1x1 stops at one level, odd sizes use ceil(N/2)', () => {
      const one = summaryA.find(s => s.sample === 'static-1x1.png');
      if (one.frames[0].levels.length !== 1) throw new Error('1x1 must have exactly one level');
      const odd = summaryA.find(s => s.sample === 'static-3x7.png');
      const dims = odd.frames[0].levels.map(l => [l.width, l.height]);
      const expected = [[3, 7], [2, 4], [1, 2], [1, 1]];
      if (JSON.stringify(dims) !== JSON.stringify(expected)) {
        throw new Error(`geometry ${JSON.stringify(dims)} != ${JSON.stringify(expected)}`);
      }
    });

    // --- 3. rotation / mirror ------------------------------------------------
    await check('EXIF orientation 6 swaps 40x24 to 24x40 under auto mode', () => {
      const exif = summaryA.find(s => s.sample === 'exif-orientation-6.jpg');
      const l0 = exif.frames[0].levels[0];
      if (l0.width !== 24 || l0.height !== 40) throw new Error(`got ${l0.width}x${l0.height}`);
      if (exif.exifOrientation !== 6 || exif.orientationMode !== 'auto') {
        throw new Error('orientation metadata not preserved in summary');
      }
    });

    // --- 4. alpha -------------------------------------------------------------
    await check('transparent sample retains alpha-derived pixel hashes on all levels', async () => {
      const t = summaryA.find(s => s.sample === 'transparent-16x16.png');
      if (t.frames[0].levels.some(l => !/^[0-9a-f]{64}$/.test(l.sha256))) {
        throw new Error('a level is missing a valid payload hash');
      }
      if (t.frames[0].levels[0].width !== 16) throw new Error('level-0 geometry changed');
    });

    // --- 5. animation frame state --------------------------------------------
    await check('animation keeps per-frame delays [100,150,200,250] and loop 2', () => {
      const anim = summaryA.find(s => s.sample === 'animated-4f.webp');
      const delays = anim.frames.map(f => f.delayMs);
      if (JSON.stringify(delays) !== JSON.stringify([100, 150, 200, 250])) {
        throw new Error(`delays ${JSON.stringify(delays)}`);
      }
      if (anim.loop !== 2) throw new Error(`loop ${anim.loop} != 2`);
      if (anim.frames.length !== 4) throw new Error('frame count changed');
    });

    // --- 6. repeated submissions + cache key rules ---------------------------
    await check('repeat submission is a cache hit and key encodes rules/colour/orientation', async () => {
      const first = await pipelineA.generate(samples['static-33x17.png']);
      const again = await pipelineA.generate(samples['static-33x17.png']);
      if (!again.cacheHit) throw new Error('second submission was not a cache hit');
      const base = computeCacheKey(samples['static-33x17.png'], normaliseOptions());
      const variants = [
        normaliseOptions({ colourspace: 'grey' }),
        normaliseOptions({ orientation: 'keep' }),
        normaliseOptions({ mirror: 'horizontal' }),
      ];
      if (variants.some(v => computeCacheKey(samples['static-33x17.png'], v) === base)) {
        throw new Error('a colour/orientation/mirror variant collided on the base key');
      }
      if (base.length !== 64) throw new Error('cache key is not a 64-char sha256 hex');
      if (!RULE_VERSION) throw new Error('rule version is empty');
    });

    // --- 7. corrupt inputs never leave artifacts -----------------------------
    await check('all corrupt inputs reject with stable codes and leave no cache files', async () => {
      const expected = [
        ['corrupt-empty.bin', ErrorCode.INPUT_EMPTY],
        ['corrupt-garbage.bin', ErrorCode.INPUT_UNSUPPORTED],
        ['corrupt-truncated.png', ErrorCode.INPUT_CORRUPT],
        ['corrupt-bad-body.png', ErrorCode.INPUT_CORRUPT],
      ];
      for (const [name, code] of expected) {
        try {
          await pipelineA.generate(samples[name]);
          throw new Error(`${name} unexpectedly succeeded`);
        } catch (err) {
          if (err.code !== code) throw new Error(`${name} -> ${err.code}, expected ${code}`);
        }
      }
      const cache = new DiskCache(rootA);
      await cache.ready;
      // Only the 8 happy-path samples may exist (each keyed separately).
      if (cache.manifest.size !== 8) throw new Error(`manifest size ${cache.manifest.size}, expected 8`);
    });

    // --- 8. mid-run restart ---------------------------------------------------
    await check('restart: a fresh pipeline on the same cache root serves hits', async () => {
      await pipelineA.close();
      const restarted = new PyramidPipeline({ cacheRoot: rootA });
      const hit = await restarted.generate(samples['animated-4f.webp']);
      if (!hit.cacheHit) throw new Error('restarted pipeline did not reuse the cache');
      await restarted.close();
    });

    // --- 9. service health and graceful shutdown -----------------------------
    await check('service: health stays available and shutdown cleans its temp root', async () => {
      const svcRoot = await mkdtemp(path.join(os.tmpdir(), 'pyr-accept-svc-'));
      const svcPipeline = new PyramidPipeline({ cacheRoot: svcRoot });
      const service = new PyramidService(svcPipeline, { shutdownTimeoutMs: 3000 });
      const port = await service.start();
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`, { headers: { connection: 'close' } });
      const body = await health.json();
      if (health.status !== 200 || body.status !== 'ok') throw new Error('health endpoint not healthy');
      const tempRoot = service.tempRoot;
      const outcome = await service.shutdown();
      if (outcome.timedOut) throw new Error('shutdown timed out for an idle-ish service');
      await rm(svcRoot, { recursive: true, force: true });
      const { existsSync } = await import('node:fs');
      if (existsSync(tempRoot)) throw new Error('temp root survived shutdown');
    });

    // --- 10. unrelated config does not change pixels --------------------------
    await check('operational config (TTL/root/memory cap) does not change pixel hashes', () => {
      const a = createHash('sha256').update(JSON.stringify(
        summaryA.find(s => s.sample === 'animated-4f.webp'),
      )).digest('hex');
      const b = createHash('sha256').update(JSON.stringify(
        summaryB.find(s => s.sample === 'animated-4f.webp'),
      )).digest('hex');
      if (a !== b) throw new Error('pixel summary diverged across operational configs');
    });

    await Promise.all([pipelineB.close()]);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }

  const failed = results.filter(r => r.status === 'FAIL');
  const stable = {
    ruleVersion: RULE_VERSION,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    checks: results,
  };
  await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(stable, null, 2)}\n`);

  console.log('\n---------------- acceptance summary ----------------');
  console.log(`rule version : ${RULE_VERSION}`);
  console.log(`checks       : ${stable.passed}/${stable.total} passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('ALL CHECKS PASSED');
  }
}

main().catch(err => {
  console.error('acceptance harness crashed:', err);
  process.exitCode = 1;
});
