const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const THREE_VIEW_SCRIPT_PATH = path.join(__dirname, 'three-view-builder.py');

let cachedPyPilBin = null;
const verifiedPyFullCache = new Map();

function isPythonFullReady(bin) {
  if (!bin || typeof bin !== 'string') return false;
  if (verifiedPyFullCache.has(bin)) return verifiedPyFullCache.get(bin);
  let ok = false;
  try {
    const res = spawnSync(bin, ['-c', 'import PIL.Image, numpy, scipy; print("ok")'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    ok = res.status === 0 && (res.stdout || '').trim() === 'ok';
  } catch {
    ok = false;
  }
  verifiedPyFullCache.set(bin, ok);
  return ok;
}

function resolvePythonPilBinary(explicitBin = '') {
  if (explicitBin && typeof explicitBin === 'string' && isPythonFullReady(explicitBin)) {
    return explicitBin;
  }
  if (cachedPyPilBin !== null) return cachedPyPilBin;
  const candidates = [
    process.env.HACHIMI_PYTHON,
    '/opt/anaconda3/bin/python3',
    'python3',
    'python',
  ].filter(Boolean);

  for (const bin of candidates) {
    if (isPythonFullReady(bin)) {
      cachedPyPilBin = bin;
      return cachedPyPilBin;
    }
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
  // Strip normal stream-json tool input payloads mentioning "ImagePaths": [...] so valid tool calls never false-trigger arg errors
  const errOnly = `${stderr}\n${String(stdout || '').replace(/"imagepaths"\s*:\s*\[[^\]]*\]/gi, '')}`.toLowerCase();
  if (/(?:\bmaxitems\b|\binvalid[_\s]+arguments?\b|\bimagepaths\b[^.\n]{0,60}\b(?:exceed|exceeds|exceeded|max|maximum|limit|invalid|too many|must have|more than)\b)/.test(errOnly)) {
    return makeHumanAiError('MODEL_INVALID_ARGS', '发送给模型的参考图参数超出限制，请减少参考图数量或关闭「模型协助生成」直接导入。');
  }
  if (/(?:\bquota\b|\brate[\s_-]?limit|\btoo many requests\b|\bresource[_\s]exhausted\b|\bhttp\s*429\b|\bstatus\s*429\b|\boverloaded\b)/.test(errOnly)) {
    return makeHumanAiError('MODEL_QUOTA', '模型调用额度暂满或请求过于频繁，请稍后再试或关闭「模型协助生成」直接导入。');
  }
  if (/(?:\bunauthorized\b|\bunauthenticated\b|\bnot logged in\b|\bauth\w*\s+expired\b|\bhttp\s*401\b|\bstatus\s*401\b|\bhttp\s*403\b|\bforbidden\b)/.test(errOnly)) {
    return makeHumanAiError('MODEL_AUTH', '本机 Antigravity 模型尚未登录或授权已过期，请先完成登录后重试。');
  }
  if (/(?:\btimed out\b|\betimedout\b|\bdeadline exceeded\b)/.test(combined)) {
    return makeHumanAiError('TIMEOUT', '模型绘制超时了，请稍后再试或减少参考图数量。');
  }
  if (code !== null && code !== undefined && code !== 0) {
    return makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效图像，请稍后再试或关闭「模型协助生成」直接导入。');
  }
  return null;
}

function resolveAgyBinary() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.AGY_BIN,
        path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
        'agy.exe',
        'agy',
      ].filter(Boolean)
    : [
        process.env.AGY_BIN,
        path.join(os.homedir(), '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
        'agy',
      ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if ((bin.includes('/') || bin.includes('\\')) && !fs.existsSync(bin)) continue;
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
  const resolvedPy = resolvePythonPilBinary(pyBin) || (typeof pyBin === 'string' ? pyBin : '');
  if (!resolvedPy) {
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
tw, th = max(384, cell.width * 2), max(416, cell.height * 2)
bg = Image.new("RGBA", (tw, th), (255, 255, 255, 255))
resized = cell.resize((tw - 32, th - 32), Image.Resampling.LANCZOS)
bg.alpha_composite(resized, (16, 16))
bg.convert("RGB").save(dst, "PNG")
print("ok")
`;
  const res = spawnSync(resolvedPy, ['-c', script, srcPath, outStylePng], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (res.status === 0 && fs.existsSync(outStylePng)) return true;
  fs.copyFileSync(srcPath, outStylePng);
  return true;
}

function detectIsCodex8x11Atlas(pyBin, imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return false;
  const resolvedPy = resolvePythonPilBinary(pyBin) || (typeof pyBin === 'string' ? pyBin : '');
  if (!resolvedPy) return false;
  const res = spawnSync(
    resolvedPy,
    ['-c', 'import sys; from PIL import Image; im=Image.open(sys.argv[1]); w,h=im.size; print("yes" if (w>=1024 and h>=1400 and abs((w/8)/(h/11)-192/208)<0.12) else "no")', imgPath],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  return res.status === 0 && String(res.stdout || '').trim() === 'yes';
}

function extractImagePathsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const rawPlain = text
    .replace(/\\+\//g, '/')
    .replace(/\\"/g, '"');
  const jsonUnescaped = text
    .replace(/\\\\/g, '\u0000')
    .replace(/\\\//g, '/')
    .replace(/\\([nrt])/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\u0000/g, '\\');

  const matches = [];
  const seen = new Set();
  const rootPrefix = '(?:\\/(?:Users|Volumes|home|var|tmp|private)|[A-Za-z]:[\\\\/])';
  const quotedRe = new RegExp(`["'\`](${rootPrefix}[^"'\`\\r\\n]+?\\.(?:png|jpg|jpeg|webp))["'\`]`, 'gi');
  const bareRe = new RegExp(`(${rootPrefix}[^\\s"'\`<>()[\\]{}]+\\.(?:png|jpg|jpeg|webp))`, 'gi');

  const scan = (src, re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const p = m[1].trim().replace(/[.,;:!?]+$/, '');
      if (!p || seen.has(p)) continue;
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          seen.add(p);
          matches.push(p);
        }
      } catch { /* ignore invalid path */ }
    }
  };

  for (const variant of [rawPlain, jsonUnescaped]) {
    scan(variant, quotedRe);
    scan(variant, bareRe);
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
  const minFreshMs = Number.isFinite(startTimeMs) && startTimeMs > 0 ? startTimeMs - 5000 : 0;
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
    if (minFreshMs > 0) {
      try {
        const st = fs.statSync(resolved);
        if (st.mtimeMs < minFreshMs) return false;
      } catch {
        return false;
      }
    }
    return true;
  });

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  return findGeneratedBrainImage(conversationId, startTimeMs);
}

function runAgyPromptAsync({ agyBin, stageDir, extraDirs = [], prompt, timeoutMs = 240000 }) {
  return new Promise((resolve, reject) => {
    const addDirArgs = [];
    const seenDirs = new Set();
    for (const d of [stageDir, ...(Array.isArray(extraDirs) ? extraDirs : [])]) {
      if (d && !seenDirs.has(d)) {
        seenDirs.add(d);
        addDirArgs.push('--add-dir', d);
      }
    }
    const args = [
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--effort',
      'low',
      '--disable-slash-commands',
      ...addDirArgs,
      '-p',
      prompt,
    ];

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const extraPathEntries = process.platform === 'win32'
      ? [path.join(os.homedir(), '.local', 'bin')]
      : [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin'];
    const mergedPath = [...extraPathEntries, process.env[pathKey] || ''].filter(Boolean).join(path.delimiter);
    const env = {
      ...process.env,
      HACHIMI_INTERNAL_AI_GEN: '1',
      [pathKey]: mergedPath,
    };

    const child = spawn(agyBin, args, {
      cwd: stageDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    const MAX_STDOUT_CHARS = 16 * 1024 * 1024;
    const MAX_STDERR_CHARS = 4 * 1024 * 1024;
    let stdoutAll = '';
    let stderrAll = '';
    let settled = false;
    let killTimer = null;

    const clearAllTimers = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 3000);
      killTimer.unref?.();
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
      if (stdoutAll.length > MAX_STDOUT_CHARS) {
        stdoutAll = `${stdoutAll.slice(0, 65536)}\n${stdoutAll.slice(-(MAX_STDOUT_CHARS - 65536))}`;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrAll += chunk.toString('utf8');
      if (stderrAll.length > MAX_STDERR_CHARS) {
        stderrAll = stderrAll.slice(-MAX_STDERR_CHARS);
      }
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      reject(makeHumanAiError('MODEL_UNAVAILABLE', '未能启动本机 Antigravity 模型命令（agy），暂时无法使用模型协助生成。'));
    });

    child.on('close', (code) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
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
 * Deterministically split Stage A 2x2 #00FF00 identity anchor sheet into clean isolated
 * RGBA PNG buffers (TL=front, TR=right_side, BL=sleep, BR=hold) with olive/sage-green eye protection.
 */
function splitStylizedSheetToSingles(pyBin, sheetPath) {
  const resolvedPy = resolvePythonPilBinary(pyBin);
  if (!resolvedPy || !fs.existsSync(THREE_VIEW_SCRIPT_PATH)) {
    return [
      {
        name: 'stylized_view_1' + (path.extname(sheetPath).toLowerCase() || '.png'),
        buffer: fs.readFileSync(sheetPath),
        roleHint: '',
        anchorKey: 'front',
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

arr_raw = np.array(rgba, dtype=np.uint8)
_ist, _bg, _p90, bg_kind = tvb._sample_border_background(arr_raw)
if bg_kind == "green" and hasattr(tvb, "chroma_matte_green_safe"):
    matted = tvb.chroma_matte_green_safe(rgba, keep_yellow_butterfly=False)
    matted = tvb._strip_grid_divider_bars_arr(matted)
    keyed = tvb.filter_isolated_noise(Image.fromarray(matted, "RGBA"))
else:
    keyed = tvb.adaptive_remove_background(rgba, orig_path=Path(sheet_path), allow_multiple=True)
    keyed = tvb.filter_isolated_noise(keyed)

if not tvb._has_visible_foreground(keyed, min_pixels=64):
    raise RuntimeError("empty generated sheet")

arr = np.array(keyed, dtype=np.uint8)
arr = tvb._strip_grid_divider_bars_arr(arr) if hasattr(tvb, "_strip_grid_divider_bars_arr") else arr
keyed = tvb.filter_isolated_noise(Image.fromarray(arr, "RGBA"))
arr = np.array(keyed, dtype=np.uint8)
h, w = arr.shape[:2]
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

def is_multi_figure_collage(im_rgba):
    if hasattr(tvb, "_looks_like_multi_figure_collage"):
        return bool(tvb._looks_like_multi_figure_collage(im_rgba))
    return False

def find_clean_valley(mass_1d, lo, hi, min_side_area=80):
    n = len(mass_1d)
    lo = max(1, min(n - 2, int(lo)))
    hi = max(lo + 1, min(n - 1, int(hi)))
    cum = np.cumsum(mass_1d)
    total = int(cum[-1])
    if total < min_side_area * 2:
        idx = (lo + hi) // 2
        return idx, int(mass_1d[idx]), False
    valid_idx = [
        i for i in range(lo, hi)
        if int(cum[i - 1]) >= min_side_area and (total - int(cum[i])) >= min_side_area
    ]
    if not valid_idx:
        idx = lo + int(np.argmin(mass_1d[lo:hi]))
        return idx, int(mass_1d[idx]), False
    min_val = min(int(mass_1d[i]) for i in valid_idx)
    best_run = []
    cur_run = []
    for i in valid_idx:
        if int(mass_1d[i]) <= min_val + 1:
            if not cur_run or i == cur_run[-1] + 1:
                cur_run.append(i)
            else:
                if len(cur_run) > len(best_run):
                    best_run = cur_run
                cur_run = [i]
        else:
            if len(cur_run) > len(best_run):
                best_run = cur_run
            cur_run = []
    if len(cur_run) > len(best_run):
        best_run = cur_run
    mid = best_run[len(best_run) // 2] if best_run else valid_idx[0]
    return mid, int(mass_1d[mid]), True

def build_quad_cells(tl_raw, tr_raw, bl_raw, br_raw, allow_resplit=True):
    quad_specs = [
        (tl_raw, "quad_tl"),
        (tr_raw, "quad_tr"),
        (bl_raw, "quad_bl"),
        (br_raw, "quad_br"),
    ]
    extracted = []
    for raw_q, tag in quad_specs:
        if raw_q is None or not tvb._has_visible_foreground(raw_q, min_pixels=80):
            continue
        if allow_resplit and is_multi_figure_collage(raw_q):
            subs = split_cell_isolated(raw_q)
        else:
            subs = [raw_q]
        for sub_sp in subs:
            hint = ""
            akey = ""
            if len(subs) == 1:
                if tag == "quad_tl":
                    hint = "front"
                    akey = "front"
                elif tag == "quad_tr":
                    hint = "right_side" if tvb.detect_side_faces_right(sub_sp) else "left_side"
                    akey = "side"
                elif tag == "quad_bl":
                    hint = "action"
                    akey = "sleep"
                elif tag == "quad_br":
                    hint = "action"
                    akey = "hold"
            extracted.append((sub_sp, hint, akey))
    return extracted

def split_quad_by_cc(arr_rgba):
    fg_m = arr_rgba[:, :, 3] > 16
    total_fg = int(fg_m.sum())
    if total_fg < 320:
        return []
    ys_all, xs_all = np.where(fg_m)
    fx0, fx1 = int(xs_all.min()), int(xs_all.max()) + 1
    fy0, fy1 = int(ys_all.min()), int(ys_all.max()) + 1
    fw = max(1, fx1 - fx0)
    fh = max(1, fy1 - fy0)

    def _find_4_seeds(mask_bool):
        lab, n_cc = ndi.label(mask_bool, structure=np.ones((3, 3), dtype=int))
        if n_cc < 4:
            return None, None, []
        sz = np.bincount(lab.ravel())
        sz[0] = 0
        min_major = max(80, int(total_fg * 0.02))
        major = [cid for cid in range(1, n_cc + 1) if int(sz[cid]) >= min_major]
        major.sort(key=lambda cid: int(sz[cid]), reverse=True)
        if len(major) < 4:
            return None, None, []
        top4 = major[:4]
        if int(sz[top4[3]]) < max(min_major, int(0.12 * int(sz[top4[0]]))):
            return None, None, []
        return lab, sz, top4

    lab, sz, top4 = _find_4_seeds(fg_m)
    used_eroded = False
    if len(top4) < 4:
        eroded = ndi.binary_erosion(fg_m, iterations=3)
        lab_e, sz_e, top4_e = _find_4_seeds(eroded)
        if len(top4_e) == 4:
            lab, sz, top4 = lab_e, sz_e, top4_e
            used_eroded = True

    if len(top4) < 4:
        return []

    slices = ndi.find_objects(lab)
    info = []
    for cid in top4:
        sl = slices[cid - 1]
        sub_m = (lab[sl] == cid)
        ly, lx = np.where(sub_m)
        cx = float(sl[1].start + lx.mean())
        cy = float(sl[0].start + ly.mean())
        info.append({"cid": cid, "cx": cx, "cy": cy, "area": int(sz[cid])})

    info_by_y = sorted(info, key=lambda d: d["cy"])
    top_pair = sorted(info_by_y[:2], key=lambda d: d["cx"])
    bot_pair = sorted(info_by_y[2:], key=lambda d: d["cx"])
    tl_info, tr_info = top_pair[0], top_pair[1]
    bl_info, br_info = bot_pair[0], bot_pair[1]

    if (min(bl_info["cy"], br_info["cy"]) - max(tl_info["cy"], tr_info["cy"])) < 0.14 * fh:
        return []
    if (tr_info["cx"] - tl_info["cx"]) < 0.16 * fw or (br_info["cx"] - bl_info["cx"]) < 0.16 * fw:
        return []

    ordered_cids = [tl_info["cid"], tr_info["cid"], bl_info["cid"], br_info["cid"]]
    hh, ww = fg_m.shape
    ds = 2 if max(hh, ww) >= 600 else 1
    seed_masks = [(lab == cid) for cid in ordered_cids]
    dist_stack = np.stack([
        ndi.distance_transform_edt(~m[::ds, ::ds]) for m in seed_masks
    ], axis=0)
    nearest_ds = np.argmin(dist_stack, axis=0)
    min_dist_ds = np.min(dist_stack, axis=0)
    max_frag_dist = max(40.0, 0.14 * max(hh, ww)) / ds

    if used_eroded:
        ys_fg, xs_fg = np.where(fg_m)
        ny_ds = np.clip(ys_fg // ds, 0, nearest_ds.shape[0] - 1)
        nx_ds = np.clip(xs_fg // ds, 0, nearest_ds.shape[1] - 1)
        owner = nearest_ds[ny_ds, nx_ds]
        ok_d = min_dist_ds[ny_ds, nx_ds] <= max_frag_dist
        cluster_masks = [np.zeros_like(fg_m) for _ in range(4)]
        for k in range(4):
            sel = ok_d & (owner == k)
            cluster_masks[k][ys_fg[sel], xs_fg[sel]] = True
    else:
        cluster_masks = [m.copy() for m in seed_masks]
        seed_set = set(ordered_cids)
        all_slices = ndi.find_objects(lab)
        for cid in range(1, int(lab.max()) + 1):
            if cid in seed_set:
                continue
            sl = all_slices[cid - 1]
            if sl is None:
                continue
            fmask = (lab[sl] == cid)
            fy_f, fx_f = np.where(fmask)
            if len(fy_f) == 0:
                continue
            ny_f = np.clip((sl[0].start + fy_f) // ds, 0, dist_stack.shape[1] - 1)
            nx_f = np.clip((sl[1].start + fx_f) // ds, 0, dist_stack.shape[2] - 1)
            d_per_seed = [float(dist_stack[k, ny_f, nx_f].min()) for k in range(4)]
            best_k = int(np.argmin(d_per_seed))
            if d_per_seed[best_k] <= max_frag_dist:
                cluster_masks[best_k][sl] |= fmask

    imgs = []
    for k in range(4):
        out_k = np.where(cluster_masks[k][:, :, None], arr_rgba, 0).astype(np.uint8)
        imgs.append(tvb._crop_tight(Image.fromarray(out_k, "RGBA")))
    return imgs

quad_cells = []
split_tier = "none"

# Tier 1 (Horizontal-first): full-width horizontal valley in 32%..68% -> split_lr on top & bottom bands
row_mass = fg.sum(axis=1)
gy, gy_val, gy_both = find_clean_valley(row_mass, int(h * 0.32), int(h * 0.68), min_side_area=80)
if gy_both and float(gy_val) <= max(10.0, w * 0.05):
    top_band = keyed.crop((0, 0, w, gy))
    bot_band = keyed.crop((0, gy, w, h))

    def split_lr(band_im):
        ba = np.array(band_im)[:, :, 3] > 16
        bh_b, bw_b = ba.shape
        col_m = ba.sum(axis=0)
        gx_b, gx_val_b, gx_both_b = find_clean_valley(col_m, int(bw_b * 0.30), int(bw_b * 0.70), min_side_area=80)
        if gx_both_b and float(gx_val_b) <= max(8.0, bh_b * 0.05):
            return band_im.crop((0, 0, gx_b, bh_b)), band_im.crop((gx_b, 0, bw_b, bh_b)), True
        sv = tvb._split_combined_views(band_im)
        if len(sv) == 2:
            return sv[0], sv[1], True
        return band_im.crop((0, 0, gx_b, bh_b)), band_im.crop((gx_b, 0, bw_b, bh_b)), False

    tl_raw, tr_raw, ok_top = split_lr(top_band)
    bl_raw, br_raw, ok_bot = split_lr(bot_band)
    if (ok_top or not is_multi_figure_collage(top_band)) and (ok_bot or not is_multi_figure_collage(bot_band)):
        cand = build_quad_cells(tl_raw, tr_raw, bl_raw, br_raw, allow_resplit=True)
        if len(cand) >= 2:
            quad_cells = cand
            split_tier = "tier1_horizontal_first"

# Tier 2 (Vertical-first): handles tall BR anchor_hold overlapping top row past y=50%!
if not quad_cells:
    col_mass = fg.sum(axis=0)
    gx, gx_val, gx_both = find_clean_valley(col_mass, int(w * 0.30), int(w * 0.70), min_side_area=80)
    if gx_both and float(gx_val) <= max(10.0, h * 0.05):
        left_col = keyed.crop((0, 0, gx, h))
        right_col = keyed.crop((gx, 0, w, h))

        def split_tb(col_im, ry0_frac, ry1_frac):
            ca = np.array(col_im)[:, :, 3] > 16
            ch_c, cw_c = ca.shape
            row_m = ca.sum(axis=1)
            gy_c, gy_val_c, gy_both_c = find_clean_valley(row_m, int(ch_c * ry0_frac), int(ch_c * ry1_frac), min_side_area=80)
            if gy_both_c and float(gy_val_c) <= max(10.0, cw_c * 0.05):
                return col_im.crop((0, 0, cw_c, gy_c)), col_im.crop((0, gy_c, cw_c, ch_c)), True
            return col_im.crop((0, 0, cw_c, gy_c)), col_im.crop((0, gy_c, cw_c, ch_c)), False

        tl_raw, bl_raw, ok_l = split_tb(left_col, 0.25, 0.78)
        tr_raw, br_raw, ok_r = split_tb(right_col, 0.20, 0.75)
        if ok_l and ok_r:
            cand = build_quad_cells(tl_raw, tr_raw, bl_raw, br_raw, allow_resplit=True)
            if len(cand) >= 2:
                quad_cells = cand
                split_tier = "tier2_vertical_first"

# Tier 3 (4-Cluster Connected-Component Fallback): handles simultaneous H & V staggered overlap!
if not quad_cells:
    cc_quads = split_quad_by_cc(arr)
    if len(cc_quads) == 4:
        cand = build_quad_cells(cc_quads[0], cc_quads[1], cc_quads[2], cc_quads[3], allow_resplit=False)
        if len(cand) >= 2:
            quad_cells = cand
            split_tier = "tier3_cc_4cluster"

if not quad_cells:
    figs = tvb._split_combined_views(keyed)
    for idx_f, fig in enumerate(figs):
        if tvb._has_visible_foreground(fig, min_pixels=60):
            akey = "front" if idx_f == 0 else ("side" if idx_f == 1 else "")
            quad_cells.append((fig, "front" if idx_f == 0 else "", akey))
    if quad_cells:
        split_tier = "fallback_split_combined"

# Tier 4 (Hard Single-Subject Guard on front): NEVER return a 2x2 or multi-figure collage as front!
front_idx = next((i for i, (_sp, _h, ak) in enumerate(quad_cells) if ak == "front"), 0 if quad_cells else -1)
if front_idx >= 0:
    f_sp, f_hint, f_akey = quad_cells[front_idx]
    if is_multi_figure_collage(f_sp) and hasattr(tvb, "_isolate_top_left_figure"):
        isolated_tl = tvb._isolate_top_left_figure(f_sp)
        if tvb._has_visible_foreground(isolated_tl, min_pixels=60):
            quad_cells[front_idx] = (isolated_tl, f_hint or "front", "front")
            split_tier = f"{split_tier}+tier4_front_tl_guard"

results = []
for idx, (sp, hint, akey) in enumerate(quad_cells):
    padded = pad_single(sp)
    out_p = os.path.join(out_dir, f"view_{idx}.png")
    padded.save(out_p, "PNG")
    results.append({
        "path": out_p,
        "name": f"stylized_{akey or ('view_' + str(idx + 1))}.png",
        "roleHint": hint,
        "anchorKey": akey,
    })

print(json.dumps({"ok": True, "tier": split_tier, "files": results}, ensure_ascii=False))
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
          anchorKey: item.anchorKey || '',
        }));
      }
    } else {
      console.error('[ai-style-generator] splitStylizedSheetToSingles python exited non-zero:', {
        status: res.status,
        stderr: String(res.stderr || '').slice(0, 1000),
      });
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
      anchorKey: 'front',
    },
  ];
}

/**
 * Prepare clean white-bg Stage B anchor cards + R05 smooth angle-tilt guide (from Stage A's own front!)
 * + optional soft monochrome pose guides from `styleAtlasPath` (zero fur color bleed!).
 */
function prepareStageBReferences(pyBin, {
  frontPath,
  sidePath = '',
  sleepPath = '',
  holdPath = '',
  styleAtlasPath = '',
  refsDir,
}) {
  const resolvedPy = resolvePythonPilBinary(pyBin);
  fs.mkdirSync(refsDir, { recursive: true });
  if (!resolvedPy || !frontPath || !fs.existsSync(frontPath)) {
    return {};
  }

  const cfgPath = path.join(refsDir, 'prep_cfg.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      frontPath,
      sidePath,
      sleepPath,
      holdPath,
      styleAtlasPath,
      refsDir,
      tvbPath: THREE_VIEW_SCRIPT_PATH,
    }),
    'utf8',
  );

  const pyScript = `
import importlib.util, json, os, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

cfg = json.loads(open(sys.argv[1], "r", encoding="utf-8").read())
refs_dir = Path(cfg["refsDir"])
spec = importlib.util.spec_from_file_location("tvb", cfg["tvbPath"])
tvb = importlib.util.module_from_spec(spec)
sys.modules["tvb"] = tvb
spec.loader.exec_module(tvb)

def load_rgba(p):
    if not p or not os.path.isfile(p):
        return None
    with Image.open(p) as im:
        im.load()
        return tvb._crop_tight(im.convert("RGBA"))

def fit_on_white(sp, size=(512, 512), pad=36):
    w, h = size
    bg = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    sc = min((w - pad * 2) / max(1, sp.width), (h - pad * 2) / max(1, sp.height))
    nw, nh = max(1, round(sp.width * sc)), max(1, round(sp.height * sc))
    rs = tvb._resize_rgba_clean(sp, (nw, nh))
    bg.alpha_composite(rs, ((w - nw) // 2, (h - nh) // 2))
    return bg.convert("RGB")

def make_pair_card(sp_a, sp_b, out_path):
    w, h = 960, 480
    bg = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(bg)
    draw.line([(w // 2, 24), (w // 2, h - 24)], fill=(228, 232, 238, 255), width=2)
    for idx, sp in enumerate((sp_a, sp_b)):
        if sp is None:
            continue
        box_w, box_h = w // 2 - 48, h - 48
        sc = min(box_w / max(1, sp.width), box_h / max(1, sp.height))
        nw, nh = max(1, round(sp.width * sc)), max(1, round(sp.height * sc))
        rs = tvb._resize_rgba_clean(sp, (nw, nh))
        x0 = idx * (w // 2) + (w // 2 - nw) // 2
        y0 = (h - nh) // 2
        bg.alpha_composite(rs, (x0, y0))
    bg.convert("RGB").save(out_path, "PNG")
    return str(out_path)

out = {}
front_sp = load_rgba(cfg.get("frontPath"))
side_sp = load_rgba(cfg.get("sidePath"))
sleep_sp = load_rgba(cfg.get("sleepPath"))
hold_sp = load_rgba(cfg.get("holdPath"))

if front_sp is not None:
    p_front = refs_dir / "anchor_front_white.png"
    fit_on_white(front_sp, (512, 512), 36).save(p_front, "PNG")
    out["anchor_front_white"] = str(p_front)

    if side_sp is not None:
        out["anchor_front_side_white"] = make_pair_card(front_sp, side_sp, refs_dir / "anchor_front_side_white.png")
    else:
        out["anchor_front_side_white"] = str(p_front)

    if sleep_sp is not None:
        out["anchor_front_sleep_white"] = make_pair_card(front_sp, sleep_sp, refs_dir / "anchor_front_sleep_white.png")
    else:
        out["anchor_front_sleep_white"] = str(p_front)

    if hold_sp is not None:
        out["anchor_front_hold_white"] = make_pair_card(front_sp, hold_sp, refs_dir / "anchor_front_hold_white.png")
    else:
        out["anchor_front_hold_white"] = str(p_front)

    # Auto-generate crisp 4x2 smooth continuous tilt guide DIRECTLY from this character's own front anchor!
    front_cell = tvb.normalize_view_cell(front_sp)
    front_u8 = np.array(front_cell, dtype=np.uint8)
    _x0, _y0, _x1, _y1 = tvb._cell_bbox(front_cell)
    lock_y = min(tvb.CELL_H, int(round(_y0 + 0.56 * max(1.0, float(_y1 - _y0)))))
    guide_r05 = Image.new("RGBA", (1376, 768), (244, 245, 247, 255))
    angles = [0.0, -4.0, -8.0, -12.0, -15.0, -11.0, -7.0, -4.0]
    cw_g, ch_g = 344, 384
    for idx, ang in enumerate(angles):
        if idx == 0:
            tile = front_cell
        else:
            tile = tvb._articulate_cell(front_cell, angle_deg=ang, head_dx=ang * 0.18, waist_frac=0.47, neck_frac=0.26, bottom_excl=200)
            ta = np.array(tile, dtype=np.uint8)
            ta[lock_y:, :, :] = front_u8[lock_y:, :, :]
            tile = Image.fromarray(ta, "RGBA")
        rs = tvb._resize_rgba_clean(tile, (300, 325))
        gx, gy = idx % 4, idx // 4
        guide_r05.alpha_composite(rs, (gx * cw_g + (cw_g - 300) // 2, gy * ch_g + (ch_g - 325) // 2))
    p_g5 = refs_dir / "guide_r05_tilt8.png"
    guide_r05.convert("RGB").save(p_g5, "PNG")
    out["guide_r05"] = str(p_g5)

# Optional monochrome pose layout guides from 8x11 styleAtlasPath (preserves exact poses/proportions with ZERO fur color bleed!)
atlas_p = cfg.get("styleAtlasPath") or ""
if atlas_p and os.path.isfile(atlas_p):
    try:
        with Image.open(atlas_p) as aim:
            aim.load()
            atlas = aim.convert("RGBA")
        if atlas.size == (1536, 2288):
            def desaturate_cell(cell, keep_yellow=False, keep_pink=False):
                arr = np.array(cell, dtype=np.uint8)
                a = arr[:, :, 3]
                r = arr[:, :, 0].astype(np.float32)
                g = arr[:, :, 1].astype(np.float32)
                b = arr[:, :, 2].astype(np.float32)
                lum = np.clip(0.299 * r + 0.587 * g + 0.114 * b, 0, 255)
                # Slightly lift dark tones into readable soft neutral charcoal-gray silhouette
                gray = np.clip(lum * 0.85 + 26.0, 26.0, 238.0).astype(np.uint8)
                keep_col = np.zeros(a.shape, dtype=bool)
                if keep_yellow:
                    keep_col |= (a > 120) & (r >= 185) & (g >= 160) & (b <= 135) & ((r - b) >= 75)
                if keep_pink:
                    keep_col |= (a > 120) & (r >= 145) & ((r - g) >= 30) & (b >= 65)
                res = arr.copy()
                for ch in range(3):
                    res[:, :, ch] = np.where(keep_col, arr[:, :, ch], gray)
                res[a <= 12] = 0
                return Image.fromarray(res, "RGBA")

            def render_grid_guide(row_idx, cols_list, grid_cols, grid_rows, out_name, keep_yellow=False, keep_pink=False):
                board = Image.new("RGBA", (1376, 768), (244, 245, 247, 255))
                cw, ch = 1376 // grid_cols, 768 // grid_rows
                scale = min((cw - 24) / 192.0, (ch - 24) / 208.0)
                tw, th = max(1, round(192 * scale)), max(1, round(208 * scale))
                non_empty = 0
                for idx, c_i in enumerate(cols_list):
                    cell = atlas.crop((c_i * 192, row_idx * 208, (c_i + 1) * 192, (row_idx + 1) * 208))
                    if tvb._has_visible_foreground(cell, min_pixels=40):
                        non_empty += 1
                    mono = desaturate_cell(cell, keep_yellow=keep_yellow, keep_pink=keep_pink)
                    rs = tvb._resize_rgba_clean(mono, (tw, th))
                    gx, gy = idx % grid_cols, idx // grid_cols
                    board.alpha_composite(rs, (gx * cw + (cw - tw) // 2, gy * ch + (ch - th) // 2))
                if non_empty >= len(cols_list):
                    p_out = refs_dir / out_name
                    board.convert("RGB").save(p_out, "PNG")
                    return str(p_out)
                return ""

            g1 = render_grid_guide(1, list(range(8)), 4, 2, "guide_r01.png", keep_yellow=True)
            if g1: out["guide_r01"] = g1
            g2 = render_grid_guide(2, list(range(8)), 4, 2, "guide_r02.png", keep_yellow=True)
            if g2: out["guide_r02"] = g2
            g4 = render_grid_guide(4, list(range(5)), 3, 2, "guide_r04.png")
            if g4: out["guide_r04"] = g4
            # Use R04H guide only if atlas has a genuine slim vertical strip (c5 width <= 86px)
            c5_ref = atlas.crop((5 * 192, 4 * 208, 6 * 192, 5 * 208))
            if tvb._has_visible_foreground(c5_ref, min_pixels=80):
                bx0, by0, bx1, by1 = tvb._cell_bbox(c5_ref)
                if (bx1 - bx0) <= 86 and (by1 - by0) >= 150:
                    g4h = render_grid_guide(4, [5, 6, 7], 3, 1, "guide_r04h.png")
                    if g4h: out["guide_r04h"] = g4h
            g7 = render_grid_guide(7, list(range(6)), 3, 2, "guide_r07.png", keep_pink=True)
            if g7: out["guide_r07"] = g7
            g9 = render_grid_guide(9, list(range(8)), 4, 2, "guide_r09.png")
            if g9: out["guide_r09"] = g9
            g10 = render_grid_guide(10, list(range(8)), 4, 2, "guide_r10.png")
            if g10: out["guide_r10"] = g10
    except Exception:
        pass

print(json.dumps({"ok": True, "refs": out}, ensure_ascii=False))
`;

  const res = spawnSync(resolvedPy, ['-c', pyScript, cfgPath], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (res.status === 0 && res.stdout) {
    try {
      const parsed = JSON.parse(String(res.stdout).trim().split('\n').pop());
      if (parsed && parsed.ok && parsed.refs) return parsed.refs;
    } catch { /* ignore */ }
  }
  return {};
}

const COMMON_SHEET_RULES = [
  '- Background: **100% pure flat solid `#00FF00` (RGB 0,255,0) chroma-key green** across the entire canvas.',
  '- Cleanliness: **ZERO grid lines, ZERO borders/boxes, ZERO text labels/numbers, ZERO floor shadows, ZERO white sticker outlines/halos**.',
  '- Eye Color Protection: NEVER paint any eyes, pupils, or markings in neon `#00FF00` green; keep green/olive/yellow-green eyes muted warm olive/sage so chroma-keying protects them 100%.',
  '- Spacing: Leave generous empty `#00FF00` green gutters between every frame so ears, paws, props, and tails NEVER touch or cross into neighboring slots.',
  '- Style Lock: Every single frame MUST match Image #1\'s EXACT 2D illustration style, lineart thickness, shading texture, facial proportions, eye style, and markings.',
].join('\n');

function buildSingleCallPrompt({
  roleTitle,
  imagePaths,
  imageName,
  imageDescriptions,
  layoutInstruction,
  frameInstructions,
}) {
  return [
    `You are generating ONE ${roleTitle} for a 2D desktop-pet character.`,
    'Do NOT call `schedule`, `manage_task`, `run_command`, `sips`, Figma MCP tools, or any HTML tools.',
    '',
    'CRITICAL TOOL & SPEED CONSTRAINTS:',
    '- If the built-in `generate_image` tool is directly available in your toolset, call it ONCE; otherwise call `invoke_subagent` on `image-generator` ONCE (NEVER Figma MCP).',
    `- Pass ONLY ${imagePaths.length} image path(s) in \`ImagePaths\`: ${JSON.stringify(imagePaths)} (NEVER > 2) and \`ImageName\`: "${imageName}".`,
    '- Make STRICTLY ONE generation call (accept the first result immediately, NO v2/v3 retries or self-critique loops) and do NOT call `read_file` on the generated output.',
    '- NEVER call `schedule`, NEVER call `manage_task`, NEVER call `run_command`/`sips`.',
    '',
    'Steps:',
    `1. Inspect ${imagePaths.map((p) => `\`${p}\``).join(' and ')} with \`read_file\`:`,
    ...imageDescriptions.map((line) => `   ${line}`),
    `2. Generate ONE ${layoutInstruction}:`,
    COMMON_SHEET_RULES,
    ...frameInstructions.map((line) => `   ${line}`),
    '3. If waiting for `image-generator`, end your turn immediately with no `schedule` timer. Once you have the generated image path, reply immediately ONLY with that exact absolute file path.',
  ].join('\n');
}

async function runSingleSheetJob({
  agyBin,
  stageDir,
  extraDirs = [],
  prompt,
  ignoredPaths = [],
  timeoutMs = 180000,
  retries = 1,
}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTimeMs = Date.now();
    const res = await runAgyPromptAsync({ agyBin, stageDir, extraDirs, prompt, timeoutMs });
    const parsedErr = parseAgyFailureMessage(res.code, res.stdout, res.stderr);
    const foundPath = resolveGeneratedImagePath({
      stdout: res.stdout,
      stderr: res.stderr,
      assembledText: res.assembledText,
      conversationId: res.conversationId,
      startTimeMs,
      ignoredPaths,
    });
    if (foundPath && fs.existsSync(foundPath)) {
      return {
        path: foundPath,
        buffer: fs.readFileSync(foundPath),
        ext: path.extname(foundPath).toLowerCase() || '.png',
        elapsedMs: Date.now() - startTimeMs,
        attempts: attempt + 1,
      };
    }
    lastErr = parsedErr || (res.timedOut
      ? makeHumanAiError('TIMEOUT', '单张动作图生成超时。')
      : makeHumanAiError('MODEL_EMPTY', '模型未能返回有效动作图。'));
    // Do not retry auth/invalid-arg/timeout failures
    if (res.timedOut || lastErr.code === 'MODEL_AUTH' || lastErr.code === 'MODEL_INVALID_ARGS') {
      break;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 2500 + Math.floor(Math.random() * 1500)));
    }
  }
  throw lastErr || makeHumanAiError('MODEL_EMPTY', '模型未能返回有效动作图。');
}

async function runWithConcurrency(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const maxWorkers = Math.max(1, Math.min(concurrency, items.length));
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
  return results;
}

/**
 * Two-stage multi-sheet AI desktop-pet generator:
 *   Stage A: Generate 1 crisp 2x2 Identity & Style Anchor (front, right_side, curled_sleep, slim_scruff_hold)
 *            matching styleRefPath + subjectFiles.
 *   Stage B: Generate ALL dynamic action sprite sheets in parallel conditioned on Stage A's anchor
 *            (R01 run+butterfly, optional independent R02 if asymmetric, R00+R03 blink/nod, R04 5-stage jump,
 *             R04H 3-frame classic ultra-slim vertical scruff-hold, R05 smooth 8-frame puzzled tilt without ?,
 *             R06+R08 curled sleep & attentive reading, R07 6-frame pink yarn play, R09 & R10 16-dir clockwise gaze).
 *
 * Graceful degradation: if any individual Stage B sheet fails, ONLY that row falls back cleanly to
 * the upgraded local synthesizer in `three-view-builder.py` (powered by Stage A's 4 anchors!).
 */
async function generateStylizedActionPack({
  subjectFiles,
  styleRefPath = '',
  styleAtlasPath = '',
  variantName = '',
  asymmetric = false,
  pyBin = '',
  concurrency = Number(process.env.HACHIMI_AI_CONCURRENCY || 5),
  stageRoot = path.join(os.homedir(), '.hachimi-pet', 'cache'),
  skipStageB = false,
}) {
  const agyBin = resolveAgyBinary();
  if (!agyBin) {
    throw makeHumanError('MODEL_UNAVAILABLE', '未找到本机 Antigravity 模型命令（agy），暂时无法使用模型协助生成。');
  }

  const totalStartMs = Date.now();
  fs.mkdirSync(stageRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(stageRoot, 'ai-pack-'));
  try {
    const resolvedPy = resolvePythonPilBinary(pyBin);
    const stagedStyle = path.join(stageDir, 'style_reference.png');
    let hasStyleRef = false;
    let resolvedStyleAtlas = (styleAtlasPath && fs.existsSync(styleAtlasPath)) ? styleAtlasPath : '';

    if (styleRefPath && fs.existsSync(styleRefPath)) {
      if (detectIsCodex8x11Atlas(resolvedPy, styleRefPath)) {
        if (!resolvedStyleAtlas) resolvedStyleAtlas = styleRefPath;
        hasStyleRef = exportVariantStyleAnchorPng(resolvedPy, styleRefPath, '', stagedStyle);
      } else {
        fs.copyFileSync(styleRefPath, stagedStyle);
        hasStyleRef = true;
      }
    } else if (resolvedStyleAtlas) {
      hasStyleRef = exportVariantStyleAnchorPng(resolvedPy, resolvedStyleAtlas, '', stagedStyle);
    }

    const subjectSheet = path.join(stageDir, 'subject_reference_sheet.png');
    buildSubjectReferenceSheet(resolvedPy, subjectFiles, subjectSheet);

    // ------------------------------------------------------------------
    // STAGE A: Canonical 2x2 Identity & Style Anchor (Front / Side / Sleep / Scruff-Hold)
    // ------------------------------------------------------------------
    const stageAStartMs = Date.now();
    const stageAImagePaths = hasStyleRef ? [stagedStyle, subjectSheet] : [subjectSheet];
    const stageADescs = hasStyleRef
      ? [
          `- Image #1 (\`${stagedStyle}\`) is the **2D Art Style Benchmark** (match this exact hand-illustrated lineart weight, soft painterly/cel shading, cute head-to-body chibi proportions, and expressive facial style — NEVER copy Image #1's fur markings/colors!).`,
          `- Image #2 (\`${subjectSheet}\`) is the **Real Subject Reference (${subjectFiles.length} view(s) for ${variantName || 'new pet'})** (faithfully capture 100% of this character's exact species, coat colors, stripes/patches, asymmetry, ear shape, eye color, nose, paws, and tail!).`,
        ]
      : [
          `- Image #1 (\`${subjectSheet}\`) is the **Real Subject Reference (${subjectFiles.length} view(s) for ${variantName || 'new pet'})** — redraw into a cohesive cute 2D hand-illustrated desktop pet with crisp dark charcoal-brown outlines and soft painterly cel-shading (NO raw photo cutouts!).`,
        ];

    const stageAPrompt = buildSingleCallPrompt({
      roleTitle: '2x2 character identity & style anchor sheet',
      imagePaths: stageAImagePaths,
      imageName: 'stylized_identity_anchor_2x2',
      imageDescriptions: stageADescs,
      layoutInstruction: '`1:1` square **`2×2` four-quadrant character identity anchor grid** on pure flat `#00FF00` chroma-key green',
      frameInstructions: [
        '- **Top-Left quadrant (FRONT SEATED)**: Canonical front-facing upright seated character looking straight at the viewer, BOTH front paws neatly planted together on the ground, tail curled calmly low on viewer-RIGHT, expressive open eyes.',
        '- **Top-Right quadrant (SIDE RUNNING PROFILE)**: Right-facing (`+X`) energetic full-body side profile trotting/running stride, full head, torso, four legs, and tail cleanly inside top-right quadrant.',
        '- **Bottom-Left quadrant (COZY CURLED SLEEP)**: Character curled up compactly and peacefully sleeping/loafing low on the ground (`wide low oval silhouette`), eyes gently closed in restful sleep (NOT sitting upright, NOT a back view!).',
        '- **Bottom-Right quadrant (SLIM VERTICAL SCRUFF-HOLD)**: Character floating in a **ultra-slim narrow elongated vertical dangling strip** as if lifted invisibly by the back of the neck scruff (ears/head at top facing forward, narrow vertical torso, front and hind legs dangling straight down limply in a tall thin vertical silhouette; NOT sitting, NOT waving; **ABSOLUTELY NO human hand, NO fingers, NO arm, NO collar, NO leash — invisible lift only!**).',
        '- **Strict Quadrant Spatial Budget**: ALL 4 poses MUST fit strictly inside their own quadrant (`Top row: y < 46%`, `Bottom row: y > 54%`, `Left col: x < 46%`, `Right col: x > 54%`). Scale the **Bottom-Right `hold` pose** so it fits strictly inside the bottom-right quadrant (`y > 54%`, NEVER extending upward into the top half) — keeping a 100% clean, unbroken empty `#00FF00` horizontal band across the center `46%..54%` AND vertical band across `46%..54%`!',
        '- Leave WIDE `>= 12%` empty `#00FF00` green cross-gutters between all 4 quadrants so nothing touches!',
      ],
    });

    const stageARes = await runSingleSheetJob({
      agyBin,
      stageDir,
      prompt: stageAPrompt,
      ignoredPaths: stageAImagePaths,
      timeoutMs: 240000,
      retries: 1,
    });
    const stageAMs = Date.now() - stageAStartMs;

    const splitFiles = splitStylizedSheetToSingles(resolvedPy, stageARes.path);
    const byKey = {};
    for (const f of splitFiles) {
      if (f.anchorKey && !byKey[f.anchorKey]) byKey[f.anchorKey] = f;
    }
    const frontFile = byKey.front || splitFiles[0];
    const sideFile = byKey.side || splitFiles[1] || null;
    const sleepFile = byKey.sleep || null;
    const holdFile = byKey.hold || null;

    // Save clean Stage A singles to disk for Stage B reference conditioning
    const anchorsDir = path.join(stageDir, 'anchors');
    fs.mkdirSync(anchorsDir, { recursive: true });
    const frontAnchorPath = path.join(anchorsDir, 'front.png');
    fs.writeFileSync(frontAnchorPath, frontFile.buffer);
    let sideAnchorPath = '';
    if (sideFile) {
      sideAnchorPath = path.join(anchorsDir, 'side.png');
      fs.writeFileSync(sideAnchorPath, sideFile.buffer);
    }
    let sleepAnchorPath = '';
    if (sleepFile) {
      sleepAnchorPath = path.join(anchorsDir, 'sleep.png');
      fs.writeFileSync(sleepAnchorPath, sleepFile.buffer);
    }
    let holdAnchorPath = '';
    if (holdFile) {
      holdAnchorPath = path.join(anchorsDir, 'hold.png');
      fs.writeFileSync(holdAnchorPath, holdFile.buffer);
    }

    // Primary files passed into three-view-builder.py's base classifier (ONLY front + side, so sleep/hold NEVER misroute into R08!)
    const primaryFiles = [
      { name: 'stylized_front.png', buffer: frontFile.buffer, roleHint: 'front' },
    ];
    if (sideFile) {
      primaryFiles.push({
        name: 'stylized_side.png',
        buffer: sideFile.buffer,
        roleHint: sideFile.roleHint || 'right_side',
      });
    }

    const aiSheets = {};
    if (sleepFile) {
      aiSheets.anchor_sleep = { name: 'anchor_sleep.png', buffer: sleepFile.buffer, ext: '.png' };
    }
    if (holdFile) {
      aiSheets.anchor_hold = { name: 'anchor_hold.png', buffer: holdFile.buffer, ext: '.png' };
    }

    const stageBStartMs = Date.now();
    const succeededSheets = [];
    const failedSheets = [];

    if (!skipStageB) {
      const refsDir = path.join(stageDir, 'refs');
      const refs = prepareStageBReferences(resolvedPy, {
        frontPath: frontAnchorPath,
        sidePath: sideAnchorPath,
        sleepPath: sleepAnchorPath,
        holdPath: holdAnchorPath,
        styleAtlasPath: resolvedStyleAtlas,
        refsDir,
      });

      const frontRef = refs.anchor_front_white || frontAnchorPath;
      const frontSideRef = refs.anchor_front_side_white || frontRef;
      const frontSleepRef = refs.anchor_front_sleep_white || frontRef;
      const frontHoldRef = refs.anchor_front_hold_white || frontRef;

      const poseGuideNote = (guidePath, propNote = '') =>
        guidePath
          ? `- Image #2 (\`${guidePath}\`) is a **monochrome POSE & GRID LAYOUT GUIDE ONLY** — copy ONLY the grid cell arrangement, body poses, stride/jump phases, head angles, and scale rhythm${propNote ? ` (${propNote})` : ''}; draw 100% Image #1's character species, markings, colors, ears, eyes, and art style!`
          : `- Image #2 (\`${subjectSheet}\`) shows the original subject photos to keep all markings and proportions 100% accurate.`;

      const jobs = [
        {
          key: 'r01',
          cols: 4,
          rows: 2,
          imagePaths: [frontSideRef, refs.guide_r01 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '8-frame rightward running/galloping sprite sheet (R01)',
            imagePaths: [frontSideRef, refs.guide_r01 || subjectSheet],
            imageName: 'sheet_r01_run_right8',
            imageDescriptions: [
              `- Image #1 (\`${frontSideRef}\`) is the **STRICT Character & Style Anchor** (front + right side profile — match exact colors, markings, face, tail, and 2D art style!).`,
              poseGuideNote(refs.guide_r01, 'plus a small bright yellow butterfly fluttering just ahead on the right'),
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames, row-major) on pure flat `#00FF00`',
            frameInstructions: [
              '- ALL 8 frames show the character genuinely **RUNNING & GALLOPING energetically toward the RIGHT (`+X`)** chasing a small bright yellow butterfly fluttering just ahead of its nose on the right!',
              '- **Row 1**: (1) low stalking/pounce gather crouch -> (2) powerful hind-leg push-off stride -> (3) full horizontal airborne gallop stretch (all 4 legs extended!) -> (4) playful high airborne leap batting toward the yellow butterfly.',
              '- **Row 2**: (5) fast low forward lunge stretch -> (6) springy dynamic mid-run push-off -> (7) buoyant elevated stride chasing butterfly -> (8) energetic forward landing stride looping seamlessly back to frame 1.',
              '- Maintain 100% uniform body/head scale across all 8 frames; keep legs dynamically flexing/extending (NEVER copy-paste the same static standing pose!).',
            ],
          }),
        },
        ...(asymmetric
          ? [{
              key: 'r02',
              cols: 4,
              rows: 2,
              imagePaths: [frontSideRef, refs.guide_r02 || subjectSheet],
              prompt: buildSingleCallPrompt({
                roleTitle: '8-frame leftward running/galloping sprite sheet (R02 — asymmetric markings)',
                imagePaths: [frontSideRef, refs.guide_r02 || subjectSheet],
                imageName: 'sheet_r02_run_left8',
                imageDescriptions: [
                  `- Image #1 (\`${frontSideRef}\`) is the **STRICT Character & Style Anchor** (preserve exact asymmetric left-side coat markings without mirroring!).`,
                  poseGuideNote(refs.guide_r02, 'plus a small bright yellow butterfly fluttering ahead on the left'),
                ],
                layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames, row-major) on pure flat `#00FF00`',
                frameInstructions: [
                  '- ALL 8 frames show the character genuinely **RUNNING & GALLOPING energetically toward the LEFT (`-X`)** chasing a small bright yellow butterfly fluttering ahead of its nose on the left!',
                  '- **Row 1**: gather crouch -> hind-leg push-off -> full airborne gallop stretch -> playful leap batting at butterfly.',
                  '- **Row 2**: fast low forward dash -> springy push-off bound -> buoyant stride -> energetic landing looping smoothly to frame 1.',
                  '- Keep asymmetric face/body patches anatomically faithful on the character\'s true left flank!',
                ],
              }),
            }]
          : []),
        {
          key: 'r00_r03',
          cols: 4,
          rows: 2,
          imagePaths: [frontRef, subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '2-row seated idle-blink (R00) + polite-nod (R03) sprite sheet',
            imagePaths: [frontRef, subjectSheet],
            imageName: 'sheet_r00_r03_blink_nod',
            imageDescriptions: [
              `- Image #1 (\`${frontRef}\`) is the **STRICT Character & Style Anchor** — every frame MUST keep this EXACT front seated body, BOTH front paws planted on the ground, and tail curled low on viewer-RIGHT!`,
              `- Image #2 (\`${subjectSheet}\`) confirms true eye color and facial markings.`,
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames) on pure flat `#00FF00`',
            frameInstructions: [
              '- **TOP ROW (4 frames = R00 Idle Breathing & Gentle Eye Blink)** — rock-steady seated body identical to Image #1:',
              '  * Col 1: Calm upright alert pose with eyes wide open (identical to Image #1).',
              '  * Col 2: Soft relaxed half-closed eyelids (mid-blink) with tiny gentle breath.',
              '  * Col 3: Peaceful fully closed eyes (clean curved closed-eyelid blink arcs, serene expression).',
              '  * Col 4: Softly opening eyes (three-quarter open) returning warmly to alert.',
              '- **BOTTOM ROW (4 frames = R03 Polite Greeting Nod + Smile-Blink)** — BOTH front paws stay planted neatly on ground (NO paw waving or lifting!):',
              '  * Col 1: Upright polite neutral alert, open eyes.',
              '  * Col 2: Gentle friendly head nod slightly downward (~5%) with half-closed smiling eyelids.',
              '  * Col 3: Sweet polite deeper head nod (~8% downward dip) with both eyes happily closed in gentle curved smile-blink arcs.',
              '  * Col 4: Smoothly lifting head back upright with warm open eyes.',
            ],
          }),
        },
        {
          key: 'r04',
          cols: 3,
          rows: 2,
          imagePaths: [frontSideRef, refs.guide_r04 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '5-stage natural jump sprite sheet (R04)',
            imagePaths: [frontSideRef, refs.guide_r04 || subjectSheet],
            imageName: 'sheet_r04_jump5',
            imageDescriptions: [
              `- Image #1 (\`${frontSideRef}\`) is the **STRICT Character & Style Anchor**.`,
              poseGuideNote(refs.guide_r04),
            ],
            layoutInstruction: '`16:9` widescreen **`3×2` grid with EXACTLY 5 jump frames (bottom-right 6th slot 100% EMPTY `#00FF00`)** on pure flat `#00FF00`',
            frameInstructions: [
              '- **Top Row Col 1 (c0 CROUCH)**: Coiled low 4-paw crouch/anticipation leaning forward ready to leap (body compressed low, NOT sitting upright!).',
              '- **Top Row Col 2 (c1 LAUNCH)**: Explosive upward takeoff stretch — front paws reaching high diagonally up, hind legs pushing off!',
              '- **Top Row Col 3 (c2 APEX)**: Graceful mid-air jump apex — all 4 paws lifted/tucked cleanly off the ground, tail curved!',
              '- **Bottom Row Col 1 (c3 DESCENT)**: Diving downward landing approach — front paws extended downward toward ground, hind legs & tail trailing up.',
              '- **Bottom Row Col 2 (c4 LAND)**: Soft cushioned 4-paw landing absorbing impact low to ground.',
              '- **Bottom Row Col 3 (EMPTY)**: Leave 100% solid empty `#00FF00` green — draw NOTHING in the 6th slot!',
            ],
          }),
        },
        {
          key: 'r04h',
          cols: 3,
          rows: 1,
          imagePaths: [frontHoldRef, refs.guide_r04h || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '3-frame slim vertical scruff-held dangling sprite strip (R04H)',
            imagePaths: [frontHoldRef, refs.guide_r04h || subjectSheet],
            imageName: 'sheet_r04h_hold3',
            imageDescriptions: [
              `- Image #1 (\`${frontHoldRef}\`) shows the **STRICT Character & Style Anchor** (front face + slim scruff-held pose).`,
              poseGuideNote(refs.guide_r04h, 'ultra-slim vertical elongated scruff-dangled strip'),
            ],
            layoutInstruction: '`16:9` widescreen **`3×1` horizontal strip** (3 tall slim frames side-by-side) on pure flat `#00FF00`',
            frameInstructions: [
              '- ALL 3 frames depict the character floating as an **ULTRA-SLIM, TALL, ELONGATED VERTICAL DANGLING STRIP** facing forward (narrow relaxed body, front paws drooping limply down, hind legs & tail hanging straight down — NEVER sitting, NEVER wide, and **ABSOLUTELY NO human hand, NO fingers, NO arm, NO collar, NO leash — invisible scruff lift only!**).',
              '- **Col 1 (c5 PLUMB STRAIGHT)**: Hanging straight down vertically like a slim plumb line (`一条`).',
              '- **Col 2 (c6 SWAY VIEWER-LEFT)**: Head/scruff pinned at top center, lower torso, dangling hind legs, and tail curving/swaying smoothly toward **viewer-LEFT**.',
              '- **Col 3 (c7 SWAY VIEWER-RIGHT)**: Head/scruff pinned at top center, lower torso, dangling hind legs, and tail curving/swaying smoothly toward **viewer-RIGHT**.',
              '- Keep head size, vertical length, and slim width 100% consistent across all 3 frames!',
            ],
          }),
        },
        {
          key: 'r05',
          cols: 4,
          rows: 2,
          imagePaths: [frontRef, refs.guide_r05 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '8-frame smooth continuous puzzled head-tilt sprite sheet (R05)',
            imagePaths: [frontRef, refs.guide_r05 || subjectSheet],
            imageName: 'sheet_r05_puzzled8',
            imageDescriptions: [
              `- Image #1 (\`${frontRef}\`) is the **STRICT Character & Style Anchor** (exact seated body, planted paws, tail low on viewer-RIGHT, exact shading & whiskers).`,
              `- Image #2 (\`${refs.guide_r05 || subjectSheet}\`) shows the **EXACT smooth single-peak head-tilt angle progression** (0°, 4°, 8°, 12°, 15°, 11°, 7°, 4° tilting smoothly toward viewer-LEFT while the seated body stays 100% stationary!).`,
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames, row-major) on pure flat `#00FF00`',
            frameInstructions: [
              '- **ABSOLUTELY ZERO question mark `?` symbols or speech bubbles anywhere in the artwork!** (Crisp `?` bubbles are composited separately afterward.)',
              '- Seated torso, front paws, and viewer-right tail stay 100% identical and motionless across all 8 frames; ONLY the head tilts smoothly:',
              '- **Row 1**: (c0) `0°` completely upright alert -> (c1) TINY `4°` start of tilt to viewer-LEFT -> (c2) gentle `8°` curious tilt -> (c3) clear `12°` puzzled tilt with curious wide eyes.',
              '- **Row 2**: (c4) peak `15°` adorable puzzled head tilt to viewer-LEFT -> (c5) smoothly easing back to `11°` -> (c6) gentle `7°` return -> (c7) TINY `4°` lingering tilt (almost upright, so looping c7 -> c0 has ZERO snap!).',
            ],
          }),
        },
        {
          key: 'r06_r08',
          cols: 4,
          rows: 2,
          imagePaths: [frontSleepRef, subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '2-row curled sleep (R06) + attentive front reading (R08) sprite sheet',
            imagePaths: [frontSleepRef, subjectSheet],
            imageName: 'sheet_r06_r08_sleep_read',
            imageDescriptions: [
              `- Image #1 (\`${frontSleepRef}\`) shows the **STRICT Character & Style Anchor** (left: front seated pose for Row 2; right: cozy curled sleep pose for Row 1).`,
              `- Image #2 (\`${subjectSheet}\`) confirms true markings and colors.`,
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames) on pure flat `#00FF00`',
            frameInstructions: [
              '- **TOP ROW (4 frames = R06 Cozy Curled Sleeping / Resting)**:',
              '  * Character curled up tightly and peacefully asleep low on the floor (wide low oval silhouette matching Image #1 right, eyes gently closed, paws tucked, tail wrapped cozily; NEVER sitting upright, NEVER waving a paw!).',
              '  * Col 1 -> Col 4: Calm slow sleeping breathing cycle (gentle soft rise and settle of chest/back + subtle ear twitch on Col 3).',
              '- **BOTTOM ROW (4 frames = R08 Calm Attentive Front Reading & Blink)**:',
              '  * Front-facing upright seated character matching Image #1 LEFT\'s **EXACT seated silhouette & left/right orientation 1:1** — keep chest/front paws on the SAME side and back/haunch/curled tail on the SAME viewer-RIGHT side as Image #1 LEFT (**NEVER mirror the seated torso, NEVER put the haunch or tail on viewer-LEFT, NEVER draw a back view!**).',
              '  * Col 1: Calm attentive seated pose looking gently slightly downward-forward as if reading.',
              '  * Col 2: Slightly deeper attentive downward gaze focused calmly ahead.',
              '  * Col 3: Peaceful soft half-closed/closed reading blink while looking slightly downward.',
              '  * Col 4: Gently opening eyes back to calm attentive reading gaze.',
            ],
          }),
        },
        {
          key: 'r07',
          cols: 3,
          rows: 2,
          imagePaths: [frontSideRef, refs.guide_r07 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '6-frame active pink yarn-ball play sprite sheet (R07)',
            imagePaths: [frontSideRef, refs.guide_r07 || subjectSheet],
            imageName: 'sheet_r07_yarn6',
            imageDescriptions: [
              `- Image #1 (\`${frontSideRef}\`) is the **STRICT Character & Style Anchor**.`,
              poseGuideNote(refs.guide_r07, 'keep the toy a crisp, solid, bright pink wound yarn ball with dark outline!'),
            ],
            layoutInstruction: '`16:9` widescreen **`3×2` grid** (3 columns × 2 rows = 6 frames, row-major) on pure flat `#00FF00`',
            frameInstructions: [
              '- ALL 6 frames show the character **ACTIVELY PLAYING with a bright pink yarn ball** on the floor (lively paw swatting, rolling, catching, pouncing — NEVER sitting passively motionless!):',
              '- **Top Row**: (c0) crouched playfully raising one front paw poised to swat the bright pink yarn ball -> (c1) extending front paw forward batting/rolling the pink yarn ball -> (c2) leaning forward tapping the rolling pink yarn ball.',
              '- **Bottom Row**: (c3) crouched low catching and gripping the pink yarn ball between both front paws -> (c4) playful joyful mini-pounce with tail flicked up while holding the pink yarn ball -> (c5) rising smoothly cradling the pink yarn ball ready to bat again.',
              '- Maintain 100% consistent character size and crisp bright pink yarn ball across all 6 frames!',
            ],
          }),
        },
        {
          key: 'r09',
          cols: 4,
          rows: 2,
          imagePaths: [frontRef, refs.guide_r09 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '8-frame clockwise right-semicircle seated gaze sprite sheet (R09: 0°..157.5°)',
            imagePaths: [frontRef, refs.guide_r09 || subjectSheet],
            imageName: 'sheet_r09_gaze_right8',
            imageDescriptions: [
              `- Image #1 (\`${frontRef}\`) is the **STRICT Character & Style Anchor** — the seated front torso, planted front paws, and viewer-right tail MUST remain stationary and front-facing in ALL 8 frames!`,
              poseGuideNote(refs.guide_r09, 'exact clockwise 0° UP -> 90° RIGHT -> 157.5° DOWN-RIGHT head directions'),
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames, row-major) on pure flat `#00FF00`',
            frameInstructions: [
              '- Keep the seated body front-facing and stationary across ALL 8 frames (NEVER turn into a walking side-profile cat or a back view!). ONLY the head & eyes turn smoothly clockwise through the RIGHT semicircle:',
              '- **Top Row**:',
              '  * Col 1 (0° UP / 12:00): Head centered frontally, chin lifted high, nose & eyes looking straight UP.',
              '  * Col 2 (22.5° UP-RIGHT / 12:45): Head turned slightly toward viewer-right and tilted upward.',
              '  * Col 3 (45° UPPER-RIGHT / 1:30): Head turned ~45° toward viewer-right (3/4 right) looking clearly upper-right.',
              '  * Col 4 (67.5° RIGHT-UP / 2:15): Head turned ~70° toward viewer-right with slight upward chin tilt.',
              '- **Bottom Row**:',
              '  * Col 1 (90° RIGHT / 3:00): Head turned cleanly 90° in crisp right-facing profile looking horizontally RIGHT while torso stays front-seated!',
              '  * Col 2 (112.5° RIGHT-DOWN / 3:45): Head turned ~75° to viewer-right, tilted slightly downward.',
              '  * Col 3 (135° LOWER-RIGHT / 4:30): Head turned ~45° to viewer-right and bowed downward looking lower-right.',
              '  * Col 4 (157.5° DOWN-RIGHT / 5:15): Head bowed steeply downward and turned slightly viewer-right looking down-right.',
            ],
          }),
        },
        {
          key: 'r10',
          cols: 4,
          rows: 2,
          imagePaths: [frontRef, refs.guide_r10 || subjectSheet],
          prompt: buildSingleCallPrompt({
            roleTitle: '8-frame clockwise left-semicircle seated gaze sprite sheet (R10: 180°..337.5°)',
            imagePaths: [frontRef, refs.guide_r10 || subjectSheet],
            imageName: 'sheet_r10_gaze_left8',
            imageDescriptions: [
              `- Image #1 (\`${frontRef}\`) is the **STRICT Character & Style Anchor** — the seated front torso, planted front paws, and viewer-right tail MUST remain stationary and front-facing in ALL 8 frames!`,
              poseGuideNote(refs.guide_r10, 'exact clockwise 180° DOWN -> 270° LEFT -> 337.5° UP-LEFT head directions'),
            ],
            layoutInstruction: '`16:9` widescreen **`4×2` grid** (4 columns × 2 rows = 8 frames, row-major) on pure flat `#00FF00`',
            frameInstructions: [
              '- Keep the seated body front-facing and stationary across ALL 8 frames (NEVER turn into a walking side-profile cat or a back view!). ONLY the head & eyes turn smoothly clockwise through the LEFT semicircle:',
              '- **Top Row**:',
              '  * Col 1 (180° DOWN / 6:00): Head centered symmetrically and bowed straight DOWN toward the front paws.',
              '  * Col 2 (202.5° DOWN-LEFT / 6:45): Head bowed steeply downward and turned ~20° toward viewer-left.',
              '  * Col 3 (225° LOWER-LEFT / 7:30): Head turned ~45° to viewer-left and bowed downward looking lower-left.',
              '  * Col 4 (247.5° LEFT-DOWN / 8:15): Head turned ~70° to viewer-left tilted slightly downward.',
              '- **Bottom Row**:',
              '  * Col 1 (270° LEFT / 9:00): Head turned cleanly 90° in crisp left-facing profile looking horizontally LEFT while torso stays front-seated!',
              '  * Col 2 (292.5° LEFT-UP / 9:45): Head turned ~70° toward viewer-left tilted slightly upward.',
              '  * Col 3 (315° UPPER-LEFT / 10:30): Head turned ~45° to viewer-left (3/4 left) tilted upward looking upper-left.',
              '  * Col 4 (337.5° UP-LEFT / 11:15): Head turned ~20° toward viewer-left and lifted high upward looking steeply up-left.',
            ],
          }),
        },
      ];

      const effectiveConcurrency = Math.max(1, Math.min(6, Number(concurrency) || 5));
      await runWithConcurrency(jobs, effectiveConcurrency, async (job) => {
        const jobDir = path.join(stageDir, `job_${job.key}`);
        fs.mkdirSync(jobDir, { recursive: true });
        try {
          const out = await runSingleSheetJob({
            agyBin,
            stageDir: jobDir,
            extraDirs: [stageDir],
            prompt: job.prompt,
            ignoredPaths: job.imagePaths,
            timeoutMs: 180000,
            retries: 2,
          });
          aiSheets[job.key] = {
            name: `${job.key}${out.ext}`,
            buffer: out.buffer,
            ext: out.ext,
            cols: job.cols,
            rows: job.rows,
            elapsedMs: out.elapsedMs,
          };
          succeededSheets.push(job.key);
        } catch (err) {
          console.error(`[ai-style-generator] Stage B sheet "${job.key}" failed (graceful fallback):`, err?.message || err);
          failedSheets.push({ key: job.key, code: err?.code || 'FAILED', error: String(err?.message || err) });
        }
      });
    }

    const stageBMs = Date.now() - stageBStartMs;
    return {
      files: primaryFiles,
      allAnchorFiles: splitFiles,
      aiSheets,
      buffer: stageARes.buffer,
      ext: stageARes.ext,
      name: 'stylized_turnaround' + stageARes.ext,
      summary: {
        totalElapsedMs: Date.now() - totalStartMs,
        stageAMs,
        stageBMs,
        asymmetric: Boolean(asymmetric),
        succeededSheets,
        failedSheets,
        usedStyleAtlas: Boolean(resolvedStyleAtlas),
      },
    };
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Preserve exact exported name for backward compatibility (bridge-server.cjs & callers)
async function generateStylizedTurnaround(opts) {
  return generateStylizedActionPack(opts);
}

const ROW_ACTION_DESCRIPTIONS = {
  0: {
    count: 6,
    layout: '3×2 grid (3 columns × 2 rows = 6 frames, row-major)',
    aspect: '16:9',
    desc: 'front-seated calm idle breathing & gentle eye blink cycle (c0 open alert -> c1 subtle breath -> c2 half-blink -> c3 peaceful closed-eye blink -> c4 softly opening eyes -> c5 calm open return), upright stationary body & tail on viewer-right',
  },
  1: {
    count: 8,
    layout: '4×2 grid (4 columns × 2 rows = 8 frames, row-major)',
    aspect: '16:9',
    desc: 'lively 8-frame rightward running/galloping cycle facing RIGHT (+X) chasing a small bright yellow butterfly on the right (gather crouch -> push-off -> full aerial gallop stretch -> playful leap batting at butterfly -> low dash -> bound -> stride -> landing), uniform character scale',
  },
  2: {
    count: 8,
    layout: '4×2 grid (4 columns × 2 rows = 8 frames, row-major)',
    aspect: '16:9',
    desc: 'lively 8-frame leftward running/galloping cycle facing LEFT (-X) chasing a small bright yellow butterfly on the left (gather crouch -> push-off -> full aerial gallop stretch -> playful leap batting at butterfly -> low dash -> bound -> stride -> landing), uniform character scale',
  },
  3: {
    count: 4,
    layout: '2×2 grid (2 columns × 2 rows = 4 frames, row-major)',
    aspect: '1:1',
    desc: 'polite gentle head nod + smile-blink greeting (BOTH front paws planted on ground, NO paw raise; c0 upright alert -> c1 slight 5% nod + half-blink -> c2 sweet 8% nod + happy curved closed-eye blink -> c3 smooth lift back upright), rock-steady seated body',
  },
  4: {
    count: 5,
    layout: '3×2 grid with EXACTLY 5 jump frames in slots 1..5 and bottom-right 6th slot 100% EMPTY #00FF00',
    aspect: '16:9',
    desc: 'natural 5-stage jump sequence: (1) coiled low 4-paw crouch -> (2) explosive upward takeoff stretch -> (3) graceful mid-air apex with paws tucked -> (4) downward descent reaching to land -> (5) soft 4-paw cushioned landing; slot 6 completely EMPTY #00FF00',
  },
  R04H: {
    count: 3,
    layout: '3×1 horizontal strip (3 tall slim frames side-by-side)',
    aspect: '16:9',
    desc: 'classic ULTRA-SLIM vertical elongated dangling strip as if invisibly lifted by the neck scruff (facing forward, narrow relaxed torso & dangling hind legs hanging straight down — NEVER sitting, ABSOLUTELY NO human hand, NO fingers, NO collar, NO leash!): Col 1 straight plumb vertical dangle -> Col 2 head pinned top-center, lower torso/legs/tail pendulum-swayed viewer-LEFT -> Col 3 head pinned top-center, lower torso/legs/tail pendulum-swayed viewer-RIGHT',
  },
  5: {
    count: 8,
    layout: '4×2 grid (4 columns × 2 rows = 8 frames, row-major)',
    aspect: '16:9',
    desc: 'smooth continuous single-peak puzzled head-tilt loop tilting gradually toward viewer-LEFT (0°, 4°, 8°, 12°, 15° peak, 11°, 7°, 4° gentle return so c7->c0 wraps seamlessly with ZERO snap; stationary front-seated body; ABSOLUTELY ZERO ? question mark symbols or bubbles drawn in artwork!)',
  },
  6: {
    count: 6,
    layout: '3×2 grid (3 columns × 2 rows = 6 frames, row-major)',
    aspect: '16:9',
    desc: 'cozy curled-up sleeping/resting breathing cycle low on the ground (compact horizontal curled oval silhouette, eyes peacefully closed, paws tucked, slow calm sleeping breath — NEVER sitting upright, NEVER waving a paw!)',
  },
  7: {
    count: 6,
    layout: '3×2 grid (3 columns × 2 rows = 6 frames, row-major)',
    aspect: '16:9',
    desc: 'lively 6-frame active play batting, rolling, catching, pouncing, and cradling a crisp bright pink wound yarn ball on the floor (dynamic paw interaction on every frame, uniform character scale)',
  },
  8: {
    count: 6,
    layout: '3×2 grid (3 columns × 2 rows = 6 frames, row-major)',
    aspect: '16:9',
    desc: 'calm attentive front-seated downward reading & gentle blink cycle matching Image #1\'s EXACT seated orientation (chest/paws & viewer-right haunch/tail on the SAME side as Image #1 — NEVER mirror torso, NEVER back view; head gently bowed reading attentively with a soft mid-sequence blink)',
  },
  9: {
    count: 8,
    layout: '4×2 grid (4 columns × 2 rows = 8 frames, row-major)',
    aspect: '16:9',
    desc: 'clockwise right-semicircle compass head-turn with rock-steady front-seated body & viewer-right tail (Top row: 0° straight UP, 22.5° UP-R, 45° UPPER-R, 67.5° R-UP; Bottom row: 90° crisp RIGHT profile head, 112.5° R-DN, 135° LOWER-R, 157.5° DN-R — NEVER side-walking body!)',
  },
  10: {
    count: 8,
    layout: '4×2 grid (4 columns × 2 rows = 8 frames, row-major)',
    aspect: '16:9',
    desc: 'clockwise left-semicircle compass head-turn with rock-steady front-seated body & viewer-right tail (Top row: 180° straight DOWN, 202.5° DN-L, 225° LOWER-L, 247.5° L-DN; Bottom row: 270° crisp LEFT profile head, 292.5° L-UP, 315° UPPER-L, 337.5° UP-L — NEVER side-walking body!)',
  },
};

/**
 * Redraw a specific row (including R04H) of an existing character using `agy` + `image-generator`,
 * conditioned on the character's R00 c0 anchor + optional 1 user-uploaded reference image + user instruction.
 */
async function generateRedrawnRowWithModel({
  atlasPath,
  thumbPath,
  row,
  rowCode = '',
  instruction = '',
  asymmetric = false,
  refImageBuffer = null,
  refImageExt = '.png',
  pyBin = '',
  retries = 1,
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

    const normCode = String(rowCode || '').trim().toUpperCase();
    const isHoldSub = normCode === 'R04H';
    const rowSpec = (isHoldSub ? ROW_ACTION_DESCRIPTIONS.R04H : ROW_ACTION_DESCRIPTIONS[row]) || ROW_ACTION_DESCRIPTIONS[0];
    const rowLabel = isHoldSub ? 'R04H' : `R${String(row).padStart(2, '0')}`;
    const expectedOut = path.join(stageDir, 'redrawn_strip.png');
    const rowImagePaths = userRefPath ? [anchorPng, userRefPath] : [anchorPng];
    const asymRule = asymmetric
      ? (row === 2
          ? 'ASYMMETRIC MARKINGS LOCK (CRITICAL): This character has asymmetric fur/face markings. Render the TRUE left-facing side profile matching the Character Anchor anatomy — NEVER horizontally mirror right-side markings!'
          : 'ASYMMETRIC MARKINGS LOCK (CRITICAL): Preserve the exact left-vs-right asymmetric fur patches, face markings, and ear/tail coloring of the Character Anchor without mirroring.')
      : '';

    const prompt = [
      'You are redrawing ONE sprite animation sheet for an existing 2D desktop-pet character.',
      'Do NOT call `schedule`, `manage_task`, `run_command`, `sips`, Figma MCP tools, or any HTML tools.',
      '',
      `Character Style & Identity Anchor (MUST keep 100% identical character design, colors, markings, eye color, proportions, and outline): \`${anchorPng}\``,
      userRefPath ? `Additional User Reference Image: \`${userRefPath}\`` : '',
      instruction ? `User Modification Instruction (HIGHEST PRIORITY): ${instruction}` : '',
      asymRule,
      '',
      `Target Action Row (${rowLabel}): ${rowSpec.desc}`,
      `Required Sheet Layout: \`${rowSpec.aspect}\` **${rowSpec.layout}** on a **100% pure flat \`#00FF00\` chroma-key green background**.`,
      COMMON_SHEET_RULES,
      '',
      'CRITICAL TOOL & SPEED CONSTRAINTS:',
      '- If the built-in `generate_image` tool is directly available in your toolset, call it ONCE; otherwise call `invoke_subagent` on `image-generator` ONCE (NEVER Figma MCP).',
      `- Pass ONLY ${rowImagePaths.length} path(s) in \`ImagePaths\`: ${JSON.stringify(rowImagePaths)} (NEVER > 2) and \`ImageName\`: "redrawn_${rowLabel.toLowerCase()}".`,
      '- Instruct `image-generator` to make STRICTLY ONE generation call (accept the first result immediately, NO v2/v3 retries) and return the exact saved image file path.',
      '- NEVER call `schedule`, NEVER call `manage_task`, NEVER call `run_command`/`sips`, and do NOT call `read_file` on the generated output.',
      '',
      'Steps:',
      `1. Inspect \`${anchorPng}\`${userRefPath ? ` and \`${userRefPath}\`` : ''} using \`read_file\`.`,
      `2. Generate the clean \`#00FF00\` sprite sheet for ${rowLabel} matching the Character Anchor and User Modification Instruction.`,
      '3. If waiting for `image-generator`, end your turn immediately with no `schedule` timer. Once you have the generated image path, reply immediately ONLY with that exact absolute file path.',
    ].filter(Boolean).join('\n');

    const maxRetries = Math.max(0, Number.isFinite(Number(retries)) ? Number(retries) : 1);
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTimeMs = Date.now();
      const { code, stdout, stderr, conversationId, assembledText, timedOut } = await runAgyPromptAsync({ agyBin, stageDir, prompt, timeoutMs: 240000 });
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

      if (foundPath && fs.existsSync(foundPath)) {
        return {
          buffer: fs.readFileSync(foundPath),
          ext: path.extname(foundPath).toLowerCase() || '.png',
        };
      }

      if (parsedErr && parsedErr.code !== 'MODEL_EMPTY') {
        throw parsedErr;
      }
      if (timedOut) {
        lastErr = makeHumanAiError('TIMEOUT', '模型重绘超时了，请稍后再试或简化修改说明。');
      } else {
        lastErr = parsedErr || makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效的重绘图像，请调整说明后重试或直接上传替换图。');
      }
    }

    throw lastErr || makeHumanAiError('MODEL_EMPTY', '模型暂时未能返回有效的重绘图像，请调整说明后重试或直接上传替换图。');
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  resolveAgyBinary,
  exportVariantStyleAnchorPng,
  detectIsCodex8x11Atlas,
  buildSubjectReferenceSheet,
  splitStylizedSheetToSingles,
  prepareStageBReferences,
  extractImagePathsFromText,
  parseStreamJsonSummary,
  findGeneratedBrainImage,
  resolveGeneratedImagePath,
  parseAgyFailureMessage,
  ROW_ACTION_DESCRIPTIONS,
  generateStylizedActionPack,
  generateStylizedTurnaround,
  generateRedrawnRowWithModel,
};
