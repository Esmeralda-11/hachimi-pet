const zlib = require('node:zlib');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer (non-interlaced, 8-bit or 16-bit, color types 0/2/3/4/6) into RGBA Uint8Array.
 */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idatChunks = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) throw new Error('Invalid PNG dimensions');
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported by pure-Node fallback');
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} in pure-Node fallback`);
  }

  const channelsMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsMap[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);

  const bytesPerChannel = bitDepth / 8;
  const bpp = channels * bytesPerChannel;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const raw = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const srcRow = y * (1 + stride);
    const dstRow = y * stride;
    const filter = inflated[srcRow];
    for (let x = 0; x < stride; x++) {
      const val = inflated[srcRow + 1 + x];
      const left = x >= bpp ? raw[dstRow + x - bpp] : 0;
      const up = y > 0 ? raw[dstRow - stride + x] : 0;
      const upLeft = (x >= bpp && y > 0) ? raw[dstRow - stride + x - bpp] : 0;
      let out = val;
      if (filter === 1) out = (val + left) & 0xff;
      else if (filter === 2) out = (val + up) & 0xff;
      else if (filter === 3) out = (val + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) out = (val + paethPredictor(left, up, upLeft)) & 0xff;
      raw[dstRow + x] = out;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const trnsKeyGray = (colorType === 0 && trns && trns.length >= 2) ? trns.readUInt16BE(0) : -1;
  const trnsKeyRgb = (colorType === 2 && trns && trns.length >= 6)
    ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
    : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * bpp;
      const di = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[di] = raw[si];
        rgba[di + 1] = raw[si + bytesPerChannel];
        rgba[di + 2] = raw[si + 2 * bytesPerChannel];
        rgba[di + 3] = raw[si + 3 * bytesPerChannel];
      } else if (colorType === 2) {
        const r = raw[si];
        const g = raw[si + bytesPerChannel];
        const b = raw[si + 2 * bytesPerChannel];
        const isTransparent = trnsKeyRgb &&
          ((bitDepth === 8 && r === trnsKeyRgb[0] && g === trnsKeyRgb[1] && b === trnsKeyRgb[2]) ||
           (bitDepth === 16 && ((r << 8) | raw[si + 1]) === trnsKeyRgb[0] && ((g << 8) | raw[si + 3]) === trnsKeyRgb[1] && ((b << 8) | raw[si + 5]) === trnsKeyRgb[2]));
        rgba[di] = r;
        rgba[di + 1] = g;
        rgba[di + 2] = b;
        rgba[di + 3] = isTransparent ? 0 : 255;
      } else if (colorType === 3) {
        const idx = raw[si];
        const pi = idx * 3;
        rgba[di] = plte && pi + 2 < plte.length ? plte[pi] : 0;
        rgba[di + 1] = plte && pi + 2 < plte.length ? plte[pi + 1] : 0;
        rgba[di + 2] = plte && pi + 2 < plte.length ? plte[pi + 2] : 0;
        rgba[di + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
      } else if (colorType === 0) {
        const v = raw[si];
        rgba[di] = v;
        rgba[di + 1] = v;
        rgba[di + 2] = v;
        const isT = trnsKeyGray >= 0 && (bitDepth === 8 ? v === trnsKeyGray : ((v << 8) | raw[si + 1]) === trnsKeyGray);
        rgba[di + 3] = isT ? 0 : 255;
      } else if (colorType === 4) {
        const v = raw[si];
        rgba[di] = v;
        rgba[di + 1] = v;
        rgba[di + 2] = v;
        rgba[di + 3] = raw[si + bytesPerChannel];
      }
    }
  }

  return { width, height, data: rgba };
}

/**
 * Encode RGBA Uint8Array into a PNG Buffer.
 */
function encodePng(width, height, rgba) {
  const rowLen = width * 4;
  const raw = Buffer.alloc(height * (1 + rowLen));
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowLen;
    const dstOff = y * (1 + rowLen);
    raw[dstOff] = 1; // Sub filter for tighter compression
    for (let x = 0; x < rowLen; x++) {
      const left = x >= 4 ? rgba[srcOff + x - 4] : 0;
      raw[dstOff + 1 + x] = (rgba[srcOff + x] - left) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createRgba(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function cropRgba(img, x, y, w, h) {
  const out = createRgba(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.height) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (row * w + col) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

function compositeRgba(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      const sa = src.data[si + 3] / 255;
      if (sa <= 0) continue;
      const da = dst.data[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      dst.data[di] = Math.round((src.data[si] * sa + dst.data[di] * da * (1 - sa)) / outA);
      dst.data[di + 1] = Math.round((src.data[si + 1] * sa + dst.data[di + 1] * da * (1 - sa)) / outA);
      dst.data[di + 2] = Math.round((src.data[si + 2] * sa + dst.data[di + 2] * da * (1 - sa)) / outA);
      dst.data[di + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * Premultiplied-alpha bilinear / box-averaged resize to avoid dark halos on transparent boundaries.
 */
function resizeRgba(src, dstW, dstH) {
  const out = createRgba(dstW, dstH);
  const scaleX = src.width / dstW;
  const scaleY = src.height / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const di = (y * dstW + x) * 4;
      if (scaleX > 1.5 || scaleY > 1.5) {
        // Area box filter for crisp downscaling
        const x0 = Math.floor(x * scaleX);
        const x1 = Math.min(src.width, Math.ceil((x + 1) * scaleX));
        const y0 = Math.floor(y * scaleY);
        const y1 = Math.min(src.height, Math.ceil((y + 1) * scaleY));
        let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const si = (sy * src.width + sx) * 4;
            const a = src.data[si + 3] / 255;
            sr += src.data[si] * a;
            sg += src.data[si + 1] * a;
            sb += src.data[si + 2] * a;
            sa += a;
            count++;
          }
        }
        if (count > 0 && sa > 1e-4) {
          const avgA = sa / count;
          out.data[di] = Math.min(255, Math.round(sr / sa));
          out.data[di + 1] = Math.min(255, Math.round(sg / sa));
          out.data[di + 2] = Math.min(255, Math.round(sb / sa));
          out.data[di + 3] = Math.min(255, Math.round(avgA * 255));
        }
      } else {
        const fx = (x + 0.5) * scaleX - 0.5;
        const fy = (y + 0.5) * scaleY - 0.5;
        const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(fy)));
        const x1 = Math.min(src.width - 1, x0 + 1);
        const y1 = Math.min(src.height - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const ty = Math.max(0, Math.min(1, fy - y0));

        const idx = [
          (y0 * src.width + x0) * 4,
          (y0 * src.width + x1) * 4,
          (y1 * src.width + x0) * 4,
          (y1 * src.width + x1) * 4,
        ];
        const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let k = 0; k < 4; k++) {
          const a = (src.data[idx[k] + 3] / 255) * w[k];
          sr += src.data[idx[k]] * a;
          sg += src.data[idx[k] + 1] * a;
          sb += src.data[idx[k] + 2] * a;
          sa += a;
        }
        if (sa > 1e-4) {
          out.data[di] = Math.min(255, Math.round(sr / sa));
          out.data[di + 1] = Math.min(255, Math.round(sg / sa));
          out.data[di + 2] = Math.min(255, Math.round(sb / sa));
          out.data[di + 3] = Math.min(255, Math.round(sa * 255));
        }
      }
    }
  }
  return out;
}

function isGreenScreenPixel(r, g, b, a) {
  if (a < 16) return false;
  const maxRB = Math.max(r, b);
  return g >= 100 && (g - maxRB) >= 38 && (r <= 170 && b <= 170);
}

/**
 * Corner + grid-border flood-fill green-screen removal + edge-only chroma despill.
 * Never removes interior enclosed green pixels (such as green cat eyes!).
 */
function keyGreenScreenFloodFill(img, cols = 1, rows = 1) {
  const { width: w, height: h, data } = img;
  let borderCount = 0;
  let transparentBorder = 0;
  let greenBorder = 0;

  const checkSample = (x, y) => {
    const i = (y * w + x) * 4;
    borderCount++;
    if (data[i + 3] < 16) transparentBorder++;
    else if (isGreenScreenPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) greenBorder++;
  };

  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 64))) {
    checkSample(x, 0);
    checkSample(x, h - 1);
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 64))) {
    checkSample(0, y);
    checkSample(w - 1, y);
  }

  // Already transparent border -> do not key out anything
  if (transparentBorder > borderCount * 0.25 && greenBorder < borderCount * 0.15) {
    return img;
  }
  // Not a green-screen background
  if (greenBorder < borderCount * 0.2) {
    return img;
  }

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const trySeed = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const p = y * w + x;
    if (visited[p]) return;
    const i = p * 4;
    const a = data[i + 3];
    if (a < 16 || isGreenScreenPixel(data[i], data[i + 1], data[i + 2], a)) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }
  // Also seed along cell borders ONLY where pixel is background green
  if (cols > 1) {
    for (let c = 1; c < cols; c++) {
      const gx = Math.round((c * w) / cols);
      for (let y = 0; y < h; y++) {
        trySeed(gx - 1, y);
        trySeed(gx, y);
      }
    }
  }
  if (rows > 1) {
    for (let r = 1; r < rows; r++) {
      const gy = Math.round((r * h) / rows);
      for (let x = 0; x < w; x++) {
        trySeed(x, gy - 1);
        trySeed(x, gy);
      }
    }
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) trySeed(x - 1, y);
    if (x + 1 < w) trySeed(x + 1, y);
    if (y > 0) trySeed(x, y - 1);
    if (y + 1 < h) trySeed(x, y + 1);
  }

  for (let p = 0; p < w * h; p++) {
    if (visited[p]) {
      const i = p * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }

  // Edge-only spill suppression on boundary pixels adjacent to keyed background
  const boundary = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (data[p * 4 + 3] === 0) continue;
      let nearTrans = false;
      for (let dy = -2; dy <= 2 && !nearTrans; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (data[(ny * w + nx) * 4 + 3] === 0) {
            nearTrans = true;
            break;
          }
        }
      }
      if (nearTrans) boundary[p] = 1;
    }
  }

  for (let p = 0; p < w * h; p++) {
    if (!boundary[p]) continue;
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const maxRB = Math.max(r, b);
    if (g > maxRB) {
      const excess = g - maxRB;
      data[i + 1] = maxRB;
      if (excess > 30 && data[i + 3] > 0) {
        data[i + 3] = Math.max(0, Math.round(data[i + 3] * Math.max(0.2, 1 - (excess - 30) / 140)));
      }
    }
  }

  return img;
}

function findAlphaBbox(img, threshold = 12) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      if (a > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Pure-Node compact-4x3 processor: flood-fill green key + 192x208 cells bottom-aligned at y=196 -> 768x624 PNG.
 */
function processCompact4x3PngBuffer(pngBuffer) {
  const src = decodePng(pngBuffer);
  keyGreenScreenFloodFill(src, 4, 3);

  const CELL_W = 192;
  const CELL_H = 208;
  const MAX_W = 172;
  const MAX_H = 184;
  const BASE_Y = 196;
  const out = createRgba(CELL_W * 4, CELL_H * 3);
  let thumbBuf = null;

  for (let r = 0; r < 3; r++) {
    const y0 = Math.round((r * src.height) / 3);
    const y1 = Math.round(((r + 1) * src.height) / 3);
    for (let c = 0; c < 4; c++) {
      const x0 = Math.round((c * src.width) / 4);
      const x1 = Math.round(((c + 1) * src.width) / 4);
      const cell = cropRgba(src, x0, y0, x1 - x0, y1 - y0);
      const bb = findAlphaBbox(cell, 12);
      if (!bb) continue;
      const cropped = cropRgba(cell, bb.x, bb.y, bb.w, bb.h);
      const scale = Math.min(MAX_W / bb.w, MAX_H / bb.h);
      const nw = Math.max(1, Math.round(bb.w * scale));
      const nh = Math.max(1, Math.round(bb.h * scale));
      const resized = resizeRgba(cropped, nw, nh);
      const dx = c * CELL_W + Math.round((CELL_W - nw) / 2);
      const dy = r * CELL_H + (BASE_Y - nh);
      compositeRgba(out, resized, dx, dy);

      if (r === 0 && c === 0) {
        thumbBuf = makeThumbFromRgba(cropped, 256);
      }
    }
  }

  if (!thumbBuf) {
    thumbBuf = makeFallbackPawThumbPng();
  }
  return {
    atlasPng: encodePng(out.width, out.height, out.data),
    thumbPng: thumbBuf,
  };
}

function processCodex8x11PngBuffer(pngBuffer) {
  const src = decodePng(pngBuffer);
  keyGreenScreenFloodFill(src, 8, 11);

  const CELL_W = 192;
  const CELL_H = 208;
  const COLS = 8;
  const ROWS = 11;

  let out;
  if (src.width === CELL_W * COLS && src.height === CELL_H * ROWS) {
    out = src;
  } else {
    out = createRgba(CELL_W * COLS, CELL_H * ROWS);
    for (let r = 0; r < ROWS; r++) {
      const y0 = Math.round((r * src.height) / ROWS);
      const y1 = Math.round(((r + 1) * src.height) / ROWS);
      for (let c = 0; c < COLS; c++) {
        const x0 = Math.round((c * src.width) / COLS);
        const x1 = Math.round(((c + 1) * src.width) / COLS);
        const cell = cropRgba(src, x0, y0, x1 - x0, y1 - y0);
        const bb = findAlphaBbox(cell, 12);
        if (!bb) continue;
        const cropped = cropRgba(cell, bb.x, bb.y, bb.w, bb.h);
        const scale = Math.min((CELL_W - 16) / bb.w, (CELL_H - 16) / bb.h);
        const nw = Math.max(1, Math.round(bb.w * scale));
        const nh = Math.max(1, Math.round(bb.h * scale));
        const resized = resizeRgba(cropped, nw, nh);
        const dx = c * CELL_W + Math.round((CELL_W - nw) / 2);
        const dy = r * CELL_H + (200 - nh);
        compositeRgba(out, resized, dx, dy);
      }
    }
  }

  const firstCell = cropRgba(out, 0, 0, CELL_W, CELL_H);
  const firstBb = findAlphaBbox(firstCell, 12);
  const thumbPng = firstBb
    ? makeThumbFromRgba(cropRgba(firstCell, firstBb.x, firstBb.y, firstBb.w, firstBb.h), 256)
    : makeFallbackPawThumbPng();

  return {
    atlasPng: encodePng(out.width, out.height, out.data),
    thumbPng,
  };
}

function makeThumbFromRgba(sprite, size = 256) {
  const pad = Math.round(size * 0.86);
  const scale = Math.min(pad / sprite.width, pad / sprite.height);
  const nw = Math.max(1, Math.round(sprite.width * scale));
  const nh = Math.max(1, Math.round(sprite.height * scale));
  const resized = resizeRgba(sprite, nw, nh);
  const canvas = createRgba(size, size);
  compositeRgba(canvas, resized, Math.round((size - nw) / 2), Math.round((size - nh) / 2));
  return encodePng(size, size, canvas.data);
}

function makeThumbFromPngBuffer(pngBuffer) {
  const src = decodePng(pngBuffer);
  const bb = findAlphaBbox(src, 12);
  const cropped = bb ? cropRgba(src, bb.x, bb.y, bb.w, bb.h) : src;
  return makeThumbFromRgba(cropped, 256);
}

function makeFallbackPawThumbPng(hexColor = '#F59E0B') {
  const size = 256;
  const canvas = createRgba(size, size);
  const clean = String(hexColor || '#F59E0B').replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 245;
  const g = parseInt(clean.slice(2, 4), 16) || 158;
  const b = parseInt(clean.slice(4, 6), 16) || 11;

  const paintCircle = (cx, cy, rad, cr, cg, cb, ca = 255) => {
    const x0 = Math.max(0, Math.floor(cx - rad - 1));
    const x1 = Math.min(size - 1, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad - 1));
    const y1 = Math.min(size - 1, Math.ceil(cy + rad + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rad + 1) {
          const edge = Math.max(0, Math.min(1, rad + 1 - d));
          const di = (y * size + x) * 4;
          const a = Math.round(ca * edge);
          if (a > canvas.data[di + 3]) {
            canvas.data[di] = cr;
            canvas.data[di + 1] = cg;
            canvas.data[di + 2] = cb;
            canvas.data[di + 3] = a;
          }
        }
      }
    }
  };

  paintCircle(128, 128, 104, 24, 28, 38, 240);
  paintCircle(128, 152, 46, r, g, b, 255);
  paintCircle(78, 102, 20, r, g, b, 255);
  paintCircle(108, 78, 20, r, g, b, 255);
  paintCircle(148, 78, 20, r, g, b, 255);
  paintCircle(178, 102, 20, r, g, b, 255);

  return encodePng(size, size, canvas.data);
}

module.exports = {
  decodePng,
  encodePng,
  processCompact4x3PngBuffer,
  processCodex8x11PngBuffer,
  makeThumbFromPngBuffer,
  makeFallbackPawThumbPng,
};
