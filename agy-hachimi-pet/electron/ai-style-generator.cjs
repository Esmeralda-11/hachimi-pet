const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const THREE_VIEW_SCRIPT_PATH = path.join(__dirname, 'three-view-builder.py');

let cachedPyPilBin = null;

function resolvePythonPilBinary(explicitBin = '') {
  if (explicitBin && typeof explicitBin === 'string') return explicitBin;
  if (cachedPyPilBin !== null) return cachedPyPilBin;
  const candidates = [
    process.env.HACHIMI_PYTHON,
    '/opt/anaconda3/bin/python3',
    'python3',
    'python',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['-c', 'import PIL.Image, numpy, scipy; print("ok")'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      });
      if (res.status === 0 && (res.stdout || '').trim() === 'ok') {
        cachedPyPilBin = bin;
        return cachedPyPilBin;
      }
    } catch { /* try next */ }
  }
  cachedPyPilBin = '';
  return '';
}

function makeHumanAiError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.isHumanError = true;
  return err;
}

const makeHumanError = makeHumanAiError;

function parseAgyFailureMessage(code, stdout = '', stderr = '') {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (/maxitems|imagepaths|invalid arguments/.test(combined)) {
    return makeHumanAiError('MODEL_INVALID_ARGS', '发送给模型的参考图参数超出限制，请减少参考图数量或关闭「模型协助生成」直接导入。');
  }
  if (/quota|rate limit|too many requests|resource exhausted|429|capacity/.test(combined)) {
    return makeHumanAiError('MODEL_QUOTA', '模型调用额度暂满或请求过于频繁，请稍后再试或关闭「模型协助生成」直接导入。');
  }
  if (/unauthorized|unauthenticated|not logged in|auth.*expired|forbidden/.test(combined)) {
    return makeHumanAiError('MODEL_AUTH', '本机 Antigravity 模型尚未登录或授权已过期，请先完成登录后重试。');
  }
  if (/timeout|timed out|etimedout/.test(combined)) {
    return makeHumanAiError('TIMEOUT', '模型绘制超时了，请稍后再试或减少参考图数量。');
  }
  if (code !== null && code !== undefined && code !== 0) {
    return makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效图像，请稍后再试或关闭「模型协助生成」直接导入。');
  }
  return null;
}

function resolveAgyBinary() {
  if (process.platform === 'win32') {
    return 'agy.exe';
  }
  const candidates = [
    process.env.AGY_BIN,
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    'agy',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (bin.includes('/') && !fs.existsSync(bin)) continue;
      const res = spawnSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0) return bin;
    } catch { /* try next */ }
  }
  return '';
}

function exportVariantStyleAnchorPng(pyBin, atlasPath, thumbPath, outStylePng) {
  const srcPath = (atlasPath && fs.existsSync(atlasPath)) ? atlasPath : thumbPath;
  if (!srcPath || !fs.existsSync(srcPath)) return false;
  if (!pyBin) {
    fs.copyFileSync(srcPath, outStylePng);
    return true;
  }
  const script = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
w, h = im.size
if w >= 768 and h >= 600:
    cw = 192 if w % 192 == 0 else w // 8
    ch = 208 if h % 208 == 0 else h // 11
    cell = im.crop((0, 0, cw, ch))
elif w >= 512 and h >= 512 and (w % 4 == 0 and h % 3 == 0):
    cell = im.crop((0, 0, w // 4, h // 3))
else:
    cell = im
tw, th = max(256, cell.width * 2), max(256, cell.height * 2)
bg = Image.new("RGBA", (tw, th), (0, 255, 0, 255))
bg.alpha_composite(cell.resize((tw, th), Image.Resampling.LANCZOS))
bg.convert("RGB").save(dst, "PNG")
print("ok")
`;
  const res = spawnSync(pyBin, ['-c', script, srcPath, outStylePng], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (res.status === 0 && fs.existsSync(outStylePng)) return true;
  fs.copyFileSync(srcPath, outStylePng);
  return true;
}

function extractImagePathsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text
    .replace(/\\+\//g, '/')
    .replace(/\\([nrt])/g, ' ')
    .replace(/\\"/g, '"');
  const matches = [];
  const re = /(\/(?:Users|Volumes|var|tmp|private)[^\s"'`<>()[\]{}\\]+\.(?:png|jpg|jpeg|webp))/gi;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const p = m[1].replace(/[.,;:!?]+$/, '');
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      matches.push(p);
    }
  }
  return matches;
}

function parseStreamJsonSummary(stdout = '') {
  let conversationId = '';
  const deltas = [];
  const resultTexts = [];

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;
    try {
      const obj = JSON.parse(line);
      if (!conversationId) {
        conversationId = String(obj.conversation_id || obj.conversationId || '').trim();
      }
      if (obj.event === 'step_update' && obj.step_update) {
        if (!conversationId) {
          conversationId = String(obj.step_update.conversation_id || obj.step_update.conversationId || '').trim();
        }
        if (typeof obj.step_update.text_delta === 'string') {
          deltas.push(obj.step_update.text_delta);
        }
      } else if (obj.event === 'result' && obj.result) {
        if (!conversationId) {
          conversationId = String(obj.result.conversation_id || obj.result.conversationId || '').trim();
        }
        if (typeof obj.result.response === 'string') {
          resultTexts.push(obj.result.response);
        }
      }
    } catch { /* ignore non-JSON or partial line */ }
  }

  if (!conversationId) {
    const m = String(stdout || '').match(/"(?:conversation_id|conversationId)"\s*:\s*"([a-zA-Z0-9_-]{8,})"/);
    if (m) conversationId = m[1];
  }

  return {
    conversationId,
    assembledText: [deltas.join(''), ...resultTexts].filter(Boolean).join('\n'),
  };
}

function findGeneratedBrainImage(conversationId, minTimeMs = 0) {
  if (!conversationId || typeof conversationId !== 'string') return '';
  const cleanCid = conversationId.trim();
  if (!/^[a-zA-Z0-9_-]{8,}$/.test(cleanCid)) return '';

  const home = os.homedir();
  const roots = [
    path.join(home, '.gemini', 'antigravity-cli', 'brain', cleanCid),
    path.join(home, '.gemini', 'antigravity', 'brain', cleanCid),
  ];
  const validExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const cutoffMs = Number.isFinite(minTimeMs) && minTimeMs > 0 ? minTimeMs - 2000 : 0;
  let best = null;

  function walk(dirPath, depth = 0) {
    if (depth > 3 || !fs.existsSync(dirPath)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.system_generated' || name === '.user_uploaded' || name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (!validExts.has(ext)) continue;
        try {
          const st = fs.statSync(fullPath);
          if (st.size <= 0) continue;
          if (cutoffMs && st.mtimeMs < cutoffMs) continue;
          if (!best || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && st.size > best.size)) {
            best = { path: fullPath, mtimeMs: st.mtimeMs, size: st.size };
          }
        } catch { /* ignore unreadable file */ }
      }
    }
  }

  for (const root of roots) {
    walk(root, 0);
  }
  return best ? best.path : '';
}

function resolveGeneratedImagePath({
  expectedOut = '',
  stdout = '',
  stderr = '',
  assembledText = '',
  conversationId = '',
  startTimeMs = 0,
  ignoredPaths = [],
}) {
  if (expectedOut && fs.existsSync(expectedOut) && fs.statSync(expectedOut).isFile()) {
    return expectedOut;
  }

  const ignoredSet = new Set(ignoredPaths.filter(Boolean).map((p) => path.resolve(p)));
  const candidates = [
    ...extractImagePathsFromText(assembledText),
    ...extractImagePathsFromText(stdout),
    ...extractImagePathsFromText(stderr),
  ].filter((p) => {
    const resolved = path.resolve(p);
    if (ignoredSet.has(resolved)) return false;
    if (
      resolved.includes(`${path.sep}.system_generated${path.sep}`) ||
      resolved.includes(`${path.sep}.user_uploaded${path.sep}`)
    ) {
      return false;
    }
    return true;
  });

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  return findGeneratedBrainImage(conversationId, startTimeMs);
}

function runAgyPromptAsync({ agyBin, stageDir, prompt, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--effort',
      'low',
      '--disable-slash-commands',
      '--add-dir',
      stageDir,
      '-p',
      prompt,
    ];

    const env = {
      ...process.env,
      HACHIMI_INTERNAL_AI_GEN: '1',
      PATH: `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:${process.env.PATH || ''}`,
    };

    const child = spawn(agyBin, args, {
      cwd: stageDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    let stdoutAll = '';
    let stderrAll = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      const { conversationId, assembledText } = parseStreamJsonSummary(stdoutAll);
      resolve({
        code: null,
        stdout: stdoutAll,
        stderr: stderrAll,
        conversationId,
        assembledText,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutAll += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderrAll += chunk.toString('utf8');
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(makeHumanAiError('MODEL_UNAVAILABLE', '未能启动本机 Antigravity 模型命令（agy），暂时无法使用模型协助生成。'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { conversationId, assembledText } = parseStreamJsonSummary(stdoutAll);
      resolve({
        code,
        stdout: stdoutAll,
        stderr: stderrAll,
        conversationId,
        assembledText,
        timedOut: false,
      });
    });
  });
}

/**
 * Merge 1..16 uploaded subject images + role labels into ONE crisp non-overlapping reference sheet PNG,
 * guaranteeing `ImagePaths` stays <= 2 when passed to `image-generator`.
 */
function buildSubjectReferenceSheet(pyBin, subjectFiles, outSheetPath) {
  const resolvedPy = resolvePythonPilBinary(pyBin);
  if (!resolvedPy) {
    throw makeHumanError('PYTHON_MISSING', '本机图像处理组件暂未就绪，暂时无法拼合参考图，请改用本地直接导入。');
  }
  if (!Array.isArray(subjectFiles) || subjectFiles.length === 0) {
    throw makeHumanError('MISSING_INPUT', '请先上传至少一张角色图片，再开始生成。');
  }

  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-subj-raw-'));
  try {
    const manifest = subjectFiles.slice(0, 16).map((f, idx) => {
      const ext = f.ext || '.png';
      const p = path.join(rawDir, `raw_${idx}${ext}`);
      fs.writeFileSync(p, f.buffer);
      return {
        path: p,
        name: String(f.name || `图片 ${idx + 1}`),
        roleHint: String(f.roleHint || '').trim().toLowerCase(),
      };
    });

    const manifestPath = path.join(rawDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const pyScript = `
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageOps

manifest_path, out_path = sys.argv[1], sys.argv[2]
items = json.loads(open(manifest_path, "r", encoding="utf-8").read())
n = len(items)
if n == 0:
    raise RuntimeError("empty subject list")

ROLE_TEXT = {
    "front": "FRONT 正面",
    "left_side": "LEFT_SIDE 左侧面",
    "right_side": "RIGHT_SIDE 右侧面",
    "back": "BACK 背面",
    "top": "TOP 顶面",
    "face_closeup": "FACE_CLOSEUP 脸部特写",
    "action": "ACTION 动作姿态",
    "side": "SIDE 侧面",
    "extra": "ACTION 动作姿态",
}

ROLE_ASCII = {
    "front": "FRONT",
    "left_side": "LEFT_SIDE",
    "right_side": "RIGHT_SIDE",
    "back": "BACK",
    "top": "TOP",
    "face_closeup": "FACE_CLOSEUP",
    "action": "ACTION",
    "side": "SIDE",
    "extra": "ACTION",
}

def load_font(sz):
    for fp in (
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, sz), ("Arial" in fp or "Hiragino" in fp or "STHeiti" in fp)
            except Exception:
                pass
    return ImageFont.load_default(), False

if n == 1:
    cols, rows = 1, 1
    card_w, card_h = 720, 720
elif n == 2:
    cols, rows = 2, 1
    card_w, card_h = 560, 560
elif n <= 4:
    cols, rows = 2, 2
    card_w, card_h = 520, 520
elif n <= 6:
    cols, rows = 3, 2
    card_w, card_h = 440, 440
elif n <= 9:
    cols, rows = 3, 3
    card_w, card_h = 400, 400
elif n <= 12:
    cols, rows = 4, 3
    card_w, card_h = 360, 360
else:
    cols, rows = 4, 4
    card_w, card_h = 340, 340

margin = 24
gap = 18
header_h = 44
canvas_w = margin * 2 + cols * card_w + (cols - 1) * gap
canvas_h = margin * 2 + rows * card_h + (rows - 1) * gap

sheet = Image.new("RGB", (canvas_w, canvas_h), (244, 245, 247))
draw = ImageDraw.Draw(sheet)
font, has_cjk = load_font(20 if card_w >= 440 else 17)

for idx, it in enumerate(items):
    r = idx // cols
    c = idx % cols
    x0 = margin + c * (card_w + gap)
    y0 = margin + r * (card_h + gap)
    x1 = x0 + card_w
    y1 = y0 + card_h

    draw.rounded_rectangle([x0, y0, x1, y1], radius=14, fill=(255, 255, 255), outline=(210, 214, 222), width=2)
    draw.rounded_rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + header_h], radius=10, fill=(235, 239, 245))

    role = it.get("roleHint", "")
    if has_cjk:
        lbl = f"#{idx + 1} {ROLE_TEXT.get(role, '参考图')}"
    else:
        lbl = f"#{idx + 1} {ROLE_ASCII.get(role, 'REF')}"
    draw.text((x0 + 16, y0 + 15), lbl, fill=(17, 24, 39), font=font)

    with Image.open(it["path"]) as raw_im:
        raw_im.load()
        try:
            im = ImageOps.exif_transpose(raw_im)
        except Exception:
            im = raw_im
        rgba = im.convert("RGBA")
        card_bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        comp = Image.alpha_composite(card_bg, rgba).convert("RGB")

    pad_x = 14
    pad_y = 12
    avail_w = card_w - pad_x * 2
    avail_h = card_h - header_h - pad_y * 2
    scale = min(avail_w / max(1, comp.width), avail_h / max(1, comp.height))
    nw = max(1, round(comp.width * scale))
    nh = max(1, round(comp.height * scale))
    resized = comp.resize((nw, nh), Image.Resampling.LANCZOS)
    px = x0 + pad_x + (avail_w - nw) // 2
    py = y0 + header_h + pad_y + (avail_h - nh) // 2
    sheet.paste(resized, (px, py))

sheet.save(out_path, "PNG")
print("OK")
`;

    const res = spawnSync(resolvedPy, ['-c', pyScript, manifestPath, outSheetPath], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    if (res.status !== 0 || !fs.existsSync(outSheetPath)) {
      console.error('[ai-style-generator] buildSubjectReferenceSheet failed:', res.stderr || res.stdout);
      throw makeHumanError('INTERNAL_ERROR', '拼合参考图时遇到一点问题，请换一张图片或关闭「模型协助生成」直接导入。');
    }
    return outSheetPath;
  } finally {
    try { fs.rmSync(rawDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Deterministically split generated 2x2 (or 1xN fallback) #00FF00 turnaround sheet
 * into clean isolated single-character RGBA PNG buffers, guaranteeing ZERO stacked views.
 */
function splitStylizedSheetToSingles(pyBin, sheetPath) {
  const resolvedPy = resolvePythonPilBinary(pyBin);
  if (!resolvedPy || !fs.existsSync(THREE_VIEW_SCRIPT_PATH)) {
    return [
      {
        name: 'stylized_view_1' + (path.extname(sheetPath).toLowerCase() || '.png'),
        buffer: fs.readFileSync(sheetPath),
        roleHint: '',
      },
    ];
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-quad-split-'));
  try {
    const pyScript = `
import importlib.util, json, os, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

tvb_path, sheet_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location("tvb", tvb_path)
tvb = importlib.util.module_from_spec(spec)
sys.modules["tvb"] = tvb
spec.loader.exec_module(tvb)

with Image.open(sheet_path) as im:
    im.load()
    rgba = im.convert("RGBA")

keyed = tvb.adaptive_remove_background(rgba, orig_path=Path(sheet_path), allow_multiple=True)
keyed = tvb.filter_isolated_noise(keyed)
if not tvb._has_visible_foreground(keyed, min_pixels=64):
    raise RuntimeError("empty generated sheet")

arr = np.array(keyed, dtype=np.uint8)
h, w = arr.shape[:2]

def strip_grid_divider_bars(buf):
    bh, bw = buf.shape[:2]
    fg_m = buf[:, :, 3] > 16
    max_bar_h = max(28, int(bh * 0.06))
    max_bar_w = max(28, int(bw * 0.06))

    def wipe_strips(cov, limit, axis, lo_idx, hi_idx):
        hits = np.where((cov >= 0.65) & (np.arange(len(cov)) >= lo_idx) & (np.arange(len(cov)) <= hi_idx))[0]
        if len(hits) == 0:
            return
        # Group consecutive rows/cols (allowing 2px tiny gaps)
        groups = []
        gs = ge = int(hits[0])
        for idx in hits[1:]:
            idx = int(idx)
            if idx <= ge + 2:
                ge = idx
            else:
                groups.append((gs, ge))
                gs = ge = idx
        groups.append((gs, ge))
        for s0, s1 in groups:
            if (s1 - s0 + 1) <= limit:
                p0 = max(0, s0 - 3)
                p1 = min(len(cov), s1 + 4)
                if axis == 0:
                    buf[p0:p1, :, :] = 0
                else:
                    buf[:, p0:p1, :] = 0

    row_cov = fg_m.mean(axis=1)
    col_cov = fg_m.mean(axis=0)
    # Central cross divider zone (35%..65%)
    wipe_strips(row_cov, max_bar_h, 0, int(bh * 0.35), int(bh * 0.65))
    wipe_strips(col_cov, max_bar_w, 1, int(bw * 0.35), int(bw * 0.65))
    # Outer edge border frame bars (within outer 3%)
    edge_h = max(16, int(bh * 0.03))
    edge_w = max(16, int(bw * 0.03))
    wipe_strips(row_cov, edge_h, 0, 0, edge_h)
    wipe_strips(row_cov, edge_h, 0, bh - 1 - edge_h, bh - 1)
    wipe_strips(col_cov, edge_w, 1, 0, edge_w)
    wipe_strips(col_cov, edge_w, 1, bw - 1 - edge_w, bw - 1)

strip_grid_divider_bars(arr)
keyed = tvb.filter_isolated_noise(Image.fromarray(arr, "RGBA"))
arr = np.array(keyed, dtype=np.uint8)
fg = arr[:, :, 3] > 16

def prune_thin_bar_components(sp):
    sp_arr = np.array(sp, dtype=np.uint8)
    mask = sp_arr[:, :, 3] > 16
    labeled, num = ndi.label(mask, structure=np.ones((3, 3), dtype=int))
    if num <= 1:
        return sp
    sizes = np.bincount(labeled.ravel())[1:]
    main_area = int(sizes.max())
    if main_area <= 0:
        return sp
    slices = ndi.find_objects(labeled)
    for comp_id, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        area = int(sizes[comp_id - 1])
        if area == main_area:
            continue
        ch = sl[0].stop - sl[0].start
        cw = sl[1].stop - sl[1].start
        min_d = max(1, min(ch, cw))
        max_d = max(ch, cw)
        if min_d <= 26 and max_d >= min_d * 4.5 and area < main_area * 0.35:
            sp_arr[labeled == comp_id] = 0
    return Image.fromarray(sp_arr, "RGBA")

def pad_single(sp):
    sp = prune_thin_bar_components(tvb.filter_isolated_noise(sp))
    sp = tvb._crop_tight(tvb.filter_isolated_noise(sp))
    pad = max(16, round(max(sp.width, sp.height) * 0.08))
    canvas = Image.new("RGBA", (sp.width + pad * 2, sp.height + pad * 2), (0, 0, 0, 0))
    canvas.alpha_composite(sp, (pad, pad))
    return canvas

def split_cell_isolated(cell_img):
    pieces = tvb._split_combined_views(cell_img)
    valid = [p for p in pieces if p.width >= 20 and p.height >= 20 and tvb._has_visible_foreground(p, min_pixels=60)]
    return valid if valid else ([cell_img] if tvb._has_visible_foreground(cell_img, min_pixels=60) else [])

# Try deterministic 2x2 quadrant split first (locating cleanest central valleys in 32%..68%)
row_mass = fg.sum(axis=1)
ry0, ry1 = int(h * 0.32), int(h * 0.68)
gy = ry0 + int(np.argmin(row_mass[ry0:ry1])) if ry1 > ry0 else h // 2
top_band = keyed.crop((0, 0, w, gy))
bot_band = keyed.crop((0, gy, w, h))

top_fg = np.array(top_band)[:, :, 3] > 16
bot_fg = np.array(bot_band)[:, :, 3] > 16

quad_cells = []
if np.any(top_fg) and np.any(bot_fg) and float(row_mass[gy]) <= max(8.0, w * 0.04):
    def split_lr(band_im):
        ba = np.array(band_im)[:, :, 3] > 16
        bh_b, bw_b = ba.shape
        col_m = ba.sum(axis=0)
        cx0, cx1 = int(bw_b * 0.30), int(bw_b * 0.70)
        gx = cx0 + int(np.argmin(col_m[cx0:cx1])) if cx1 > cx0 else bw_b // 2
        left_raw = band_im.crop((0, 0, gx, bh_b))
        right_raw = band_im.crop((gx, 0, bw_b, bh_b))
        # Also verify via _split_combined_views if valley wasn't fully 0
        if float(col_m[gx]) > max(6.0, bh_b * 0.04):
            sv = tvb._split_combined_views(band_im)
            if len(sv) == 2:
                return sv[0], sv[1]
        return left_raw, right_raw

    tl_raw, tr_raw = split_lr(top_band)
    bl_raw, br_raw = split_lr(bot_band)
    quad_specs = [
        (tl_raw, "quad_tl"),
        (tr_raw, "quad_tr"),
        (bl_raw, "quad_bl"),
        (br_raw, "quad_br"),
    ]
    extracted_quads = []
    for raw_q, tag in quad_specs:
        if not tvb._has_visible_foreground(raw_q, min_pixels=80):
            continue
        subs = split_cell_isolated(raw_q)
        for s_idx, sub_sp in enumerate(subs):
            hint = ""
            if len(subs) == 1:
                if tag == "quad_tl":
                    hint = "front"
                elif tag == "quad_tr":
                    hint = "right_side" if tvb.detect_side_faces_right(sub_sp) else "left_side"
                elif tag == "quad_bl":
                    feat_bl = tvb._extract_pose_features(sub_sp)
                    hint = "back" if feat_bl.facial_contrast < 0.25 else "action"
                elif tag == "quad_br":
                    hint = "action"
            extracted_quads.append((sub_sp, hint))
    if len(extracted_quads) >= 2:
        quad_cells = extracted_quads

if not quad_cells:
    # Fallback 1xN turnaround splitting via reinforced _split_combined_views
    figs = tvb._split_combined_views(keyed)
    for fig in figs:
        if tvb._has_visible_foreground(fig, min_pixels=60):
            quad_cells.append((fig, ""))

results = []
for idx, (sp, hint) in enumerate(quad_cells):
    padded = pad_single(sp)
    out_p = os.path.join(out_dir, f"view_{idx}.png")
    padded.save(out_p, "PNG")
    results.append({"path": out_p, "name": f"stylized_view_{idx + 1}.png", "roleHint": hint})

print(json.dumps({"ok": True, "files": results}, ensure_ascii=False))
`;

    const res = spawnSync(resolvedPy, ['-c', pyScript, THREE_VIEW_SCRIPT_PATH, sheetPath, outDir], {
      encoding: 'utf8',
      timeout: 35000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const lastLine = String(res.stdout).trim().split('\n').pop();
      const parsed = JSON.parse(lastLine);
      if (parsed && parsed.ok && Array.isArray(parsed.files) && parsed.files.length > 0) {
        return parsed.files.map((item) => ({
          name: item.name,
          buffer: fs.readFileSync(item.path),
          roleHint: item.roleHint || '',
        }));
      }
    }
  } catch (err) {
    console.error('[ai-style-generator] splitStylizedSheetToSingles fallback:', err);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return [
    {
      name: 'stylized_view_1' + (path.extname(sheetPath).toLowerCase() || '.png'),
      buffer: fs.readFileSync(sheetPath),
      roleHint: '',
    },
  ];
}

/**
 * Use Antigravity `agy` + `image-generator` to redraw uploaded subject photo(s)
 * in the exact 2D illustrated style of `styleRefPath` (2x2 spaced grid on #00FF00).
 */
async function generateStylizedTurnaround({
  subjectFiles,
  styleRefPath,
  variantName = '',
  pyBin = '',
  stageRoot = path.join(os.homedir(), '.hachimi-pet', 'cache'),
}) {
  const agyBin = resolveAgyBinary();
  if (!agyBin) {
    throw makeHumanError('MODEL_UNAVAILABLE', '未找到本机 Antigravity 模型命令（agy），暂时无法使用模型协助生成。');
  }

  fs.mkdirSync(stageRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(stageRoot, 'ai-style-'));
  try {
    const stagedStyle = path.join(stageDir, 'style_reference.png');
    const hasStyleRef = Boolean(styleRefPath && fs.existsSync(styleRefPath));
    if (hasStyleRef) {
      fs.copyFileSync(styleRefPath, stagedStyle);
    }

    const subjectSheet = path.join(stageDir, 'subject_reference_sheet.png');
    buildSubjectReferenceSheet(pyBin, subjectFiles, subjectSheet);

    const expectedOut = path.join(stageDir, 'stylized_turnaround.png');
    const imagePathsList = hasStyleRef ? [stagedStyle, subjectSheet] : [subjectSheet];
    const styleInstruction = hasStyleRef
      ? `Style Reference Image #1 (CRITICAL — match this exact 2D illustrated lineart, brush/shading texture, head-to-body ratio, cute facial style, and crisp dark charcoal outline; DO NOT use raw photo cutouts!): \`${stagedStyle}\``
      : 'Target Style: Cute 2D hand-illustrated desktop pet character with crisp dark charcoal-brown ink outlines, soft cel/watercolor shading, and cohesive proportions (DO NOT use raw photo cutouts).';

    const prompt = [
      'You are generating a stylized 2D desktop-pet turnaround sheet from the uploaded subject reference collage.',
      'Do NOT call `schedule`, `manage_task`, `run_command`, `sips`, Figma MCP tools, or any HTML tools.',
      '',
      styleInstruction,
      `Combined Subject Reference Sheet (${subjectFiles.length} view(s) for ${variantName || 'new pet'}): \`${subjectSheet}\``,
      '',
      'CRITICAL TOOL & SPEED CONSTRAINTS:',
      `- If the built-in \`generate_image\` tool is directly available in your toolset, call it ONCE; otherwise call \`invoke_subagent\` on \`image-generator\` ONCE (NEVER Figma MCP).`,
      `- Pass ONLY ${imagePathsList.length} image path(s) in \`ImagePaths\`: ${JSON.stringify(imagePathsList)} (NEVER > 2) and \`ImageName\`: "stylized_turnaround".`,
      '- Instruct `image-generator` to make STRICTLY ONE generation call (accept the first result immediately, NO v2/v3 retries or self-critique loops) and return the exact saved image file path.',
      '- NEVER call `schedule`, NEVER call `manage_task`, NEVER call `run_command`/`sips`, and do NOT call `read_file` on the generated output.',
      '',
      'Steps:',
      `1. Inspect \`${subjectSheet}\`${hasStyleRef ? ` and \`${stagedStyle}\`` : ''} with \`read_file\` to capture the exact markings, colors, ears/eyes/features of the subject${hasStyleRef ? ' AND the exact 2D art style of the style reference' : ''}.`,
      '2. Generate ONE `1:1` square **`2×2` four-quadrant character turnaround grid** on a **pure flat `#00FF00` chroma-key green background** (ZERO text labels, ZERO grid lines/boxes, ZERO floor shadows, ZERO white sticker borders):',
      '   - **Top-Left quadrant**: Front-facing upright seated/standing view looking straight at viewer.',
      '   - **Top-Right quadrant**: Right-facing side profile walking/trotting pose (strictly facing right `+X`, full body & tail inside top-right quadrant).',
      '   - **Bottom-Left quadrant**: Back view (or cozy curled resting pose if back features are unspecified).',
      '   - **Bottom-Right quadrant**: Playful paw-raise waving / greeting pose.',
      '   - **SPACING RULE**: Leave WIDE empty `#00FF00` chroma-key green margins and wide cross-shaped green gutter bands (at least 12% gap horizontally and vertically) separating all 4 quadrants. NO ears, tails, or paws may touch or cross between quadrants!',
      '3. If waiting for `image-generator`, end your turn immediately with no `schedule` timer. Once you have the generated image path, reply immediately ONLY with that exact absolute file path.',
    ].join('\n');

    const startTimeMs = Date.now();
    const { code, stdout, stderr, conversationId, assembledText, timedOut } = await runAgyPromptAsync({ agyBin, stageDir, prompt });
    const parsedErr = parseAgyFailureMessage(code, stdout, stderr);

    const foundPath = resolveGeneratedImagePath({
      expectedOut,
      stdout,
      stderr,
      assembledText,
      conversationId,
      startTimeMs,
      ignoredPaths: [hasStyleRef ? stagedStyle : '', subjectSheet],
    });

    if (!foundPath || !fs.existsSync(foundPath)) {
      if (parsedErr && parsedErr.code !== 'MODEL_EMPTY') throw parsedErr;
      if (timedOut) {
        throw makeHumanAiError('TIMEOUT', '模型绘制超时了，请稍后再试或减少参考图数量。');
      }
      if (parsedErr) throw parsedErr;
      throw makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效图像，请稍后再试或关闭「模型协助生成」直接导入。');
    }

    const splitFiles = splitStylizedSheetToSingles(pyBin, foundPath);
    const outBuf = fs.readFileSync(foundPath);
    const outExt = path.extname(foundPath).toLowerCase() || '.png';
    return {
      files: splitFiles,
      buffer: outBuf,
      ext: outExt,
      name: 'stylized_turnaround' + outExt,
    };
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const ROW_ACTION_DESCRIPTIONS = {
  0: { count: 4, desc: 'front-seated calm idle breathing & gentle eye blink sequence (open eyes -> half-blink -> closed eyes -> open eyes), upright stationary body' },
  1: { count: 4, desc: 'joyful right-facing running/trotting stride cycle (4 distinct progressive running poses facing RIGHT)' },
  2: { count: 4, desc: 'joyful left-facing running/trotting stride cycle (4 distinct progressive running poses facing LEFT)' },
  3: { count: 4, desc: 'polite gentle head nod + blink greeting sequence (stationary body, subtle 2-3% nod)' },
  4: { count: 4, desc: 'cute jump sequence: crouch -> upward leap -> mid-air apex -> soft landing' },
  5: { count: 4, desc: 'curious progressive head tilt expression (upright -> slight tilt -> cute 10-degree curious head tilt)' },
  6: { count: 4, desc: 'cozy calm resting / sleeping / paw-licking sequence with steady body height' },
  7: { count: 4, desc: 'seated character playfully batting and rolling a small pink yarn ball on the floor with one paw (body steady)' },
  8: { count: 4, desc: 'calm attentive reading / observing expression with subtle downward-forward gaze & blink' },
  9: { count: 8, desc: '2x4 grid (2 rows x 4 cols = 8 frames) right-half compass head-turn (0 deg up, 22.5, 45, 67.5, 90 right, 112.5, 135, 157.5 down-right) with stationary front-seated body and tail on right' },
  10: { count: 8, desc: '2x4 grid (2 rows x 4 cols = 8 frames) left-half compass head-turn (180 deg down, 202.5, 225, 247.5, 270 left, 292.5 left-up, 315 up-left, 337.5 steeply up-left) with stationary front-seated body and tail on right' },
};

/**
 * Redraw a specific row (or frame) of an existing character using `agy` + `image-generator`,
 * conditioned on the character's R00 c0 anchor + optional 1 user-uploaded reference image + user instruction.
 */
async function generateRedrawnRowWithModel({
  atlasPath,
  thumbPath,
  row,
  instruction = '',
  refImageBuffer = null,
  refImageExt = '.png',
  pyBin = '',
  stageRoot = path.join(os.homedir(), '.hachimi-pet', 'cache'),
}) {
  const agyBin = resolveAgyBinary();
  if (!agyBin) {
    const err = new Error('未找到本机 Antigravity 模型命令（agy），暂时无法使用模型重绘。');
    err.code = 'MODEL_UNAVAILABLE';
    err.isHumanError = true;
    throw err;
  }

  fs.mkdirSync(stageRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(stageRoot, 'ai-row-'));
  try {
    const anchorPng = path.join(stageDir, 'character_anchor.png');
    exportVariantStyleAnchorPng(pyBin, atlasPath, thumbPath, anchorPng);

    let userRefPath = '';
    if (refImageBuffer && Buffer.isBuffer(refImageBuffer) && refImageBuffer.length > 0) {
      userRefPath = path.join(stageDir, `user_reference${refImageExt || '.png'}`);
      fs.writeFileSync(userRefPath, refImageBuffer);
    }

    const rowSpec = ROW_ACTION_DESCRIPTIONS[row] || ROW_ACTION_DESCRIPTIONS[0];
    const layoutHint = rowSpec.count === 8
      ? '2 rows × 4 columns (`2×4` = 8 frames)'
      : '1 single horizontal row of 4 equally spaced frames (`1×4`)';
    const expectedOut = path.join(stageDir, 'redrawn_strip.jpg');

    const rowImagePaths = userRefPath ? [anchorPng, userRefPath] : [anchorPng];
    const prompt = [
      'You are redrawing ONE sprite animation strip for an existing 2D desktop-pet character.',
      'Do NOT call `schedule`, `manage_task`, `run_command`, `sips`, Figma MCP tools, or any HTML tools.',
      '',
      `Character Style & Identity Anchor (MUST keep 100% identical character design, colors, markings, proportions, and dark ink outline): \`${anchorPng}\``,
      userRefPath ? `Additional User Reference Image: \`${userRefPath}\`` : '',
      instruction ? `User Modification Instruction (HIGHEST PRIORITY): ${instruction}` : '',
      '',
      `Target Action Row (R${String(row).padStart(2, '0')}): ${rowSpec.desc}`,
      `Required Sheet Layout: ${layoutHint} on a **pure flat \`#00FF00\` chroma-key green background** (NO text, NO grid lines, NO floor shadow, NO white sticker border).`,
      'CRITICAL TOOL & SPEED CONSTRAINTS:',
      `- If the built-in \`generate_image\` tool is directly available in your toolset, call it ONCE; otherwise call \`invoke_subagent\` on \`image-generator\` ONCE (NEVER Figma MCP).`,
      `- Pass ONLY ${rowImagePaths.length} path(s) in \`ImagePaths\`: ${JSON.stringify(rowImagePaths)} (NEVER > 2) and \`ImageName\`: "redrawn_strip".`,
      '- Instruct `image-generator` to make STRICTLY ONE generation call (accept the first result immediately, NO v2/v3 retries) and return the exact saved image file path.',
      '- NEVER call `schedule`, NEVER call `manage_task`, NEVER call `run_command`/`sips`, and do NOT call `read_file` on the generated output.',
      '',
      'Steps:',
      `1. Inspect \`${anchorPng}\`${userRefPath ? ` and \`${userRefPath}\`` : ''} using \`read_file\`.`,
      '2. Generate the clean `#00FF00` sprite strip matching the Character Anchor and User Modification Instruction.',
      '3. If waiting for `image-generator`, end your turn immediately with no `schedule` timer. Once you have the generated image path, reply immediately ONLY with that exact absolute file path.',
    ].filter(Boolean).join('\n');

    const startTimeMs = Date.now();
    const { code, stdout, stderr, conversationId, assembledText, timedOut } = await runAgyPromptAsync({ agyBin, stageDir, prompt });
    const parsedErr = parseAgyFailureMessage(code, stdout, stderr);

    const foundPath = resolveGeneratedImagePath({
      expectedOut,
      stdout,
      stderr,
      assembledText,
      conversationId,
      startTimeMs,
      ignoredPaths: [anchorPng, userRefPath],
    });

    if (!foundPath || !fs.existsSync(foundPath)) {
      if (parsedErr && parsedErr.code !== 'MODEL_EMPTY') throw parsedErr;
      if (timedOut) {
        throw makeHumanAiError('TIMEOUT', '模型重绘超时了，请稍后再试或简化修改说明。');
      }
      if (parsedErr) throw parsedErr;
      throw makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效的重绘图像，请调整说明后重试或直接上传替换图。');
    }

    return {
      buffer: fs.readFileSync(foundPath),
      ext: path.extname(foundPath).toLowerCase() || '.jpg',
    };
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  resolveAgyBinary,
  exportVariantStyleAnchorPng,
  buildSubjectReferenceSheet,
  splitStylizedSheetToSingles,
  extractImagePathsFromText,
  parseStreamJsonSummary,
  findGeneratedBrainImage,
  resolveGeneratedImagePath,
  parseAgyFailureMessage,
  generateStylizedTurnaround,
  generateRedrawnRowWithModel,
};
