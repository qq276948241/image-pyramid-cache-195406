/*!
  Offline sample generator.

  Every sample is produced from raw pixels through the real sharp encode path
  at runtime — no pre-generated golden logs are shipped. Samples cover:
  boundary sizes (1x1, odd dimensions), transparency (semi/fully transparent
  pixels), EXIF orientation, mirror-friendly asymmetric patterns, animated
  WebP/GIF and multi-page TIFF with per-frame delays, and deliberately
  corrupt/garbage inputs for failure-path tests.
*/

import { Buffer } from 'node:buffer';
import sharp from 'sharp';

/**
 * Build a raw RGBA image where each pixel is a deterministic function of its
 * coordinates — asymmetric, so rotation/mirror changes are detectable.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} [pixel]
 * @returns {Buffer}
 */
export function rawPattern (width, height, pixel = defaultPixel) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y, width, height);
      const o = (y * width + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
    }
  }
  return buf;
}

/** Asymmetric RGBA pattern: gradients plus a bright corner marker. */
function defaultPixel (x, y, w, h) {
  const r = Math.round((x / Math.max(1, w - 1)) * 255);
  const g = Math.round((y / Math.max(1, h - 1)) * 255);
  const b = ((x === 0 && y === 0) ? 255 : 40);
  const a = (x === w - 1 && y === h - 1) ? 0 : 255; // one fully transparent pixel
  return [r, g, b, a];
}

/**
 * Inject an EXIF orientation tag into an encoded JPEG without re-decoding it.
 * APP1 segment: FF E1 <len:2> "Exif\0\0" <tiff: little endian IFD0 with Orientation>
 *
 * @param {Buffer} jpeg
 * @param {number} orientation 1..8
 * @returns {Buffer}
 */
export function injectExifOrientation (jpeg, orientation) {
  // Minimal little-endian TIFF with one IFD entry: Orientation (tag 0x0112, SHORT).
  const tiff = Buffer.alloc(26);
  let o = 0;
  tiff.write('II', o, 'ascii'); o += 2;          // little-endian
  tiff.writeUInt16LE(42, o); o += 2;              // magic
  tiff.writeUInt32LE(8, o); o += 4;               // IFD0 offset
  tiff.writeUInt16LE(1, o); o += 2;               // one entry
  tiff.writeUInt16LE(0x0112, o); o += 2;          // Orientation tag
  tiff.writeUInt16LE(3, o); o += 2;               // SHORT
  tiff.writeUInt32LE(1, o); o += 4;               // count
  tiff.writeUInt16LE(orientation, o); o += 2;     // value
  tiff.writeUInt16LE(0, o); o += 2;               // padding
  tiff.writeUInt32LE(0, o);                       // next IFD = none

  const exifHeader = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4 + exifHeader.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(exifHeader.length + 2, 2);
  exifHeader.copy(app1, 4);

  // JPEG begins with FFD8; insert APP1 immediately after SOI.
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/**
 * Create the full offline sample set.
 * @param {object} [opts]
 * @param {number} [opts.animatedFrames]
 * @returns {Promise<Record<string, Buffer>>}
 */
export async function createSampleSet ({ animatedFrames = 4 } = {}) {
  const samples = {};

  // --- static samples -------------------------------------------------------
  const patterns = {
    'static-1x1.png': [1, 1],
    'static-3x7.png': [3, 7],
    'static-7x3.png': [7, 3],
    'static-33x17.png': [33, 17],
    'static-64x48.png': [64, 48],
  };
  for (const [name, [w, h]] of Object.entries(patterns)) {
    samples[name] = await sharp(rawPattern(w, h), { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();
  }

  // Transparency-focused sample: half transparent, half opaque, one 50% alpha.
  const alpha = rawPattern(16, 16, (x, y) => {
        if (x < 8) return [200, 30, 30, 0];
        if (x === 8) return [30, 200, 30, 128];
        return [30, 30, 200, 255];
      });
  samples['transparent-16x16.png'] = await sharp(alpha, { raw: { width: 16, height: 16, channels: 4 } })
    .png()
    .toBuffer();

  // JPEG + injected EXIF orientation 6 (rotate 90 CW on display).
  const jpeg = await sharp(rawPattern(40, 24), { raw: { width: 40, height: 24, channels: 4 } })
    .jpeg()
    .toBuffer();
  samples['exif-orientation-6.jpg'] = injectExifOrientation(jpeg, 6);

  // Greyscale sample, fully opaque and alpha-free (removeAlpha first so the
  // output channel count reflects greyscale alone).
  samples['grey-20x12.png'] = await sharp(rawPattern(20, 12), { raw: { width: 20, height: 12, channels: 4 } })
    .removeAlpha()
    .greyscale()
    .png()
    .toBuffer();

  // --- animated / multi-page samples ----------------------------------------
  const frameSize = 12;
  const frames = [];
  const delays = [];
  for (let f = 0; f < animatedFrames; f++) {
    const shade = Math.round((f / Math.max(1, animatedFrames - 1)) * 250);
    frames.push(rawPattern(frameSize, frameSize, (x, y) => [
      shade,
      (x * 17 + f * 31) % 256,
      (y * 13 + f * 7) % 256,
      f === animatedFrames - 1 ? 120 : 255,
    ]));
    delays.push(100 + f * 50); // 100,150,200,250 ms
  }
  const strip = Buffer.concat(frames);
  const rawAnimOptions = {
    raw: { width: frameSize, height: frameSize * animatedFrames, channels: 4, pageHeight: frameSize },
  };
  samples[`animated-${animatedFrames}f.webp`] = await sharp(strip, rawAnimOptions)
    // Lossless so decoded pixels round-trip exactly for deterministic assertions.
    .webp({ delay: delays, loop: 2, lossless: true })
    .toBuffer();
  samples[`animated-${animatedFrames}f.gif`] = await sharp(strip, rawAnimOptions)
    .gif({ delay: delays, loop: 2 })
    .toBuffer();
  samples[`multipage-${animatedFrames}p.tiff`] = await sharp(strip, rawAnimOptions)
    .tiff({ multipage: true })
    .toBuffer();

  // --- failure samples -------------------------------------------------------
  const goodPng = samples['static-64x48.png'];
  samples['corrupt-truncated.png'] = goodPng.subarray(0, Math.floor(goodPng.length / 2));
  samples['corrupt-garbage.bin'] = Buffer.from('this is definitely not an image, just plain text bytes.');
  samples['corrupt-empty.bin'] = Buffer.alloc(0);
  // Valid header followed by random payload.
  samples['corrupt-bad-body.png'] = Buffer.concat([
    goodPng.subarray(0, 16),
    Buffer.from(Array.from({ length: 128 }, (_, i) => (i * 37) % 256)),
  ]);

  return samples;
}
