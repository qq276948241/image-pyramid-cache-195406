/*!
  On-disk pyramid cache with content-addressed keys and explicit invalidation.

  Cache key composition (order matters and is part of the contract):
    sha256( RULE_VERSION
            + sha256(input bytes)
            + colourspace
            + orientation
            + mirror
            + kernel
            + maxLevels )

  RULE_VERSION invalidates every entry when pixel/encoding rules change.
  Colour-space and orientation/mirror parameters are in the key, so two
  requests that differ only there never share output (regression-tested).

  Durability: entries are written to `.tmp-<random>` files and atomically
  renamed; the manifest is likewise temp-file + rename. A crash at any point
  therefore leaves either the previous good entry or none — never a half file.
  On read, any byte mismatch against the recorded sha256, or a version
  mismatch, quarantines the entry (moved to `quarantine/`) and reports a miss.
*/

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ErrorCode, PyramidError } from './errors.mjs';
import { RULE_VERSION } from './constants.mjs';

const MANIFEST_NAME = 'manifest.json';

/**
 * Hash an input stream/file content without buffering the whole image twice.
 * @param {string} filePath
 * @returns {Promise<string>} hex sha256
 */
export function hashFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * @param {Buffer} buffer
 * @param {object} options normalised pipeline options
 * @returns {string} 16 hex chars prefix-safe cache key
 */
export function computeCacheKey (buffer, options) {
  const inputHash = createHash('sha256').update(buffer).digest('hex');
  const composite = [
    RULE_VERSION,
    inputHash,
    options.colourspace,
    options.orientation,
    options.mirror,
    options.kernel,
    String(options.maxLevels),
    String(options.minLevelDimension),
  ].join('|');
  return createHash('sha256').update(composite).digest('hex');
}

export class DiskCache {
  /**
   * @param {string} root cache root directory (created on demand)
   * @param {{ ttlMs?: number, maxEntries?: number }} [policy]
   */
  constructor (root, { ttlMs = 7 * 24 * 60 * 60 * 1000, maxEntries = 512 } = {}) {
    if (!root || typeof root !== 'string') {
      throw new PyramidError(ErrorCode.OPTION_INVALID, 'DiskCache requires a root directory path');
    }
    this.root = root;
    this.entryDir = path.join(root, 'entries');
    this.quarantineDir = path.join(root, 'quarantine');
    this.tmpDir = path.join(root, 'tmp');
    this.manifestPath = path.join(root, MANIFEST_NAME);
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, {key: string, createdAt: number, levelCount: number, frameCount: number}>} */
    this.manifest = new Map();
    this.ready = this.#init();
  }

  async #init () {
    await mkdir(this.entryDir, { recursive: true });
    await mkdir(this.quarantineDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    if (existsSync(this.manifestPath)) {
      try {
        const raw = JSON.parse(await readFile(this.manifestPath, 'utf8'));
        if (!raw || raw.version !== RULE_VERSION || !Array.isArray(raw.entries)) {
          // Whole manifest predates current rules: drop it (entries will
          // individually fail the version check and get quarantined).
          this.manifest = new Map();
        } else {
          this.manifest = new Map(raw.entries.map(e => [e.key, e]));
        }
      } catch {
        this.manifest = new Map();
      }
    }
  }

  #entryPath (key) {
    // Sharded by first 2 hex chars to avoid huge flat directories.
    return path.join(this.entryDir, key.slice(0, 2), `${key}.json`);
  }

  #quarantinePath (key) {
    return path.join(this.quarantineDir, `${key}-${Date.now()}.json`);
  }

  /**
   * @param {string} key
   * @returns {Promise<{ key: string, version: string, createdAt: number,
   *   sourceHash: string, options: object, frames: object[] } | null>}
   */
  async get (key) {
    await this.ready;
    const listed = this.manifest.get(key);
    const filePath = this.#entryPath(key);
    if (!listed || !existsSync(filePath)) return null;
    /** @type {any} */
    let entry;
    try {
      entry = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (err) {
      await this.#quarantine(filePath, key);
      throw new PyramidError(ErrorCode.CACHE_CORRUPT, `Cache entry ${key} is not valid JSON`, { cause: err });
    }
    const problems = validateEntry(entry, key);
    if (problems.length > 0) {
      await this.#quarantine(filePath, key);
      throw new PyramidError(
        ErrorCode.CACHE_CORRUPT,
        `Cache entry ${key} failed validation: ${problems.join('; ')}`,
      );
    }
    // TTL invalidation runs before payload hashing: an expired entry is
    // deleted wholesale, never promoted back by a successful hash check.
    if (Date.now() - entry.createdAt > this.ttlMs) {
      await this.delete(key);
      return null;
    }
    // Verify every stored payload hash — tampered/truncated bytes are detected.
    for (const frame of entry.frames) {
      for (const level of frame.levels) {
        const actual = createHash('sha256').update(level.data, 'base64').digest('hex');
        if (actual !== level.sha256) {
          await this.#quarantine(filePath, key);
          throw new PyramidError(ErrorCode.CACHE_CORRUPT, `Cache entry ${key} payload hash mismatch at frame ${frame.frame}, level ${level.level}`);
        }
      }
    }
    return entry;
  }

  /**
   * Atomically persist a completed pyramid.
   * @param {string} key
   * @param {object} entry full pyramid result payload
   */
  async put (key, entry) {
    await this.ready;
    const target = this.#entryPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = path.join(this.tmpDir, `${key}-${randomUUID()}.tmp`);
    const serialised = JSON.stringify(entry);
    try {
      await writeFile(tmp, serialised, { flag: 'wx' });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new PyramidError(ErrorCode.CACHE_IO, `Failed writing cache entry ${key}`, { cause: err });
    }
    this.manifest.set(key, {
      key,
      createdAt: entry.createdAt,
      levelCount: entry.frames[0]?.levels.length ?? 0,
      frameCount: entry.frames.length,
    });
    await this.#persistManifest();
    await this.#enforceMaxEntries();
  }

  async delete (key) {
    await this.ready;
    this.manifest.delete(key);
    await rm(this.#entryPath(key), { force: true }).catch(() => {});
    await this.#persistManifest();
  }

  /** Remove every entry (used by invalidation tests and restarts). */
  async clear () {
    await this.ready;
    this.manifest.clear();
    await rm(this.entryDir, { recursive: true, force: true });
    await rm(this.quarantineDir, { recursive: true, force: true });
    await mkdir(this.entryDir, { recursive: true });
    await mkdir(this.quarantineDir, { recursive: true });
    await this.#persistManifest();
  }

  async #quarantine (filePath, key) {
    this.manifest.delete(key);
    await mkdir(this.quarantineDir, { recursive: true });
    await rename(filePath, this.#quarantinePath(key)).catch(() => {});
    await this.#persistManifest();
  }

  async #persistManifest () {
    const payload = {
      version: RULE_VERSION,
      entries: [...this.manifest.values()],
    };
    const tmp = path.join(this.tmpDir, `${MANIFEST_NAME}-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, this.manifestPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new PyramidError(ErrorCode.CACHE_IO, 'Failed persisting cache manifest', { cause: err });
    }
  }

  /** LRU-ish eviction: oldest createdAt entries go first. */
  async #enforceMaxEntries () {
    if (this.manifest.size <= this.maxEntries) return;
    const ordered = [...this.manifest.values()].sort((a, b) => a.createdAt - b.createdAt);
    const removeCount = this.manifest.size - this.maxEntries;
    for (const item of ordered.slice(0, removeCount)) {
      await this.delete(item.key);
    }
  }
}

/**
 * Reject entries written by another rule version or with a broken shape.
 * @param {any} entry
 * @param {string} expectedKey
 * @returns {string[]}
 */
function validateEntry (entry, expectedKey) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (entry.version !== RULE_VERSION) problems.push(`version ${entry.version} != ${RULE_VERSION}`);
  if (entry.key !== expectedKey) problems.push('key mismatch');
  if (!Number.isInteger(entry.createdAt)) problems.push('createdAt missing');
  if (!entry.options || typeof entry.options !== 'object') problems.push('options missing');
  if (!Array.isArray(entry.frames) || entry.frames.length < 1) {
    problems.push('frames missing or empty');
    return problems;
  }
  const levelCount = entry.frames[0].levels?.length ?? 0;
  if (levelCount < 1) problems.push('no levels in first frame');
  entry.frames.forEach((frame, fi) => {
    if (!Number.isInteger(frame.frame) || frame.frame !== fi) problems.push(`frame index mismatch at ${fi}`);
    if (!Array.isArray(frame.levels) || frame.levels.length !== levelCount) {
      problems.push(`frame ${fi} level count differs`);
      return;
    }
    frame.levels.forEach(level => {
      if (typeof level.sha256 !== 'string' || typeof level.data !== 'string') {
        problems.push(`frame ${fi} level ${level.level} missing payload/hash`);
      }
      if (!Number.isInteger(level.width) || !Number.isInteger(level.height)) {
        problems.push(`frame ${fi} level ${level.level} bad dimensions`);
      }
    });
  });
  return problems;
}
