/**
 * Universal 2D Sprite-Pack Figure adapter for `kit/body.js`.
 * Supports:
 * - `codex-v2-8x11`: 8 cols x 11 rows (192x208 cells), with native left/right running rows,
 *   16-direction compass gaze tracking (rows 9-10), and horizontal counter-flip when `asymmetric: true`
 *   so asymmetrical markings (e.g. chin/cheek spots) never mirror when turning left/right.
 * - `compact-4x3`: 4 cols x 3 rows (192x208 cells):
 *   row 0 = [idle-open, idle-blink, wave/happy, curious/look],
 *   row 1 = 4-frame chase-butterfly running-right (flipped naturally by `body.js` `pet.faceVis`),
 *   row 2 = [yarn-work-0, yarn-work-1, curled-sleep-0, curled-sleep-1].
 * - `single-image`: SVG `<image>` element so animated GIF/WebP plays natively.
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const f1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const imageCache = new Map();

function resolveAssetUrl(rawUrl, base) {
  if (!rawUrl) return '';
  if (/^(https?:|data:|blob:)/i.test(rawUrl)) return rawUrl;
  const origin = base || (typeof window !== 'undefined' ? window.location.origin : '');
  if (!origin) return rawUrl;
  try {
    return new URL(rawUrl, origin).toString();
  } catch {
    return rawUrl;
  }
}

function loadImageDefault(url) {
  if (!url) return Promise.reject(new Error('Empty sprite asset URL'));
  if (imageCache.has(url)) {
    const cached = imageCache.get(url);
    if (cached.complete && cached.naturalWidth > 0) {
      return Promise.resolve(cached);
    }
  }
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      imageCache.set(url, im);
      resolve(im);
    };
    im.onerror = (err) => reject(err || new Error(`Failed to load ${url}`));
    im.src = url;
  });
}

function pickVariant(pack, variantId) {
  const variants = Array.isArray(pack?.variants) ? pack.variants : [];
  if (variants.length === 0) return null;
  return (
    variants.find((v) => v.id === variantId) ||
    variants.find((v) => v.id === pack?.defaultVariant) ||
    variants[0]
  );
}

const IDLE_DURATIONS_MS = [280, 110, 110, 140, 140, 320];
const IDLE_CYCLE_TOTAL_MS = 1100;
const WAVING_DURATIONS_MS = [140, 140, 140, 280];
const JUMPING_DURATIONS_MS = [140, 140, 140, 140, 280];
const FAILED_DURATIONS_MS = [140, 140, 140, 140, 140, 140, 140, 240];
const WAITING_DURATIONS_MS = [150, 150, 150, 150, 150, 260];

function pickTimedFrame(durationsMs, tSec) {
  let total = 0;
  for (let i = 0; i < durationsMs.length; i++) total += durationsMs[i];
  if (total <= 0) return 0;
  const ms = ((tSec * 1000) % total + total) % total;
  let acc = 0;
  for (let i = 0; i < durationsMs.length; i++) {
    acc += durationsMs[i];
    if (ms < acc) return i;
  }
  return durationsMs.length - 1;
}

/**
 * Select `(row, col)` for `codex-v2-8x11` atlas.
 * Rows:
 *  0: idle (6f: 0..5, breathing + blink cycle every 3.6-5.0s)
 *  1: running-right (8f @ 120ms)
 *  2: running-left (8f @ 120ms)
 *  3: waving (4f)
 *  4: jumping (5f: 0..4) + mouse-hold & drag sway (3f: 5=HOLD, 6=left-sway, 7=right-sway)
 *  5: failed (8f)
 *  6: waiting (6f)
 *  7: running / yarn-ball working (6f @ 130ms)
 *  8: review / reading / awaiting-next (6f @ 160ms)
 *  9: look 000..157.5 (8f)
 * 10: look 180..337.5 (8f)
 */
export function selectCodex8x11Cell(frame, _face, codexState = {}) {
  const mode = frame.mode || 'idle';
  const fname = frame.face || 'neutral';
  const status = String(frame.status || '').toUpperCase();
  const gesture = frame.gesture?.kind || '';
  const t = Number(frame.t || 0);
  const modeT = Number(frame.modeT || 0);
  const facing = (frame.facing ?? 1) >= 0 ? 1 : -1;
  const hasHoldCell = Boolean(codexState.hasHoldCell ?? frame.hasHoldCell);
  const hasHoldSwayLeft = codexState.hasHoldSwayLeft !== undefined ? Boolean(codexState.hasHoldSwayLeft) : hasHoldCell;
  const hasHoldSwayRight = codexState.hasHoldSwayRight !== undefined ? Boolean(codexState.hasHoldSwayRight) : hasHoldCell;

  const leaveIdle = () => {
    codexState.wasIdle = false;
    codexState.blinkStartAt = -1;
    codexState.prevLookIdx = null;
  };

  if (mode === 'drag') {
    leaveIdle();
    const vx = Number(frame.dragVx ?? frame.velX ?? frame.vx ?? 0) || 0;
    const vy = Number(frame.dragVy ?? frame.vy ?? 0) || 0;
    const tilt = Number(frame.tilt || 0) || 0;
    if (hasHoldCell) {
      let col = 5;
      if (Math.abs(vx) > 28 || Math.abs(tilt) > 3.5) {
        // Dragging right (vx > 0 / tilt > 0) swings lower body left (c6); dragging left swings right (c7)
        const wantLeftSway = vx > 28 || (Math.abs(vx) <= 28 && tilt > 3.5);
        if (wantLeftSway) {
          col = hasHoldSwayLeft ? 6 : (hasHoldSwayRight ? 7 : 5);
        } else {
          col = hasHoldSwayRight ? 7 : (hasHoldSwayLeft ? 6 : 5);
        }
      } else if (Math.abs(vy) > 45) {
        const pickLeft = Math.floor((t * 1000) / 220) % 2 === 0;
        if (pickLeft) {
          col = hasHoldSwayLeft ? 6 : (hasHoldSwayRight ? 7 : 5);
        } else {
          col = hasHoldSwayRight ? 7 : (hasHoldSwayLeft ? 6 : 5);
        }
      }
      return { row: 4, col, hasBuiltInQuestion: false };
    }
    const sway = Math.abs(vx || tilt) > 18;
    const col = sway ? (Math.floor((t * 1000) / 220) % 2 === 0 ? 2 : 1) : 2;
    return { row: 4, col, hasBuiltInQuestion: false };
  }

  if (frame.pressing) {
    leaveIdle();
    return { row: 4, col: hasHoldCell ? 5 : 0, hasBuiltInQuestion: false };
  }

  if (mode === 'walk' || mode === 'run') {
    leaveIdle();
    const row = facing >= 0 ? 1 : 2;
    const col = Math.floor((t * 1000) / 120) % 8;
    return { row, col, hasBuiltInQuestion: false };
  }

  if (mode === 'crouch') {
    leaveIdle();
    return { row: 4, col: 0, hasBuiltInQuestion: false };
  }

  if (mode === 'air') {
    leaveIdle();
    const vy = Number(frame.vy || 0);
    const col = vy < -130 ? 1 : vy > 130 ? 3 : 2;
    return { row: 4, col, hasBuiltInQuestion: false };
  }

  if (mode === 'land' && modeT < 0.24) {
    leaveIdle();
    return { row: 4, col: 4, hasBuiltInQuestion: false };
  }

  if (gesture === 'wave' || mode === 'dance') {
    leaveIdle();
    return { row: 3, col: pickTimedFrame(WAVING_DURATIONS_MS, t), hasBuiltInQuestion: false };
  }

  if (
    gesture === 'jump' ||
    gesture === 'hop' ||
    gesture === 'bounce' ||
    gesture === 'flap'
  ) {
    leaveIdle();
    return { row: 4, col: pickTimedFrame(JUMPING_DURATIONS_MS, t), hasBuiltInQuestion: false };
  }

  if (
    status === 'ERROR' ||
    mode === 'dizzy' ||
    fname === 'cry' ||
    fname === 'sad' ||
    fname === 'angry' ||
    fname === 'confused' ||
    fname === 'scared' ||
    fname === 'flustered'
  ) {
    leaveIdle();
    return { row: 5, col: pickTimedFrame(FAILED_DURATIONS_MS, t), hasBuiltInQuestion: true };
  }

  if (
    status === 'WAITING_USER' ||
    status === 'WAITING' ||
    mode === 'sleep' ||
    fname === 'sleep' ||
    fname === 'sleepy'
  ) {
    leaveIdle();
    return { row: 6, col: pickTimedFrame(WAITING_DURATIONS_MS, t), hasBuiltInQuestion: false };
  }

  if (
    status === 'THINKING' ||
    status === 'CODING' ||
    status === 'RUNNING_CMD' ||
    status === 'WORKING'
  ) {
    leaveIdle();
    const col = Math.floor((t * 1000) / 130) % 6;
    return { row: 7, col, hasBuiltInQuestion: false };
  }

  if (status === 'READING' || status === 'AWAITING_NEXT') {
    leaveIdle();
    const col = Math.floor((t * 1000) / 160) % 6;
    return { row: 8, col, hasBuiltInQuestion: false };
  }

  // Gaze tracking in screen coordinates (Rows 9-10: 16 clockwise sectors, 0°=up/12 o'clock)
  const isCalmPose = mode === 'idle' || mode === 'sit' || mode === 'look' || mode === 'land';
  const gaze = frame.gaze;
  const maxGazeDist = frame.temperament === 'quiet' ? 200 : 360;
  let gazeDx = 0;
  let gazeDy = 0;
  let gazeOk = false;

  if (
    isCalmPose &&
    gaze &&
    gaze.active &&
    gaze.fresh &&
    Number(gaze.dist || 0) >= 28 &&
    Number(gaze.dist || 0) <= maxGazeDist
  ) {
    gazeDx = Number(gaze.dx || 0);
    gazeDy = Number(gaze.dy || 0);
    gazeOk = Math.hypot(gazeDx, gazeDy) > 0;
  } else if (mode === 'look') {
    const look = Array.isArray(frame.look) ? frame.look : [0, 0];
    gazeDx = look[0] * facing;
    gazeDy = look[1];
    gazeOk = Math.hypot(gazeDx, gazeDy) > 1.5;
  }

  if (gazeOk) {
    const deg = ((Math.atan2(gazeDx, -gazeDy) * 180) / Math.PI + 360) % 360;
    let dirIdx = Math.round(deg / 22.5) % 16;
    if (codexState.prevLookIdx !== null) {
      const prevCenter = codexState.prevLookIdx * 22.5;
      let diff = Math.abs(deg - prevCenter) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff <= 19) {
        dirIdx = codexState.prevLookIdx;
      }
    }
    codexState.prevLookIdx = dirIdx;
    codexState.blinkStartAt = -1;
    codexState.wasIdle = true;
    if (dirIdx < 8) {
      return { row: 9, col: dirIdx, hasBuiltInQuestion: false };
    }
    return { row: 10, col: dirIdx - 8, hasBuiltInQuestion: false };
  }

  codexState.prevLookIdx = null;

  if (fname === 'bowing') {
    return { row: 0, col: 2, hasBuiltInQuestion: false };
  }

  // Row 0 idle: calm open-eyed col 0, playing full 6-frame blink cycle once every 3.6-5.0s
  if (!codexState.wasIdle || t < codexState.blinkStartAt || t < codexState.blinkNextAt - 10) {
    codexState.wasIdle = true;
    codexState.blinkStartAt = -1;
    if (codexState.blinkNextAt < t || codexState.blinkNextAt > t + 6) {
      codexState.blinkNextAt = t + 3.6 + Math.random() * 1.4;
    }
  }
  if (codexState.blinkStartAt < 0 && t >= codexState.blinkNextAt) {
    codexState.blinkStartAt = t;
  }
  if (codexState.blinkStartAt >= 0) {
    const elapsedMs = (t - codexState.blinkStartAt) * 1000;
    if (elapsedMs < IDLE_CYCLE_TOTAL_MS) {
      let acc = 0;
      let col = 5;
      for (let i = 0; i < IDLE_DURATIONS_MS.length; i++) {
        acc += IDLE_DURATIONS_MS[i];
        if (elapsedMs < acc) {
          col = i;
          break;
        }
      }
      return { row: 0, col, hasBuiltInQuestion: false };
    }
    codexState.blinkStartAt = -1;
    codexState.blinkNextAt = t + 3.6 + Math.random() * 1.4;
  }

  return { row: 0, col: 0, hasBuiltInQuestion: false };
}

/**
 * Select `(row, col)` for `compact-4x3` atlas.
 * Row 0: [0: idle-open, 1: idle-blink, 2: wave/happy, 3: curious/look]
 * Row 1: 4-frame chase-butterfly running-right
 * Row 2: [0: yarn-work-0, 1: yarn-work-1, 2: curled-sleep-0, 3: curled-sleep-1]
 */
function selectCompact4x3Cell(frame) {
  const mode = frame.mode || 'idle';
  const fname = frame.face || 'neutral';
  const status = String(frame.status || '').toUpperCase();
  const gesture = frame.gesture?.kind || '';
  const t = Number(frame.t || 0);

  if (mode === 'walk' || mode === 'run' || mode === 'air' || mode === 'crouch') {
    const fps = mode === 'run' ? 11 : mode === 'air' ? 9 : 7.5;
    return { row: 1, col: Math.floor(t * fps) % 4 };
  }

  if (mode === 'sleep' || fname === 'sleep' || status === 'WAITING') {
    return { row: 2, col: 2 + (Math.floor(t * 1.6) % 2) };
  }

  if (status === 'CODING' || status === 'RUNNING_CMD' || status === 'WORKING' || mode === 'dance') {
    return { row: 2, col: Math.floor(t * 5.2) % 2 };
  }

  if (
    status === 'READING' ||
    status === 'THINKING' ||
    status === 'WAITING_USER' ||
    status === 'ERROR' ||
    mode === 'look' ||
    mode === 'dizzy' ||
    fname === 'thinking' ||
    fname === 'confused' ||
    fname === 'surprised' ||
    fname === 'worried' ||
    fname === 'scared'
  ) {
    return { row: 0, col: 3 };
  }

  if (
    gesture === 'wave' ||
    fname === 'happy' ||
    fname === 'love' ||
    fname === 'excited' ||
    fname === 'wink'
  ) {
    return { row: 0, col: 2 };
  }

  if ((frame.blink || 0) > 0.35 || (frame.eyeClose || 0) > 0.4 || (frame.drowse || 0) > 0.65 || fname === 'bowing') {
    return { row: 0, col: 1 };
  }

  return { row: 0, col: 0 };
}

const topYCache = new WeakMap();

function scanAtlasTopY(img, fw, fh, cols, rows) {
  if (typeof document === 'undefined' || !img || !img.complete || img.naturalWidth <= 0) {
    return null;
  }
  const key = `${fw}x${fh}|${cols}x${rows}`;
  let bySpec = topYCache.get(img);
  if (bySpec?.has(key)) return bySpec.get(key);

  try {
    const w = Math.min(img.naturalWidth, cols * fw);
    const h = Math.min(img.naturalHeight, rows * fh);
    if (w <= 0 || h <= 0) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const table = new Int16Array(rows * cols);
    table.fill(-1);
    const cellPx = new Int32Array(rows * cols);

    for (let r = 0; r < rows; r++) {
      const yBase = r * fh;
      if (yBase >= h) break;
      const cellH = Math.min(fh, h - yBase);
      for (let col = 0; col < cols; col++) {
        const xBase = col * fw;
        if (xBase >= w) break;
        const cellW = Math.min(fw, w - xBase);
        const segs = [];
        let segStart = -1;
        let segEnd = -1;
        let segPx = 0;
        let gap = 0;
        let totalPx = 0;
        for (let y = 0; y < cellH; y++) {
          const rowOffset = ((yBase + y) * w + xBase) * 4;
          let cnt = 0;
          for (let x = 0; x < cellW; x++) {
            if (data[rowOffset + x * 4 + 3] > 16) cnt++;
          }
          totalPx += cnt;
          if (cnt > 0) {
            if (segStart < 0) {
              segStart = y;
              segEnd = y;
              segPx = cnt;
            } else {
              segEnd = y;
              segPx += cnt;
            }
            gap = 0;
          } else if (segStart >= 0) {
            gap++;
            if (gap >= 4) {
              segs.push({ start: segStart, end: segEnd, px: segPx });
              segStart = -1;
              segEnd = -1;
              segPx = 0;
              gap = 0;
            }
          }
        }
        cellPx[r * cols + col] = totalPx;
        if (segStart >= 0) segs.push({ start: segStart, end: segEnd, px: segPx });
        if (segs.length === 0) continue;

        let chosen = segs[0];
        for (let i = 0; i < segs.length - 1; i++) {
          const s = segs[i];
          const hSpan = s.end - s.start + 1;
          if ((hSpan <= 3 && s.px <= 8) || (hSpan <= 44 && s.px <= 950)) {
            chosen = segs[i + 1];
          } else {
            chosen = s;
            break;
          }
        }
        table[r * cols + col] = chosen.start;
      }
    }
    const minHoldPx = 24;
    table.hasHoldCell = rows > 4 && cols > 5 && table[4 * cols + 5] >= 0 && cellPx[4 * cols + 5] >= minHoldPx;
    table.hasHoldSwayLeft = rows > 4 && cols > 6 && table[4 * cols + 6] >= 0 && cellPx[4 * cols + 6] >= minHoldPx;
    table.hasHoldSwayRight = rows > 4 && cols > 7 && table[4 * cols + 7] >= 0 && cellPx[4 * cols + 7] >= minHoldPx;
    if (!bySpec) {
      bySpec = new Map();
      topYCache.set(img, bySpec);
    }
    bySpec.set(key, table);
    return table;
  } catch {
    return null;
  }
}

export function computeTargetBubbleY(layout, cell, topY = null) {
  if (!cell) return 62;
  if (typeof topY === 'number' && Number.isFinite(topY) && topY >= 0) {
    const baseDy = layout === 'compact-4x3' ? 56 : 52;
    return clamp(baseDy + topY - 4, 42, 136);
  }
  if (layout === 'codex-v2-8x11') {
    if (cell.row === 1 || cell.row === 2) return 92;
    if (cell.row === 7) return 76;
    return 62;
  }
  if (layout === 'compact-4x3') {
    if (cell.row === 1) return 92;
    if (cell.row === 2) return cell.col >= 2 ? 114 : 76;
    return 62;
  }
  return 62;
}

export async function createSpriteFigure(opts = {}) {
  const base = opts.base || '';
  const load = opts.loadImage || loadImageDefault;
  let pack = opts.pack || { id: 'sprite', defaultVariant: '', variants: [] };
  let variant = pickVariant(pack, opts.scheme);
  let variantId = variant?.id || '';
  let currentImg = null;
  let loadGen = 0;

  async function ensureVariantLoaded(targetVar) {
    if (!targetVar) return null;
    const gen = ++loadGen;
    const url = resolveAssetUrl(targetVar.assetUrl || targetVar.asset, base);
    if (!url) return null;
    if (targetVar.layout === 'single-image') {
      return { url, layout: 'single-image', img: null, gen };
    }
    const img = await load(url);
    return { url, layout: targetVar.layout, img, gen };
  }

  if (variant) {
    try {
      const res = await ensureVariantLoaded(variant);
      if (res?.img) currentImg = res.img;
    } catch (err) {
      console.warn('[sprite-pack] Initial image failed to load:', err);
    }
  }

  const CW = 512;
  const CH = 512;
  const RIG_SCALE = 2; // 256 rig units -> 512 canvas pixels

  let mountedIn = null;
  let mountedMode = ''; // 'canvas' | 'single-image'
  let fo = null;
  let canvas = null;
  let ctx = null;
  let imgEl = null;
  let fxG = null;
  let lastPaintKey = '';
  let lastImgHref = '';
  let lastFx = '';
  let lastFacingSign = 1;
  let bubbleY = 62;
  let targetBubbleY = 62;
  let lastBubbleFrameT = null;
  const codexState = {
    blinkNextAt: 3.6 + Math.random() * 1.4,
    blinkStartAt: -1,
    prevLookIdx: null,
    wasIdle: false,
    hasHoldCell: false,
    hasHoldSwayLeft: false,
    hasHoldSwayRight: false,
  };
  function resetCodexState() {
    codexState.blinkNextAt = 3.6 + Math.random() * 1.4;
    codexState.blinkStartAt = -1;
    codexState.prevLookIdx = null;
    codexState.wasIdle = false;
  }
  function updateBubbleY(nextTarget, hasT, t) {
    targetBubbleY = nextTarget;
    if (lastBubbleFrameT === null || (hasT && t < lastBubbleFrameT)) {
      bubbleY = targetBubbleY;
      lastBubbleFrameT = hasT ? t : 0;
      return;
    }
    const dt = hasT ? t - lastBubbleFrameT : 0.04;
    if (hasT) lastBubbleFrameT = t;
    if (dt <= 0) return;
    const stepDt = clamp(dt, 0.016, 0.25);
    const alpha = clamp(1 - Math.exp(-16 * stepDt), 0.14, 0.52);
    bubbleY += (targetBubbleY - bubbleY) * alpha;
    if (Math.abs(targetBubbleY - bubbleY) < 0.2) {
      bubbleY = targetBubbleY;
    }
  }

  function mount(petG, layout) {
    petG.textContent = '';
    const isSingle = layout === 'single-image';
    if (isSingle) {
      imgEl = document.createElementNS(SVGNS, 'image');
      imgEl.setAttribute('x', '16');
      imgEl.setAttribute('y', '20');
      imgEl.setAttribute('width', '224');
      imgEl.setAttribute('height', '232');
      imgEl.setAttribute('preserveAspectRatio', 'xMidYMax meet');
      fo = imgEl;
      canvas = null;
      ctx = null;
      mountedMode = 'single-image';
    } else {
      fo = document.createElementNS(SVGNS, 'foreignObject');
      fo.setAttribute('x', '0');
      fo.setAttribute('y', '0');
      fo.setAttribute('width', '256');
      fo.setAttribute('height', '256');
      canvas = document.createElementNS(XHTML_NS, 'canvas');
      canvas.width = CW;
      canvas.height = CH;
      canvas.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
      fo.appendChild(canvas);
      ctx = canvas.getContext('2d');
      imgEl = null;
      mountedMode = 'canvas';
    }
    fxG = document.createElementNS(SVGNS, 'g');
    petG.append(fo, fxG);
    mountedIn = petG;
    lastPaintKey = '';
    lastImgHref = '';
    lastBubbleFrameT = null;
    resetCodexState();
    lastFx = '';
  }

  function drawFx(fc, frame, skipQuestion = false) {
    if (!fxG) return;
    let s = '';
    const t = Number(frame.t || 0);
    const ac = variant?.color || '#F59E0B';
    const facing = (frame.facing ?? 1) >= 0 ? 1 : -1;

    if (fc.orbit) {
      for (let i = 0; i < 3; i++) {
        const a = t * 3.2 + i * 2.094;
        const sn = Math.sin(a);
        s += `<path fill="#ffd23f" stroke="#3a2f7a" stroke-width="1.6" stroke-linejoin="round" opacity="${sn < 0 ? 0.55 : 1}" transform="translate(${f1(128 + 48 * Math.cos(a))} ${f1(42 + 8 * sn)}) scale(${sn < 0 ? 0.7 : 1})" d="M0 -7L2 -2L7 -2L3 1L4.5 6.5L0 3.3L-4.5 6.5L-3 1L-7 -2L-2 -2Z"/>`;
      }
    }
    if (fc.listen) {
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.9 + i / 3) % 1;
        const r = 34 - 22 * p;
        s += `<path fill="none" stroke="${ac}" stroke-width="4.5" stroke-linecap="round" opacity="${f1(Math.sin(Math.PI * p))}" d="M${f1(194 + r * Math.cos(-0.55))} ${f1(110 + r * Math.sin(-0.55))}A${f1(r)} ${f1(r)} 0 0 1 ${f1(194 + r * Math.cos(0.55))} ${f1(110 + r * Math.sin(0.55))}"/>`;
      }
    }
    if (fc.sweat) {
      const cy = 82 + 3 * Math.sin(t * 7);
      s += `<path fill="#8fd0ff" stroke="#2f5fae" stroke-width="1.4" transform="translate(178 ${f1(cy)}) scale(1.3)" d="M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z"/>`;
    }
    if (fc.anger) {
      const k = 1 + 0.12 * Math.sin(t * 10);
      s += `<g transform="translate(176 58) scale(${f1(k)})" fill="none" stroke="#e5484d" stroke-width="4.5" stroke-linecap="round"><path d="M-10 -3Q-3 -3 -3 -10M3 -10Q3 -3 10 -3M10 3Q3 3 3 10M-3 10Q-3 3 -10 3"/></g>`;
    }
    if (fc.bang) {
      s += `<g transform="translate(184 34)"><path fill="none" stroke="#252049" stroke-width="7" stroke-linecap="round" d="M0 -14V2"/><circle fill="#252049" cx="0" cy="12" r="4"/></g>`;
    }
    if (fc.question && !skipQuestion) {
      const k = 1 + 0.06 * Math.sin(t * 3);
      const flip = facing < 0 ? ' scale(-1 1)' : '';
      s += `<g transform="translate(184 34)${flip} scale(${f1(k)})"><path fill="none" stroke="#252049" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" d="M-7 -8Q-7 -17 0 -17Q8 -17 8 -10Q8 -4 0 -1V3"/><circle fill="#252049" cx="0" cy="12" r="4"/></g>`;
    }

    if (s !== lastFx) {
      fxG.innerHTML = s;
      lastFx = s;
    }
  }

  function draw(petG, fc, frame = {}) {
    if (!variant) return;
    const layout = variant.layout || 'compact-4x3';
    const wantMode = layout === 'single-image' ? 'single-image' : 'canvas';
    if (mountedIn !== petG || mountedMode !== wantMode || !petG.contains(fo)) {
      mount(petG, layout);
    }

    const facing = (frame.facing ?? 1) >= 0 ? 1 : -1;
    lastFacingSign = facing;
    const hasFrameT = typeof frame.t === 'number' && Number.isFinite(frame.t);
    const frameT = hasFrameT ? frame.t : 0;

    if (layout === 'single-image') {
      updateBubbleY(62, hasFrameT, frameT);
      const href = resolveAssetUrl(variant.assetUrl || variant.asset, base);
      if (href && href !== lastImgHref) {
        imgEl.setAttribute('href', href);
        lastImgHref = href;
      }
      if (variant.asymmetric && facing < 0) {
        imgEl.setAttribute('transform', 'translate(256 0) scale(-1 1)');
      } else if (imgEl.hasAttribute('transform')) {
        imgEl.removeAttribute('transform');
      }
      drawFx(fc, frame, false);
      return;
    }

    const fw = variant.frameWidth || 192;
    const fh = variant.frameHeight || 208;
    const cols = variant.cols || (layout === 'codex-v2-8x11' ? 8 : 4);
    const rows = variant.rows || (layout === 'codex-v2-8x11' ? 11 : 3);
    const topYTable =
      currentImg && currentImg.complete && currentImg.naturalWidth > 0
        ? scanAtlasTopY(currentImg, fw, fh, cols, rows)
        : null;

    let cell;
    let shouldCounterFlip = false;
    if (layout === 'codex-v2-8x11') {
      codexState.hasHoldCell = Boolean(topYTable?.hasHoldCell);
      codexState.hasHoldSwayLeft = Boolean(topYTable?.hasHoldSwayLeft);
      codexState.hasHoldSwayRight = Boolean(topYTable?.hasHoldSwayRight);
      cell = selectCodex8x11Cell(frame, fc, codexState);
      // Cancel body.js's negative scaleX on petG so asymmetric spots (e.g. 22) never flip,
      // and row 1 (right) vs row 2 (left) + 16 look directions orient natively in screen space.
      shouldCounterFlip = facing < 0;
    } else {
      cell = selectCompact4x3Cell(frame);
      // Symmetric compact-4x3 lets body.js's pet.faceVis flip naturally; only counter-flip if marked asymmetric.
      shouldCounterFlip = Boolean(variant.asymmetric) && facing < 0;
    }
    const col = clamp(cell.col, 0, cols - 1);
    const row = clamp(cell.row, 0, rows - 1);
    const cellTopY = topYTable ? topYTable[row * cols + col] : -1;
    updateBubbleY(computeTargetBubbleY(layout, cell, cellTopY), hasFrameT, frameT);

    if (!currentImg || !currentImg.complete || currentImg.naturalWidth === 0 || !ctx) {
      drawFx(fc, frame, false);
      return;
    }

    const paintKey = `${currentImg.src}|${row}|${col}|${shouldCounterFlip ? 1 : 0}`;

    if (paintKey !== lastPaintKey) {
      lastPaintKey = paintKey;
      const sx = col * fw;
      const sy = row * fh;
      const fitScale = 1.0;
      const dw = fw * fitScale;
      const dh = fh * fitScale;
      const dx = (256 - dw) / 2;
      const baseCellY = layout === 'compact-4x3' ? 196 : 200;
      const dy = 252 - baseCellY * fitScale;

      ctx.clearRect(0, 0, CW, CH);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (shouldCounterFlip) {
        ctx.translate(CW, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(
        currentImg,
        sx,
        sy,
        fw,
        fh,
        dx * RIG_SCALE,
        dy * RIG_SCALE,
        dw * RIG_SCALE,
        dh * RIG_SCALE
      );
      ctx.restore();
    }

    drawFx(fc, frame, Boolean(cell.hasBuiltInQuestion));
  }

  async function setScheme(nextVariantId) {
    const targetVar = pickVariant(pack, nextVariantId);
    if (!targetVar) return;
    const prevLayout = variant?.layout;
    variant = targetVar;
    variantId = targetVar.id;
    lastPaintKey = '';
    lastImgHref = '';
    lastBubbleFrameT = null;
    resetCodexState();
    try {
      const res = await ensureVariantLoaded(targetVar);
      if (res && res.gen === loadGen) {
        if (res.img) currentImg = res.img;
        if (prevLayout !== targetVar.layout) {
          mountedMode = '';
        }
        lastPaintKey = '';
      }
    } catch (err) {
      console.warn('[sprite-pack] Failed to switch variant:', targetVar.id, err);
    }
  }

  async function setPack(nextPack, nextVariantId) {
    if (nextPack) pack = nextPack;
    // Clear cache for updated pack assets so reloads pick up disk changes
    for (const v of pack?.variants || []) {
      const u = resolveAssetUrl(v.assetUrl || v.asset, base);
      if (u) imageCache.delete(u);
    }
    await setScheme(nextVariantId || variantId);
  }

  return {
    draw,
    setScheme,
    setPack,
    dispose() {
      loadGen++;
      mountedIn = null;
      mountedMode = '';
      fo = null;
      canvas = null;
      ctx = null;
      imgEl = null;
      fxG = null;
      lastPaintKey = '';
      lastImgHref = '';
      lastFx = '';
    },
    reset() {
      lastPaintKey = '';
      lastImgHref = '';
      lastFx = '';
      bubbleY = 62;
      targetBubbleY = 62;
      lastBubbleFrameT = null;
      resetCodexState();
    },
    get scheme() {
      return variantId;
    },
    get packId() {
      return pack?.id || '';
    },
    get colors() {
      return { z: variant?.color || '#F59E0B' };
    },
    getBubbleAnchor() {
      return [128, f1(bubbleY)];
    },
    anchors: {
      gaze: [128, 108],
      tear: [148, 128],
      z: [182, 34],
      hearts: [88, 168, 32],
      bubble: [128, 62],
    },
    extent: [28, 60, 228, 254],
    hits: [[128, 136, 106]],
  };
}
