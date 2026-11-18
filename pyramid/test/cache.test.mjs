import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DiskCache,
  PyramidPipeline,
  RULE_VERSION,
  ErrorCode,
  normaliseOptions,
  computeCacheKey,
} from '../lib/index.mjs';
import { samples, tempDir } from './helpers.mjs';

function entryPathFor (root, key) {
  return path.join(root, 'entries', key.slice(0, 2), `${key}.json`);
}

test('cache hit after restart: a new pipeline instance on the same root reuses data', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const first = new PyramidPipeline({ cacheRoot: dir });
    const result = await first.generate(s['static-64x48.png']);
    assert.equal(result.cacheHit, false);
    await first.close();

    const restarted = new PyramidPipeline({ cacheRoot: dir });
    const again = await restarted.generate(s['static-64x48.png']);
    assert.equal(again.cacheHit, true);
    assert.equal(again.key, result.key);
    assert.deepEqual(
      again.frames.map(f => f.levels.map(l => l.sha256)),
      result.frames.map(f => f.levels.map(l => l.sha256)),
    );
    await restarted.close();
  } finally {
    await cleanup();
  }
});

test('cache entry on disk contains explicit RULE_VERSION and option fingerprint', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir, defaults: { colourspace: 'grey' } });
    const result = await pipeline.generate(s['static-64x48.png']);
    const onDisk = JSON.parse(await readFile(entryPathFor(dir, result.key), 'utf8'));
    assert.equal(onDisk.version, RULE_VERSION);
    assert.equal(onDisk.options.colourspace, 'grey');
    assert.equal(onDisk.options.orientation, 'auto');
    assert.equal(onDisk.options.mirror, 'none');
    assert.equal(onDisk.source.sha256.length, 64);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('tampered payload bytes are detected, quarantined and trigger a rebuild', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['static-64x48.png']);
    await pipeline.close();

    // Corrupt one level's base64 payload on disk, keep its recorded hash.
    const filePath = entryPathFor(dir, result.key);
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    onDisk.frames[0].levels[0].data = onDisk.frames[0].levels[0].data.replace(/.$/, 'A');
    await writeFile(filePath, JSON.stringify(onDisk));

    const cache = new DiskCache(dir);
    await assert.rejects(
      () => cache.get(result.key),
      err => err.code === ErrorCode.CACHE_CORRUPT && /hash mismatch/.test(err.message),
    );
    // Entry was moved into quarantine and removed from the manifest.
    const quarantined = await readdir(path.join(dir, 'quarantine'));
    assert.equal(quarantined.length, 1);
    assert.equal(cache.manifest.has(result.key), false);

    // Pipeline treats quarantine as a miss and rebuilds successfully.
    const rebuilt = new PyramidPipeline({ cacheRoot: dir });
    const fresh = await rebuilt.generate(s['static-64x48.png']);
    assert.equal(fresh.cacheHit, false);
    assert.equal(fresh.frames[0].levels[0].sha256, result.frames[0].levels[0].sha256);
    await rebuilt.close();
  } finally {
    await cleanup();
  }
});

test('entry written by a different rule version is rejected on read', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    const result = await pipeline.generate(s['static-64x48.png']);
    await pipeline.close();

    const filePath = entryPathFor(dir, result.key);
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    onDisk.version = 'pyr-rule-0-obsolete';
    await writeFile(filePath, JSON.stringify(onDisk));

    const cache = new DiskCache(dir);
    await assert.rejects(
      () => cache.get(result.key),
      err => err.code === ErrorCode.CACHE_CORRUPT && /version/.test(err.message),
    );
  } finally {
    await cleanup();
  }
});

test('TTL expiry removes stale entries on access', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const cache = new DiskCache(dir, { ttlMs: 30 });
    const key = computeCacheKey(s['static-64x48.png'], normaliseOptions());
    // Build a structurally valid entry with a correct payload hash so the
    // TTL branch (not the corruption branch) decides the outcome.
    const payload = Buffer.from('a');
    const entry = {
      version: RULE_VERSION,
      key,
      createdAt: Date.now(),
      options: {},
      frames: [{
        frame: 0,
        levels: [{
          level: 0,
          width: 1,
          height: 1,
          sha256: createHash('sha256').update(payload).digest('hex'),
          data: payload.toString('base64'),
        }],
      }],
    };
    await cache.put(key, entry);
    assert.ok(await cache.get(key));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(await cache.get(key), null);
  } finally {
    await cleanup();
  }
});

test('maxEntries evicts the oldest entries first', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const cache = new DiskCache(dir, { maxEntries: 2 });
    const makeEntry = key => ({
      version: RULE_VERSION,
      key,
      createdAt: Number(key), // numeric, ordered
      options: {},
      frames: [{ frame: 0, levels: [{ level: 0, width: 1, height: 1, sha256: 'x'.repeat(64), data: Buffer.from('a').toString('base64') }] }],
    });
    await cache.put('1'.repeat(64), makeEntry(1));
    await cache.put('2'.repeat(64), makeEntry(2));
    await cache.put('3'.repeat(64), makeEntry(3));
    assert.equal(cache.manifest.size, 2);
    assert.equal(cache.manifest.has('1'.repeat(64)), false, 'oldest must be evicted');
    assert.ok(cache.manifest.has('3'.repeat(64)));
  } finally {
    await cleanup();
  }
});

test('no temp files are left behind after successful writes', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const pipeline = new PyramidPipeline({ cacheRoot: dir });
    await pipeline.generate(s['static-64x48.png']);
    await pipeline.generate(s['static-33x17.png']);
    const tmpFiles = await readdir(path.join(dir, 'tmp'));
    assert.deepEqual(tmpFiles.filter(f => f.endsWith('.tmp')), []);
    await pipeline.close();
  } finally {
    await cleanup();
  }
});

test('clear() empties entries, quarantine and manifest', async () => {
  const s = await samples();
  const { dir, cleanup } = await tempDir();
  try {
    const cache = new DiskCache(dir);
    const key = computeCacheKey(s['static-64x48.png'], normaliseOptions());
    await cache.put(key, {
      version: RULE_VERSION,
      key,
      createdAt: Date.now(),
      options: {},
      frames: [{ frame: 0, levels: [{ level: 0, width: 1, height: 1, sha256: 'x'.repeat(64), data: Buffer.from('a').toString('base64') }] }],
    });
    await cache.clear();
    assert.equal(cache.manifest.size, 0);
    assert.deepEqual(await readdir(path.join(dir, 'entries')), []);
    assert.deepEqual(await readdir(path.join(dir, 'quarantine')), []);
  } finally {
    await cleanup();
  }
});
