const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  processCompact4x3PngBuffer,
  processCodex8x11PngBuffer,
  makeThumbFromPngBuffer,
  makeFallbackPawThumbPng,
} = require('./png-codec.cjs');

const VALID_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,48}$/;

function getPacksRoot() {
  return process.env.HACHIMI_PACKS_DIR || path.join(os.homedir(), '.hachimi-pet', 'packs');
}

const BUILTIN_HACHIMI_PACK = {
  id: 'hachimi',
  name: '哈基米',
  slotLabel: '默认形象',
  badgeEmoji: '',
  type: 'whale',
  defaultVariant: 'astral',
  isBuiltin: true,
  variants: [
    { id: 'astral', name: '星瞳紫', label: '星瞳紫', color: '#8B7BF7', thumb: 'thumbs/astral.png', thumbUrl: '/coopanion/whale/thumbs/astral.png', layout: 'whale' },
    { id: 'sakura', name: '樱桃粉', label: '樱桃粉', color: '#F472B6', thumb: 'thumbs/sakura.png', thumbUrl: '/coopanion/whale/thumbs/sakura.png', layout: 'whale' },
    { id: 'azure', name: '苍穹蓝', label: '苍穹蓝', color: '#38BDF8', thumb: 'thumbs/azure.png', thumbUrl: '/coopanion/whale/thumbs/azure.png', layout: 'whale' },
    { id: 'emerald', name: '森灵翠', label: '森灵翠', color: '#34D399', thumb: 'thumbs/emerald.png', thumbUrl: '/coopanion/whale/thumbs/emerald.png', layout: 'whale' },
    { id: 'amber', name: '流光金', label: '流光金', color: '#F59E0B', thumb: 'thumbs/amber.png', thumbUrl: '/coopanion/whale/thumbs/amber.png', layout: 'whale' },
    { id: 'crimson', name: '绯夜红', label: '绯夜红', color: '#FB7185', thumb: 'thumbs/crimson.png', thumbUrl: '/coopanion/whale/thumbs/crimson.png', layout: 'whale' },
    { id: 'arctic', name: '霜月银', label: '霜月银', color: '#94A3B8', thumb: 'thumbs/arctic.png', thumbUrl: '/coopanion/whale/thumbs/arctic.png', layout: 'whale' },
    { id: 'obsidian', name: '暗夜黑', label: '暗夜黑', color: '#6366F1', thumb: 'thumbs/obsidian.png', thumbUrl: '/coopanion/whale/thumbs/obsidian.png', layout: 'whale' },
  ],
};

function cloneBuiltinPack() {
  return {
    ...BUILTIN_HACHIMI_PACK,
    variants: BUILTIN_HACHIMI_PACK.variants.map((v) => ({ ...v })),
  };
}

function isValidPackId(id) {
  return typeof id === 'string' && VALID_ID_REGEX.test(id);
}

function cleanRelAssetPath(relPath) {
  if (typeof relPath !== 'string') return '';
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return '';
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return '';
  return parts.join('/');
}

function encodeUrlPath(relPath) {
  return relPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function writeJsonAtomic(filePath, doc) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.tmp_${path.basename(filePath)}_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function copyDirOrFileSync(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) {
        copyDirOrFileSync(s, d);
      } else if (ent.isFile()) {
        fs.copyFileSync(s, d);
      }
    }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function sanitizeDisplayName(rawName, emptyMessage = '名称不能为空，请先输入名称。') {
  const cleaned = String(rawName ?? '')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    throw makeHumanError('INVALID_NAME', emptyMessage);
  }
  if (Array.from(cleaned).length > 48) {
    throw makeHumanError('INVALID_NAME', '名称请控制在 48 个字以内。');
  }
  return cleaned;
}

function safeFileMtimeTag(filePath) {
  if (!filePath) return '';
  try {
    const st = fs.statSync(filePath);
    if (st && st.isFile()) return String(Math.floor(st.mtimeMs));
  } catch { /* ignore */ }
  return '';
}

function normalizeVariant(packId, raw, packDir = '') {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!isValidPackId(id)) return null;

  const layoutRaw = String(raw.layout || 'compact-4x3').trim();
  const layout = ['compact-4x3', 'single-image', 'codex-v2-8x11'].includes(layoutRaw)
    ? layoutRaw
    : 'compact-4x3';

  const defaultCols = layout === 'codex-v2-8x11' ? 8 : layout === 'compact-4x3' ? 4 : 1;
  const defaultRows = layout === 'codex-v2-8x11' ? 11 : layout === 'compact-4x3' ? 3 : 1;

  const rawAsset = cleanRelAssetPath(raw.asset || raw.spritesheet || raw.spritesheetPath || `${id}/spritesheet.webp`);
  const rawThumb = cleanRelAssetPath(raw.thumb || raw.thumbPath || `thumbs/${id}.png`);
  const displayName = String(raw.name || raw.label || raw.displayName || id).trim() || id;

  const thumbTag = (packDir && rawThumb) ? safeFileMtimeTag(path.join(packDir, rawThumb)) : '';
  const assetTag = (packDir && rawAsset) ? safeFileMtimeTag(path.join(packDir, rawAsset)) : '';

  return {
    id,
    name: displayName,
    label: displayName,
    color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color.trim()) ? raw.color.trim() : '#F59E0B',
    thumb: rawThumb,
    thumbUrl: rawThumb
      ? `/local-packs/${encodeURIComponent(packId)}/${encodeUrlPath(rawThumb)}${thumbTag ? `?v=${thumbTag}` : ''}`
      : '',
    asset: rawAsset,
    assetUrl: rawAsset
      ? `/local-packs/${encodeURIComponent(packId)}/${encodeUrlPath(rawAsset)}${assetTag ? `?v=${assetTag}` : ''}`
      : '',
    layout,
    frameWidth: Number(raw.frameWidth || raw.cellWidth) || (layout === 'single-image' ? 256 : 192),
    frameHeight: Number(raw.frameHeight || raw.cellHeight) || (layout === 'single-image' ? 256 : 208),
    cols: Number(raw.cols) || defaultCols,
    rows: Number(raw.rows) || defaultRows,
    asymmetric: Boolean(raw.asymmetric),
  };
}

function scanPacks(packsRoot = getPacksRoot()) {
  const localPacks = [];

  try {
    if (fs.existsSync(packsRoot)) {
      const entries = fs.readdirSync(packsRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
        if (ent.name === 'hachimi' || !isValidPackId(ent.name)) continue;

        const packDir = path.join(packsRoot, ent.name);
        const packJsonPath = path.join(packDir, 'pack.json');
        if (!fs.existsSync(packJsonPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
          if (!raw || typeof raw !== 'object') continue;
          const packId = ent.name;
          if (raw.id && String(raw.id).trim() !== packId) {
            if (!isValidPackId(String(raw.id).trim())) continue;
          }

          const rawVariants = Array.isArray(raw.variants) ? raw.variants : [];
          const variants = rawVariants.map((v) => normalizeVariant(packId, v, packDir)).filter(Boolean);
          if (variants.length === 0) continue;

          const defaultVariant = variants.some((v) => v.id === raw.defaultVariant)
            ? raw.defaultVariant
            : variants[0].id;
          const name = String(raw.name || packId).trim() || packId;
          const badgeEmoji = typeof raw.badgeEmoji === 'string' ? raw.badgeEmoji.trim() : '';

          localPacks.push({
            id: packId,
            name,
            slotLabel: name,
            badgeEmoji,
            type: raw.type === 'whale' ? 'whale' : 'sprite',
            defaultVariant,
            isBuiltin: false,
            variants,
          });
        } catch {
          // Skip malformed pack.json cleanly
        }
      }
    }
  } catch {
    // Return built-in pack if scanning fails
  }

  localPacks.sort((a, b) => {
    if (a.id === 'six-cats') return -1;
    if (b.id === 'six-cats') return 1;
    return a.id.localeCompare(b.id);
  });

  return [cloneBuiltinPack(), ...localPacks];
}

function resolveLocalPackFile(packId, relPath, packsRoot = getPacksRoot()) {
  if (!isValidPackId(packId) || packId === 'hachimi') return null;
  const cleaned = cleanRelAssetPath(relPath);
  if (!cleaned) return null;

  const packDir = path.resolve(packsRoot, packId);
  const candidate = path.resolve(packDir, cleaned);
  if (!candidate.startsWith(packDir + path.sep)) return null;

  try {
    const realPackDir = fs.realpathSync(packDir);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(realPackDir + path.sep)) return null;
    if (!fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function resolveThumbFilePath(pack, variantId, appRoot, packsRoot = getPacksRoot()) {
  if (!pack) return '';
  const variant =
    pack.variants?.find((v) => v.id === variantId) ||
    pack.variants?.find((v) => v.id === pack.defaultVariant) ||
    pack.variants?.[0];
  if (!variant) return '';

  if (pack.id === 'hachimi' || pack.type === 'whale') {
    const candidates = [
      path.join(appRoot, 'dist', 'coopanion', 'whale', 'thumbs', `${variant.id}.png`),
      path.join(appRoot, 'public', 'coopanion', 'whale', 'thumbs', `${variant.id}.png`),
      path.join(appRoot, 'dist', 'coopanion', 'whale', 'thumbs', 'astral.png'),
      path.join(appRoot, 'public', 'coopanion', 'whale', 'thumbs', 'astral.png'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch { /* ignore */ }
    }
    return '';
  }

  const fromVariant = variant.thumb ? resolveLocalPackFile(pack.id, variant.thumb, packsRoot) : null;
  if (fromVariant) return fromVariant;

  const defaultVar = pack.variants?.find((v) => v.id === pack.defaultVariant);
  if (defaultVar?.thumb) {
    const fromDefault = resolveLocalPackFile(pack.id, defaultVar.thumb, packsRoot);
    if (fromDefault) return fromDefault;
  }
  return '';
}

let cachedPythonBin = null;
let cachedThreeViewPythonBin = null;
let cachedCwebpBin = null;
const THREE_VIEW_SCRIPT_PATH = path.join(__dirname, 'three-view-builder.py');

function findPythonWithPil() {
  if (cachedPythonBin !== null) return cachedPythonBin;
  const candidates = [
    process.env.HACHIMI_PYTHON,
    '/opt/anaconda3/bin/python3',
    'python3',
    'python',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['-c', 'import PIL.Image; print("ok")'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0 && (res.stdout || '').trim() === 'ok') {
        cachedPythonBin = bin;
        return cachedPythonBin;
      }
    } catch { /* try next */ }
  }
  cachedPythonBin = '';
  return '';
}

function findPythonForThreeView() {
  if (cachedThreeViewPythonBin !== null) return cachedThreeViewPythonBin;
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
        cachedThreeViewPythonBin = bin;
        return cachedThreeViewPythonBin;
      }
    } catch { /* try next */ }
  }
  cachedThreeViewPythonBin = '';
  return '';
}

function findCwebp() {
  if (cachedCwebpBin !== null) return cachedCwebpBin;
  const candidates = [
    process.env.HACHIMI_CWEBP,
    '/opt/homebrew/bin/cwebp',
    'cwebp',
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['-version'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true,
      });
      if (res.status === 0) {
        cachedCwebpBin = bin;
        return cachedCwebpBin;
      }
    } catch { /* try next */ }
  }
  cachedCwebpBin = '';
  return '';
}

const PY_PACK_PROCESSOR = `
import json, sys
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

def is_green_bg(r, g, b, a):
    if a < 16:
        return False
    max_rb = r if r >= b else b
    return g >= 100 and (g - max_rb) >= 38 and r <= 170 and b <= 170

def flood_fill_green_key(im, cols=1, rows=1):
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    border_samples = []
    step_x = max(1, w // 64)
    step_y = max(1, h // 64)
    for x in range(0, w, step_x):
        border_samples.append(px[x, 0])
        border_samples.append(px[x, h - 1])
    for y in range(0, h, step_y):
        border_samples.append(px[0, y])
        border_samples.append(px[w - 1, y])

    trans_cnt = sum(1 for p in border_samples if p[3] < 16)
    green_cnt = sum(1 for p in border_samples if is_green_bg(*p))
    total = max(1, len(border_samples))

    if trans_cnt > total * 0.25 and green_cnt < total * 0.15:
        return rgba
    if green_cnt < total * 0.20:
        return rgba

    raw = bytearray(rgba.tobytes())
    visited = bytearray(w * h)
    q = deque()

    def try_seed(x, y):
        if x < 0 or x >= w or y < 0 or y >= h:
            return
        idx = y * w + x
        if visited[idx]:
            return
        off = idx * 4
        r, g, b, a = raw[off], raw[off + 1], raw[off + 2], raw[off + 3]
        if a < 16 or is_green_bg(r, g, b, a):
            visited[idx] = 1
            q.append(idx)

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)
    if cols > 1:
        for c in range(1, cols):
            gx = round(c * w / cols)
            for y in range(h):
                try_seed(gx - 1, y)
                try_seed(gx, y)
    if rows > 1:
        for r in range(1, rows):
            gy = round(r * h / rows)
            for x in range(w):
                try_seed(x, gy - 1)
                try_seed(x, gy)

    while q:
        idx = q.popleft()
        x = idx % w
        y = idx // w
        if x > 0:
            try_seed(x - 1, y)
        if x + 1 < w:
            try_seed(x + 1, y)
        if y > 0:
            try_seed(x, y - 1)
        if y + 1 < h:
            try_seed(x, y + 1)

    for idx in range(w * h):
        if visited[idx]:
            off = idx * 4
            raw[off] = 0
            raw[off + 1] = 0
            raw[off + 2] = 0
            raw[off + 3] = 0

    keyed = Image.frombytes("RGBA", (w, h), bytes(raw))

    # Boundary-only edge despill: find pixels within 2px of transparent background
    alpha = keyed.getchannel("A")
    trans_mask = alpha.point(lambda a: 255 if a == 0 else 0)
    near_trans = trans_mask.filter(ImageFilter.MaxFilter(5))
    nt_data = near_trans.tobytes()

    for idx in range(w * h):
        off = idx * 4
        a = raw[off + 3]
        if a == 0 or nt_data[idx] == 0:
            continue
        r, g, b = raw[off], raw[off + 1], raw[off + 2]
        max_rb = r if r >= b else b
        if g > max_rb:
            excess = g - max_rb
            raw[off + 1] = max_rb
            if excess > 30:
                factor = max(0.2, 1.0 - (excess - 30) / 140.0)
                raw[off + 3] = max(0, round(a * factor))

    return Image.frombytes("RGBA", (w, h), bytes(raw))

def make_thumb_from_sprite(sprite, out_path):
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    bb = sprite.getbbox()
    if bb:
        cropped = sprite.crop(bb).convert("RGBA")
        scale = min(220.0 / cropped.width, 220.0 / cropped.height)
        nw = max(1, round(cropped.width * scale))
        nh = max(1, round(cropped.height * scale))
        resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
        canvas.alpha_composite(resized, ((256 - nw) // 2, (256 - nh) // 2))
    canvas.save(out_path, "PNG")

def normalize_grid(images_rgba, cols, rows, cell_w, cell_h, max_w, max_h, base_y, out_atlas_png, out_thumb_png):
    out = Image.new("RGBA", (cols * cell_w, rows * cell_h), (0, 0, 0, 0))
    first_sprite = None

    if len(images_rgba) == rows and rows > 1:
        # Per-row strip inputs (e.g. 3 strips of 4x1)
        for r, strip in enumerate(images_rgba):
            w, h = strip.size
            for c in range(cols):
                x0 = round(c * w / cols)
                x1 = round((c + 1) * w / cols)
                cell = strip.crop((x0, 0, x1, h))
                bb = cell.getbbox()
                if not bb:
                    continue
                sp = cell.crop(bb)
                scale = min(max_w / sp.width, max_h / sp.height)
                nw = max(1, round(sp.width * scale))
                nh = max(1, round(sp.height * scale))
                resized = sp.resize((nw, nh), Image.Resampling.LANCZOS)
                dx = c * cell_w + round((cell_w - nw) / 2)
                dy = r * cell_h + (base_y - nh)
                out.alpha_composite(resized, (dx, dy))
                if r == 0 and c == 0:
                    first_sprite = sp
    else:
        sheet = images_rgba[0]
        w, h = sheet.size
        for r in range(rows):
            y0 = round(r * h / rows)
            y1 = round((r + 1) * h / rows)
            for c in range(cols):
                x0 = round(c * w / cols)
                x1 = round((c + 1) * w / cols)
                cell = sheet.crop((x0, y0, x1, y1))
                bb = cell.getbbox()
                if not bb:
                    continue
                sp = cell.crop(bb)
                scale = min(max_w / sp.width, max_h / sp.height)
                nw = max(1, round(sp.width * scale))
                nh = max(1, round(sp.height * scale))
                resized = sp.resize((nw, nh), Image.Resampling.LANCZOS)
                dx = c * cell_w + round((cell_w - nw) / 2)
                dy = r * cell_h + (base_y - nh)
                out.alpha_composite(resized, (dx, dy))
                if r == 0 and c == 0:
                    first_sprite = sp

    out.save(out_atlas_png, "PNG")
    if first_sprite is not None:
        make_thumb_from_sprite(first_sprite, out_thumb_png)
    else:
        make_thumb_from_sprite(out, out_thumb_png)

cfg = json.loads(sys.argv[1])
mode = cfg["mode"]
if mode == "thumb-only":
    im = Image.open(cfg["input"])
    try:
        im.seek(0)
    except Exception:
        pass
    rgba = im.convert("RGBA")
    make_thumb_from_sprite(rgba, cfg["thumb"])
elif mode == "compact-4x3":
    inputs = [Image.open(p) for p in cfg["inputs"]]
    cols = 4
    rows = 1 if len(inputs) == 3 else 3
    keyed = [flood_fill_green_key(im, cols, rows) for im in inputs]
    normalize_grid(keyed, 4, 3, 192, 208, 172, 184, 196, cfg["atlas_png"], cfg["thumb"])
elif mode == "codex-v2-8x11":
    im = Image.open(cfg["inputs"][0])
    keyed = flood_fill_green_key(im, 8, 11)
    if keyed.size == (192 * 8, 208 * 11):
        keyed.save(cfg["atlas_png"], "PNG")
        cell0 = keyed.crop((0, 0, 192, 208))
        make_thumb_from_sprite(cell0, cfg["thumb"])
    else:
        normalize_grid([keyed], 8, 11, 192, 208, 176, 190, 200, cfg["atlas_png"], cfg["thumb"])
print("OK")
`;

const MAX_IMPORT_FILES = 16;

const UNSUPPORTED_IMAGE_EXTS = new Set([
  '.heic', '.heif', '.avif', '.svg', '.svgz', '.tif', '.tiff',
  '.psd', '.ai', '.eps', '.pdf', '.raw', '.cr2', '.nef', '.arw', '.dng',
]);

const HUMAN_ERROR_MESSAGES = {
  MISSING_INPUT: '请先上传至少一张角色图片，再开始生成。',
  TOO_MANY_INPUTS: '一次最多导入 16 张图片，请精简后再试。',
  UNSUPPORTED_FORMAT: '这张图片格式暂不支持或文件已损坏，请改用 PNG、JPG、WebP 或动图 GIF。',
  CORRUPT_IMAGE: '这张图片格式暂不支持或文件已损坏，请改用 PNG、JPG、WebP 或动图 GIF。',
  EMPTY_IMAGE: '没有在图片里找到清楚的角色主体，请换一张背景干净、主体完整的图片。',
  INVALID_NAME: '方案或样式名称还空着，先起个名字吧。',
  BUILTIN_PROTECTED: '内置默认「哈基米」形象不能覆盖，请换一个新的方案名称。',
  TIMEOUT: '图片比较多或尺寸较大，处理超时了；建议减少单次数量或换中小尺寸图片再试。',
  PAYLOAD_TOO_LARGE: '上传的图片总体积太大了，建议减少单次数量或换中小尺寸图片再试。',
  INVALID_JSON: '提交的数据格式有点问题，请刷新页面后再试。',
  FILE_NOT_FOUND: '有一张已选图片找不到了，请重新选择后再试。',
  FILE_PATH_NOT_ALLOWED: '当前接口不支持直接读取本机文件路径，请改为上传图片内容。',
  PYTHON_MISSING: '本机图像处理组件暂未就绪，请检查 Python 环境或改用 PNG 图片重试。',
  MODEL_UNAVAILABLE: '未找到本机 Antigravity 模型命令（agy），暂时无法使用模型协助生成。',
  MODEL_EMPTY: '模型暂时未能返回有效图像，请稍后再试或关闭「模型协助生成」直接导入。',
  MODEL_QUOTA: '模型调用额度暂满或请求过于频繁，请稍后再试或关闭「模型协助生成」直接导入。',
  MODEL_AUTH: '本机 Antigravity 模型尚未登录或授权已过期，请先完成登录后再试。',
  MODEL_INVALID_ARGS: '发送给模型的参考图参数超出限制，请减少参考图数量或改用本地直接导入。',
  INTERNAL_ERROR: '生成这一套动作图时遇到一点问题，请换一张图片或改用「分面上传」再试。',
};

function makeHumanError(code, message, statusCode = 400) {
  const err = new Error(message || HUMAN_ERROR_MESSAGES[code] || HUMAN_ERROR_MESSAGES.INTERNAL_ERROR);
  err.code = code || 'INTERNAL_ERROR';
  err.statusCode = statusCode;
  err.isHumanError = true;
  return err;
}

function hasTechnicalNoise(text) {
  if (!text || typeof text !== 'string') return true;
  return /traceback|command failed|error:|syntaxerror|typeerror|referenceerror|enoent|etimedout|epipe|econnrefused|invalid arguments|maxitems|got \d+,\s*want \d+|imagepaths|stream-json|json\.parse|statuscode|\/users\/|\/volumes\/|\/var\/|\/tmp\/|[a-z]:\\|127\.0\.|localhost|node_modules|\.py\b|\.cjs\b|\.mjs\b|\bat\s+\S+\s*\(/i.test(text);
}

function toHumanErrorMessage(err) {
  if (err && typeof err === 'object' && err.isHumanError && typeof err.message === 'string' && !hasTechnicalNoise(err.message)) {
    return err.message;
  }

  const code = (err && typeof err === 'object' && err.code) ? String(err.code).toUpperCase() : '';
  const statusCode = (err && typeof err === 'object' && Number(err.statusCode)) || 0;
  const rawMsg = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' ? String(err.message || err.error || '') : '');

  if (statusCode === 413 || code === 'PAYLOAD_TOO_LARGE' || /payload too large|entity too large|413/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.PAYLOAD_TOO_LARGE;
  }
  if (code === 'MODEL_INVALID_ARGS' || /maxitems|imagepaths|invalid arguments/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.MODEL_INVALID_ARGS;
  }
  if (code === 'MODEL_QUOTA' || /quota|rate limit|too many requests|resource exhausted|429/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.MODEL_QUOTA;
  }
  if (code === 'MODEL_AUTH' || /unauthorized|unauthenticated|not logged in|auth.*expired|forbidden|401|403/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.MODEL_AUTH;
  }
  if (code === 'INVALID_JSON' || /invalid json|unexpected token|syntaxerror|json/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.INVALID_JSON;
  }
  if (code === 'MISSING_INPUT' || /no input|missing image|at least one/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.MISSING_INPUT;
  }
  if (code === 'TOO_MANY_INPUTS' || /more than (?:12|16)|too many|exceeds (?:12|16)|max (?:12|16)/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS;
  }
  if (code === 'EMPTY_IMAGE' || /no visible character|pure transparent|empty image|blank image/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.EMPTY_IMAGE;
  }
  if (code === 'UNSUPPORTED_FORMAT' || code === 'CORRUPT_IMAGE' || /heic|heif|avif|svg|tiff|unidentifiedimageerror|cannot identify|invalid png|invalid base64|unsupported image|decompressionbomb|truncated|corrupt/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT;
  }
  if (code === 'BUILTIN_PROTECTED' || /cannot overwrite built-in|packid "hachimi"/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.BUILTIN_PROTECTED;
  }
  if (code === 'INVALID_NAME' || /empty name|invalid name|invalid packid|invalid variantid/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.INVALID_NAME;
  }
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || /timed out|timeout/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.TIMEOUT;
  }
  if (code === 'ENOENT' || code === 'FILE_NOT_FOUND' || /does not exist|no such file/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.FILE_NOT_FOUND;
  }
  if (code === 'PYTHON_MISSING' || /python 3 with pil|pure-node fallback requires png/i.test(rawMsg)) {
    return HUMAN_ERROR_MESSAGES.PYTHON_MISSING;
  }
  if (code && HUMAN_ERROR_MESSAGES[code]) {
    return HUMAN_ERROR_MESSAGES[code];
  }

  if (rawMsg && !hasTechnicalNoise(rawMsg) && /[\u4e00-\u9fa5]/.test(rawMsg) && rawMsg.length <= 120) {
    return rawMsg;
  }
  return HUMAN_ERROR_MESSAGES.INTERNAL_ERROR;
}

function wrapHumanError(err) {
  if (err && typeof err === 'object' && err.isHumanError && !hasTechnicalNoise(err.message)) {
    return err;
  }
  const msg = toHumanErrorMessage(err);
  const code = (err && typeof err === 'object' && err.code) ? String(err.code) : 'INTERNAL_ERROR';
  const statusCode = (err && typeof err === 'object' && Number(err.statusCode)) || 400;
  return makeHumanError(code, msg, statusCode);
}

const VALID_ROLE_HINTS = new Set([
  'front',
  'left_side',
  'right_side',
  'back',
  'top',
  'face_closeup',
  'action',
  'side',
  'extra',
  'auto',
]);

function normalizeRoleHint(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (!val || val === 'auto') return '';
  if (val === 'extra') return 'action';
  return VALID_ROLE_HINTS.has(val) ? val : '';
}

function assertSupportedImageBuffer(buf, extHint = '', nameHint = '') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw makeHumanError('CORRUPT_IMAGE', HUMAN_ERROR_MESSAGES.CORRUPT_IMAGE);
  }
  const lowerExt = String(extHint || '').toLowerCase();
  const nameExt = nameHint ? path.extname(String(nameHint)).toLowerCase() : '';
  if (UNSUPPORTED_IMAGE_EXTS.has(lowerExt) || UNSUPPORTED_IMAGE_EXTS.has(nameExt)) {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }

  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }
  const headText = buf.subarray(0, 128).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<svg') || headText.startsWith('<?xml') || headText.startsWith('<!doctype svg')) {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))) {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }

  const sniffed = sniffImageExt(buf, '');
  if (!sniffed) {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }
  return sniffed;
}

function decodeInputImageBuffer(item, idx = 0, fallbackRoleHint = '', options = {}) {
  if (!item) throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);

  const allowFilePaths = Boolean(options && options.allowFilePaths === true);
  let rawSource = item;
  let displayName = '';
  let roleHint = normalizeRoleHint(fallbackRoleHint);

  if (typeof item === 'object' && !Buffer.isBuffer(item)) {
    const dataSource =
      item.dataUrl ??
      item.imageDataUrl ??
      item.src ??
      item.url ??
      item.file ??
      item.input ??
      item.base64 ??
      item.imageBase64 ??
      item.buffer;
    const pathSource = item.path ?? item.inputPath;
    if (!allowFilePaths && dataSource === undefined && pathSource !== undefined) {
      throw makeHumanError('FILE_PATH_NOT_ALLOWED', HUMAN_ERROR_MESSAGES.FILE_PATH_NOT_ALLOWED);
    }
    rawSource = dataSource !== undefined ? dataSource : pathSource;
    displayName = String(item.name || item.filename || '').trim();
    const itemManual = normalizeRoleHint(item.manualRole);
    const itemHint = itemManual || normalizeRoleHint(item.roleHint || item.role);
    if (itemHint) roleHint = itemHint;
  }

  if (!rawSource) {
    throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
  }

  let buffer;
  let ext = '.png';

  if (typeof rawSource === 'string') {
    const trimmed = rawSource.trim();
    if (!trimmed) throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
    if (trimmed.startsWith('data:')) {
      const m = trimmed.match(/^data:([^;,]*);base64,(.+)$/is);
      if (!m) throw makeHumanError('CORRUPT_IMAGE', HUMAN_ERROR_MESSAGES.CORRUPT_IMAGE);
      const mime = m[1].toLowerCase();
      if (/(heic|heif|avif|svg|tiff|pdf)/i.test(mime)) {
        throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
      }
      const b64Clean = m[2].replace(/\s+/g, '');
      buffer = Buffer.from(b64Clean, 'base64');
      if (mime.includes('webp')) ext = '.webp';
      else if (mime.includes('gif')) ext = '.gif';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
      else if (mime.includes('bmp')) ext = '.bmp';
      else ext = path.extname(displayName).toLowerCase() || '.png';
    } else {
      const looksLikeRawJpegBase64 =
        trimmed.startsWith('/9j/') &&
        trimmed.length >= 32 &&
        /^[A-Za-z0-9+/=\s]+$/.test(trimmed);
      const looksLikeFilePath =
        !looksLikeRawJpegBase64 &&
        (trimmed.startsWith('/') ||
          trimmed.startsWith('./') ||
          trimmed.startsWith('../') ||
          /^[a-zA-Z]:[\\/]/.test(trimmed) ||
          /\.[a-z0-9]{2,5}$/i.test(trimmed));

      if (looksLikeFilePath) {
        if (!allowFilePaths) {
          throw makeHumanError('FILE_PATH_NOT_ALLOWED', HUMAN_ERROR_MESSAGES.FILE_PATH_NOT_ALLOWED);
        }
        ext = path.extname(trimmed).toLowerCase() || '.png';
        if (UNSUPPORTED_IMAGE_EXTS.has(ext)) {
          throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
        }
        if (!fs.existsSync(trimmed)) {
          throw makeHumanError('FILE_NOT_FOUND', HUMAN_ERROR_MESSAGES.FILE_NOT_FOUND);
        }
        if (!fs.statSync(trimmed).isFile()) {
          throw makeHumanError('FILE_NOT_FOUND', HUMAN_ERROR_MESSAGES.FILE_NOT_FOUND);
        }
        if (!displayName) displayName = path.basename(trimmed);
        buffer = fs.readFileSync(trimmed);
      } else {
        const b64Clean = trimmed.replace(/\s+/g, '');
        if (!b64Clean || !/^[A-Za-z0-9+/]+=*$/.test(b64Clean)) {
          throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
        }
        buffer = Buffer.from(b64Clean, 'base64');
        ext = path.extname(displayName).toLowerCase() || '.png';
      }
    }
  } else if (Buffer.isBuffer(rawSource)) {
    buffer = rawSource;
    ext = path.extname(displayName).toLowerCase() || '.png';
  } else {
    throw makeHumanError('UNSUPPORTED_FORMAT', HUMAN_ERROR_MESSAGES.UNSUPPORTED_FORMAT);
  }

  const sniffedExt = assertSupportedImageBuffer(buffer, ext, displayName);
  return {
    buffer,
    ext: sniffedExt || ext,
    name: displayName || `图片 ${idx + 1}`,
    roleHint,
  };
}

function sniffImageExt(buf, fallbackExt = '.png') {
  if (!Buffer.isBuffer(buf)) return fallbackExt;
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return '.webp';
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return '.gif';
  }
  if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 && buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10) {
    return '.png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return '.jpg';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return '.bmp';
  }
  return fallbackExt;
}

function encodeWebpWithCwebp(cwebpBin, srcPngPath, outWebpPath, { lossless = false } = {}) {
  const args = lossless
    ? ['-quiet', '-lossless', '-exact', '-z', '4', srcPngPath, '-o', outWebpPath]
    : ['-quiet', '-q', '92', '-alpha_q', '100', srcPngPath, '-o', outWebpPath];
  const res = spawnSync(cwebpBin, args, {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true,
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') throw makeHumanError('TIMEOUT', HUMAN_ERROR_MESSAGES.TIMEOUT);
    throw res.error;
  }
  if (res.status !== 0) {
    throw makeHumanError('INTERNAL_ERROR', HUMAN_ERROR_MESSAGES.INTERNAL_ERROR);
  }
}

function encodeWebpWithPillow(pyBin, srcPngPath, outWebpPath, { lossless = true } = {}) {
  if (!pyBin) return false;
  const pyCode = [
    'import sys',
    'from PIL import Image',
    'src, dst, lossless = sys.argv[1], sys.argv[2], sys.argv[3] == "1"',
    'with Image.open(src) as im:',
    '    im.save(dst, "WEBP", lossless=lossless)',
  ].join('\n');
  try {
    const res = spawnSync(pyBin, ['-c', pyCode, srcPngPath, outWebpPath, lossless ? '1' : '0'], {
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (res.status !== 0 || !fs.existsSync(outWebpPath)) return false;
    const head = Buffer.alloc(12);
    const fd = fs.openSync(outWebpPath, 'r');
    try {
      const n = fs.readSync(fd, head, 0, 12, 0);
      return n >= 12 && sniffImageExt(head, '') === '.webp';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function extractRawInputs(opts = {}) {
  if (Array.isArray(opts.files) && opts.files.length > 0) return opts.files;
  if (Array.isArray(opts.inputs) && opts.inputs.length > 0) return opts.inputs;
  if (Array.isArray(opts.rowInputs) && opts.rowInputs.length > 0) return opts.rowInputs;
  const single = opts.imageDataUrl || opts.imageBase64 || opts.inputPath || opts.input;
  return single ? [single] : [];
}

const FACET_SLOT_ROLES = [
  'front',
  'left_side',
  'right_side',
  'back',
  'top',
  'face_closeup',
  'action',
  'side',
  'extras',
];

function getFacetSlotEntries(val) {
  if (Array.isArray(val)) return val.filter(Boolean);
  return val ? [val] : [];
}

function hasNonEmptyFacets(facets) {
  if (!facets || typeof facets !== 'object') return false;
  return FACET_SLOT_ROLES.some((slot) => getFacetSlotEntries(facets[slot]).length > 0);
}

function writeTempInputs(decodedInputs, tmpDir, prefix = 'in') {
  return decodedInputs.map((d, idx) => {
    const ext = sniffImageExt(d.buffer, d.ext);
    const p = path.join(tmpDir, `${prefix}_${idx}${ext}`);
    fs.writeFileSync(p, d.buffer);
    return {
      path: p,
      name: d.name,
      roleHint: d.roleHint || '',
      manualRole: d.roleHint || '',
    };
  });
}

function runInlinePyProcessor(pyBin, payload) {
  const res = spawnSync(pyBin, ['-c', PY_PACK_PROCESSOR, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') throw makeHumanError('TIMEOUT', HUMAN_ERROR_MESSAGES.TIMEOUT);
    throw res.error;
  }
  if (res.status !== 0) {
    console.error('[pack-registry] inline python failed:', res.stderr || res.stdout);
    throw wrapHumanError(new Error(res.stderr || 'inline python processor failed'));
  }
}

function runThreeViewBuilder(mode, payload, tmpDir) {
  const pyBin = findPythonForThreeView();
  if (!pyBin) {
    throw makeHumanError('PYTHON_MISSING', HUMAN_ERROR_MESSAGES.PYTHON_MISSING);
  }
  if (!fs.existsSync(THREE_VIEW_SCRIPT_PATH)) {
    throw makeHumanError('INTERNAL_ERROR', HUMAN_ERROR_MESSAGES.INTERNAL_ERROR);
  }
  const cfgPath = path.join(tmpDir, `tv_${mode}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(payload), 'utf8');
  const flag = mode === 'analyze'
    ? '--analyze'
    : mode === 'edit-frame'
      ? '--edit-frame'
      : '--build';
  const res = spawnSync(pyBin, [THREE_VIEW_SCRIPT_PATH, flag, '--config', cfgPath], {
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 40 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      throw makeHumanError('TIMEOUT', HUMAN_ERROR_MESSAGES.TIMEOUT);
    }
    console.error('[pack-registry] three-view-builder spawn error:', res.error);
    throw makeHumanError('INTERNAL_ERROR', HUMAN_ERROR_MESSAGES.INTERNAL_ERROR);
  }

  let parsed = null;
  try {
    const outStr = String(res.stdout || '').trim();
    if (outStr) {
      const lastLine = outStr.split('\n').pop();
      parsed = JSON.parse(lastLine);
    }
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.ok) {
    if (parsed && parsed.error) {
      console.error('[pack-registry] three-view-builder reported error:', parsed.code, parsed.error);
      throw makeHumanError(parsed.code || 'INTERNAL_ERROR', toHumanErrorMessage(parsed));
    }
    console.error('[pack-registry] three-view-builder failed:', res.status, res.stderr, res.stdout);
    throw makeHumanError('INTERNAL_ERROR', toHumanErrorMessage(res.stderr || 'three-view-builder failed'));
  }
  return parsed;
}

function decodeFacetInputs(facets = {}, options = {}) {
  const fObj = facets && typeof facets === 'object' ? facets : {};
  const allowFilePaths = Boolean(options && options.allowFilePaths === true);
  let totalCount = 0;
  const decoded = {
    front: [],
    left_side: [],
    right_side: [],
    back: [],
    top: [],
    face_closeup: [],
    action: [],
    side: [],
    extras: [],
    flipSide: Boolean(fObj.flipSide),
  };

  for (const slot of FACET_SLOT_ROLES) {
    const entries = getFacetSlotEntries(fObj[slot]);
    const roleForDecode = slot === 'extras' ? 'action' : slot;
    for (const entry of entries) {
      totalCount += 1;
      if (totalCount > MAX_IMPORT_FILES) {
        throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
      }
      decoded[slot].push(decodeInputImageBuffer(entry, totalCount - 1, roleForDecode, { allowFilePaths }));
    }
  }

  return { decoded, totalCount };
}

function writeTempFacets(decodedFacets, tmpDir) {
  const out = { flipSide: Boolean(decodedFacets.flipSide) };
  for (const slot of FACET_SLOT_ROLES) {
    const list = Array.isArray(decodedFacets[slot]) ? decodedFacets[slot] : [];
    if (list.length > 0) {
      out[slot] = writeTempInputs(list, tmpDir, `facet_${slot}`);
    }
  }
  return out;
}

function resolveImportLayout(opts = {}) {
  const raw = String(opts.layout || '').trim();
  if (raw) return raw;
  if (hasNonEmptyFacets(opts.facets)) return 'faceted';
  return 'auto';
}

function analyzeImportInputs(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-import-analyze-'));
  try {
    const allowFilePaths = opts?.allowFilePaths === true;
    const layout = resolveImportLayout(opts);
    const threeViewOpts = opts.threeViewOptions && typeof opts.threeViewOptions === 'object'
      ? opts.threeViewOptions
      : {};
    const order = opts.order !== undefined ? opts.order : threeViewOpts.order;
    const flipSide = Boolean(
      opts.facets?.flipSide !== undefined
        ? opts.facets.flipSide
        : (opts.flipSide !== undefined ? opts.flipSide : threeViewOpts.flipSide)
    );

    if (layout === 'faceted' || (layout === 'auto' && hasNonEmptyFacets(opts.facets) && extractRawInputs(opts).filter(Boolean).length === 0)) {
      const { decoded, totalCount } = decodeFacetInputs(opts.facets, { allowFilePaths });
      if (totalCount === 0) {
        const rawList = extractRawInputs(opts).filter(Boolean);
        if (rawList.length === 0) {
          throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
        }
        if (rawList.length > MAX_IMPORT_FILES) {
          throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
        }
        const decodedInputs = rawList.map((item, idx) => decodeInputImageBuffer(item, idx, '', { allowFilePaths }));
        const tmpEntries = writeTempInputs(decodedInputs, tmpDir);
        return runThreeViewBuilder('analyze', {
          layout: 'faceted',
          inputs: tmpEntries,
          flipSide,
        }, tmpDir);
      }

      const tmpFacets = writeTempFacets({ ...decoded, flipSide }, tmpDir);
      return runThreeViewBuilder('analyze', {
        layout: 'faceted',
        facets: tmpFacets,
        flipSide,
      }, tmpDir);
    }

    const rawList = extractRawInputs(opts).filter(Boolean);
    if (rawList.length === 0) {
      throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
    }
    if (rawList.length > MAX_IMPORT_FILES) {
      throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
    }
    const decodedInputs = rawList.map((item, idx) => decodeInputImageBuffer(item, idx, '', { allowFilePaths }));
    const tmpEntries = writeTempInputs(decodedInputs, tmpDir);

    return runThreeViewBuilder('analyze', {
      layout,
      inputs: tmpEntries,
      order: Array.isArray(order) ? order : undefined,
      flipSide,
    }, tmpDir);
  } catch (err) {
    if (err && err.isHumanError) {
      console.error('[pack-registry:analyze]', err.code, err.message);
    } else {
      console.error('[pack-registry:analyze]', err);
    }
    throw wrapHumanError(err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function analyzeThreeViewInputs(opts = {}) {
  return analyzeImportInputs(opts);
}

function slugifyAsciiId(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 36);
}

function countExistingLocalPacks(packsRoot) {
  try {
    if (!fs.existsSync(packsRoot)) return 0;
    return fs.readdirSync(packsRoot, { withFileTypes: true }).filter((ent) => {
      if (!ent.isDirectory()) return false;
      if (ent.name.startsWith('_') || ent.name.startsWith('.')) return false;
      if (ent.name === 'hachimi') return false;
      return fs.existsSync(path.join(packsRoot, ent.name, 'pack.json'));
    }).length;
  } catch {
    return 0;
  }
}

function validatePackAndVariantNames(opts = {}) {
  const hasPackIdProp = Object.prototype.hasOwnProperty.call(opts, 'packId');
  const rawPackId = String(opts.packId || '').trim();
  if (rawPackId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', HUMAN_ERROR_MESSAGES.BUILTIN_PROTECTED);
  }
  const hasPackNameProp = Object.prototype.hasOwnProperty.call(opts, 'packName') || Object.prototype.hasOwnProperty.call(opts, 'name');
  const hasVariantNameProp = Object.prototype.hasOwnProperty.call(opts, 'variantName') || Object.prototype.hasOwnProperty.call(opts, 'label');
  const packNameStr = String(opts.packName ?? opts.name ?? '').trim();
  const variantNameStr = String(opts.variantName ?? opts.label ?? '').trim();
  const rawVariantId = String(opts.variantId || opts.scheme || '').trim();

  if (hasPackIdProp && rawPackId === '' && !packNameStr) {
    throw makeHumanError('INVALID_NAME', HUMAN_ERROR_MESSAGES.INVALID_NAME);
  }
  if (rawPackId && rawPackId !== '__new__' && !isValidPackId(rawPackId) && !packNameStr) {
    throw makeHumanError('INVALID_NAME', HUMAN_ERROR_MESSAGES.INVALID_NAME);
  }
  if (hasPackNameProp && !packNameStr && (!rawPackId || rawPackId === '__new__') && hasVariantNameProp && !variantNameStr && !rawVariantId) {
    throw makeHumanError('INVALID_NAME', HUMAN_ERROR_MESSAGES.INVALID_NAME);
  }
}

function resolveAutoPackId(opts, packsRoot) {
  const rawPackId = String(opts.packId || '').trim();
  if (rawPackId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', HUMAN_ERROR_MESSAGES.BUILTIN_PROTECTED);
  }
  if (rawPackId && rawPackId !== '__new__' && isValidPackId(rawPackId)) {
    return rawPackId;
  }

  const fromId = rawPackId === '__new__' ? '' : slugifyAsciiId(rawPackId);
  const fromName = slugifyAsciiId(opts.packName || opts.name || '');
  const base = (isValidPackId(fromId) && fromId !== 'hachimi')
    ? fromId
    : (isValidPackId(fromName) && fromName !== 'hachimi' ? fromName : '');

  if (base) {
    if (!fs.existsSync(path.join(packsRoot, base))) {
      return base;
    }
    let suffix = 2;
    while (fs.existsSync(path.join(packsRoot, `${base}-${suffix}`))) {
      suffix++;
    }
    return `${base}-${suffix}`;
  }

  let idx = countExistingLocalPacks(packsRoot) + 1;
  while (fs.existsSync(path.join(packsRoot, `custom-${idx}`))) {
    idx++;
  }
  return `custom-${idx}`;
}

function resolveAutoVariantId(opts, packDir) {
  const rawVariantId = String(opts.variantId || opts.scheme || '').trim();
  if (rawVariantId && rawVariantId !== '__new__' && isValidPackId(rawVariantId)) {
    return rawVariantId;
  }

  const existingIds = new Set();
  const packJsonPath = path.join(packDir, 'pack.json');
  if (fs.existsSync(packJsonPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
      if (Array.isArray(doc?.variants)) {
        for (const v of doc.variants) {
          if (v && typeof v.id === 'string') existingIds.add(v.id);
        }
      }
    } catch { /* ignore */ }
  }

  const fromId = rawVariantId === '__new__' ? '' : slugifyAsciiId(rawVariantId);
  const fromName = slugifyAsciiId(opts.variantName || opts.label || '');
  const base = isValidPackId(fromId) ? fromId : (isValidPackId(fromName) ? fromName : '');

  if (base) {
    if (!existingIds.has(base) && !fs.existsSync(path.join(packDir, base))) {
      return base;
    }
    let suffix = 2;
    while (existingIds.has(`${base}-${suffix}`) || fs.existsSync(path.join(packDir, `${base}-${suffix}`))) {
      suffix++;
    }
    return `${base}-${suffix}`;
  }

  let idx = existingIds.size + 1;
  while (existingIds.has(`pet-${idx}`) || fs.existsSync(path.join(packDir, `pet-${idx}`))) {
    idx++;
  }
  return `pet-${idx}`;
}

function createOrUpdateLocalPack(opts = {}, packsRoot = getPacksRoot()) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-pack-'));
  try {
    validatePackAndVariantNames(opts);
    const allowFilePaths = opts?.allowFilePaths === true;

    const layout = opts.layout
      ? String(opts.layout).trim()
      : (hasNonEmptyFacets(opts.facets)
          ? 'faceted'
          : (Array.isArray(opts.rowInputs) && opts.rowInputs.length > 0
              ? 'compact-4x3'
              : (Array.isArray(opts.files) && opts.files.length > 0 ? 'auto' : 'compact-4x3')));

    if (!['auto', 'faceted', 'compact-4x3', 'single-image', 'codex-v2-8x11', 'three-view'].includes(layout)) {
      throw makeHumanError('INTERNAL_ERROR', HUMAN_ERROR_MESSAGES.INTERNAL_ERROR);
    }

    const packId = resolveAutoPackId(opts, packsRoot);
    const packDir = path.join(packsRoot, packId);
    const variantId = resolveAutoVariantId(opts, packDir);

    const packName = String(opts.packName || opts.name || '').trim() || packId;
    const variantName = String(opts.variantName || opts.label || '').trim() || variantId;
    const badgeEmoji = typeof opts.badgeEmoji === 'string' ? opts.badgeEmoji.trim() : '';
    const explicitColor = typeof opts.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(opts.color.trim())
      ? opts.color.trim()
      : '';
    const asymmetric = Boolean(opts.asymmetric);

    const pyBin = opts.forcePureNode ? '' : findPythonWithPil();
    const cwebpBin = opts.forcePureNode ? '' : findCwebp();

    const stagedThumbPath = path.join(tmpDir, 'staged_thumb.png');
    let stagedAssetPath = '';
    let stagedAssetFilename = '';
    let storedLayout = layout;
    let engine = 'pure-node';
    let suggestedColor = '';
    let buildReport = null;

    if (layout === 'auto' || layout === 'faceted' || layout === 'three-view') {
      const threeViewOpts = opts.threeViewOptions && typeof opts.threeViewOptions === 'object'
        ? opts.threeViewOptions
        : {};
      const order = opts.order !== undefined ? opts.order : threeViewOpts.order;
      const flipSide = Boolean(
        opts.facets?.flipSide !== undefined
          ? opts.facets.flipSide
          : (opts.flipSide !== undefined ? opts.flipSide : threeViewOpts.flipSide)
      );

      const tmpAtlasPng = path.join(tmpDir, 'atlas.png');
      let decodedInputs = [];
      let buildPayload;

      if (layout === 'faceted') {
        const { decoded, totalCount } = decodeFacetInputs(opts.facets, { allowFilePaths });
        if (totalCount > 0) {
          const tmpFacets = writeTempFacets({ ...decoded, flipSide }, tmpDir);
          buildPayload = {
            layout: 'faceted',
            facets: tmpFacets,
            flipSide,
            atlas_png: tmpAtlasPng,
            thumb: stagedThumbPath,
            preserveAnimated: true,
          };
        } else {
          const rawList = extractRawInputs(opts).filter(Boolean);
          if (rawList.length === 0) throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
          if (rawList.length > MAX_IMPORT_FILES) throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
          decodedInputs = rawList.map((item, idx) => decodeInputImageBuffer(item, idx, '', { allowFilePaths }));
          const tmpEntries = writeTempInputs(decodedInputs, tmpDir);
          buildPayload = {
            layout: 'faceted',
            inputs: tmpEntries,
            flipSide,
            atlas_png: tmpAtlasPng,
            thumb: stagedThumbPath,
            preserveAnimated: true,
          };
        }
      } else {
        const rawList = extractRawInputs(opts).filter(Boolean);
        if (rawList.length === 0) {
          if (layout === 'auto' && hasNonEmptyFacets(opts.facets)) {
            const { decoded } = decodeFacetInputs(opts.facets, { allowFilePaths });
            const tmpFacets = writeTempFacets({ ...decoded, flipSide }, tmpDir);
            buildPayload = {
              layout: 'faceted',
              facets: tmpFacets,
              flipSide,
              atlas_png: tmpAtlasPng,
              thumb: stagedThumbPath,
              preserveAnimated: true,
            };
          } else {
            throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
          }
        } else {
          if (rawList.length > MAX_IMPORT_FILES) {
            throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
          }
          decodedInputs = rawList.map((item, idx) => decodeInputImageBuffer(item, idx, '', { allowFilePaths }));
          const tmpEntries = writeTempInputs(decodedInputs, tmpDir);
          buildPayload = {
            layout,
            inputs: tmpEntries,
            order: Array.isArray(order) ? order : undefined,
            flipSide,
            atlas_png: tmpAtlasPng,
            thumb: stagedThumbPath,
            preserveAnimated: true,
          };
        }
      }

      buildReport = runThreeViewBuilder('build', buildPayload, tmpDir);
      suggestedColor = typeof buildReport.suggestedColor === 'string' ? buildReport.suggestedColor : '';

      if (buildReport.recommendedLayout === 'single-image' && decodedInputs.length > 0) {
        const idxKeep = Number.isInteger(buildReport.preserveOriginalIndex) ? buildReport.preserveOriginalIndex : 0;
        const primary = decodedInputs[idxKeep] || decodedInputs[0];
        const ext = sniffImageExt(primary.buffer, primary.ext);
        stagedAssetFilename = `pet${ext}`;
        stagedAssetPath = path.join(tmpDir, stagedAssetFilename);
        fs.writeFileSync(stagedAssetPath, primary.buffer);
        storedLayout = 'single-image';
        engine = 'smart-import-animated';
      } else {
        storedLayout = buildReport.recommendedLayout === 'compact-4x3' ? 'compact-4x3' : 'codex-v2-8x11';
        if (cwebpBin) {
          engine = 'smart-import-py+cwebp';
          stagedAssetFilename = 'spritesheet.webp';
          stagedAssetPath = path.join(tmpDir, stagedAssetFilename);
          encodeWebpWithCwebp(cwebpBin, tmpAtlasPng, stagedAssetPath);
        } else {
          engine = 'smart-import-py';
          stagedAssetFilename = 'spritesheet.png';
          stagedAssetPath = tmpAtlasPng;
        }
      }
    } else if (layout === 'single-image') {
      const rawList = extractRawInputs(opts).filter(Boolean);
      if (rawList.length === 0) throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
      const primary = decodeInputImageBuffer(rawList[0], 0, '', { allowFilePaths });
      const ext = sniffImageExt(primary.buffer, primary.ext);
      stagedAssetFilename = `pet${ext}`;
      stagedAssetPath = path.join(tmpDir, stagedAssetFilename);
      fs.writeFileSync(stagedAssetPath, primary.buffer);

      if (pyBin) {
        engine = 'python-pil';
        runInlinePyProcessor(pyBin, {
          mode: 'thumb-only',
          input: stagedAssetPath,
          thumb: stagedThumbPath,
        });
      } else if (ext === '.png') {
        fs.writeFileSync(stagedThumbPath, makeThumbFromPngBuffer(primary.buffer));
      } else {
        fs.writeFileSync(stagedThumbPath, makeFallbackPawThumbPng(explicitColor || '#708D3D'));
      }
      storedLayout = 'single-image';
    } else {
      const rawList = extractRawInputs(opts).filter(Boolean);
      if (rawList.length === 0) throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
      if (rawList.length > MAX_IMPORT_FILES) throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
      const decodedInputs = rawList.map((item, idx) => decodeInputImageBuffer(item, idx, '', { allowFilePaths }));
      const tmpInputPaths = writeTempInputs(decodedInputs, tmpDir).map((x) => x.path);
      const tmpAtlasPng = path.join(tmpDir, 'atlas.png');

      if (pyBin) {
        engine = cwebpBin ? 'python-pil+cwebp' : 'python-pil';
        runInlinePyProcessor(pyBin, {
          mode: layout,
          inputs: tmpInputPaths,
          atlas_png: tmpAtlasPng,
          thumb: stagedThumbPath,
        });
      } else {
        const primary = decodedInputs[0];
        const ext = sniffImageExt(primary.buffer, primary.ext);
        if (ext !== '.png') {
          throw makeHumanError('PYTHON_MISSING', HUMAN_ERROR_MESSAGES.PYTHON_MISSING);
        }
        const res = layout === 'codex-v2-8x11'
          ? processCodex8x11PngBuffer(primary.buffer)
          : processCompact4x3PngBuffer(primary.buffer);
        fs.writeFileSync(tmpAtlasPng, res.atlasPng);
        fs.writeFileSync(stagedThumbPath, res.thumbPng);
      }

      if (cwebpBin) {
        stagedAssetFilename = 'spritesheet.webp';
        stagedAssetPath = path.join(tmpDir, stagedAssetFilename);
        encodeWebpWithCwebp(cwebpBin, tmpAtlasPng, stagedAssetPath);
      } else {
        stagedAssetFilename = 'spritesheet.png';
        stagedAssetPath = tmpAtlasPng;
      }
      storedLayout = layout;
    }

    // All processing succeeded — now create destination folders and commit files atomically
    const variantDir = path.join(packDir, variantId);
    const thumbsDir = path.join(packDir, 'thumbs');
    fs.mkdirSync(variantDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });

    const thumbPath = path.join(thumbsDir, `${variantId}.png`);
    const assetRelPath = `${variantId}/${stagedAssetFilename}`;
    const destAssetPath = path.join(packDir, assetRelPath);

    fs.copyFileSync(stagedThumbPath, thumbPath);
    fs.copyFileSync(stagedAssetPath, destAssetPath);

    const color = explicitColor || (/^#[0-9a-fA-F]{3,8}$/.test(suggestedColor) ? suggestedColor : '#708D3D');

    const packJsonPath = path.join(packDir, 'pack.json');
    let packDoc = null;
    if (fs.existsSync(packJsonPath)) {
      try {
        packDoc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
      } catch {
        packDoc = null;
      }
    }
    if (!packDoc || typeof packDoc !== 'object') {
      packDoc = {
        id: packId,
        name: packName,
        slotLabel: packName,
        badgeEmoji,
        type: 'sprite',
        defaultVariant: variantId,
        variants: [],
      };
    } else {
      packDoc.id = packId;
      if (opts.packName || opts.name) {
        packDoc.name = packName;
        packDoc.slotLabel = packName;
      }
      if (typeof opts.badgeEmoji === 'string') packDoc.badgeEmoji = badgeEmoji;
      else if (packDoc.badgeEmoji === undefined) packDoc.badgeEmoji = '';
      packDoc.type = 'sprite';
      if (!Array.isArray(packDoc.variants)) packDoc.variants = [];
      if (!packDoc.defaultVariant) packDoc.defaultVariant = variantId;
    }

    const cols = storedLayout === 'codex-v2-8x11' ? 8 : storedLayout === 'compact-4x3' ? 4 : 1;
    const rows = storedLayout === 'codex-v2-8x11' ? 11 : storedLayout === 'compact-4x3' ? 3 : 1;
    const frameWidth = storedLayout === 'single-image' ? 256 : 192;
    const frameHeight = storedLayout === 'single-image' ? 256 : 208;

    const newVariant = {
      id: variantId,
      name: variantName,
      color,
      thumb: `thumbs/${variantId}.png`,
      asset: assetRelPath,
      layout: storedLayout,
      frameWidth,
      frameHeight,
      cols,
      rows,
      asymmetric,
    };

    const existingIdx = packDoc.variants.findIndex((v) => v && v.id === variantId);
    if (existingIdx >= 0) {
      packDoc.variants[existingIdx] = newVariant;
    } else {
      packDoc.variants.push(newVariant);
    }

    fs.writeFileSync(packJsonPath, JSON.stringify(packDoc, null, 2) + '\n', 'utf8');
    occupancyCache.clear();

    const allPacks = scanPacks(packsRoot);
    const pack = allPacks.find((p) => p.id === packId) || null;
    const variant = pack?.variants?.find((v) => v.id === variantId) || normalizeVariant(packId, newVariant);

    return {
      pack,
      variant,
      packDir,
      packJsonPath,
      assetPath: destAssetPath,
      thumbPath,
      engine,
      suggestedColor: color,
      mode: buildReport?.mode || storedLayout,
      modeLabel: buildReport?.modeLabel || storedLayout,
      splitCount: buildReport?.splitCount ?? 1,
      viewCount: buildReport?.viewCount ?? 1,
      roleCounts: buildReport?.roleCounts || {},
      warnings: buildReport?.warnings || [],
      items: buildReport?.items || [],
      extraPlacements: buildReport?.extraPlacements || [],
    };
  } catch (err) {
    if (err && err.isHumanError) {
      console.error('[pack-registry:create]', err.code, err.message);
    } else {
      console.error('[pack-registry:create]', err);
    }
    throw wrapHumanError(err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const CODEX_V2_ROW_SPECS = [
  { id: 'R00', row: 0, colStart: 0, code: 'R00', title: '待机呼吸眨眼', activeCols: 6, frameMs: 280, kind: 'motion' },
  { id: 'R01', row: 1, colStart: 0, code: 'R01', title: '向右奔跑', activeCols: 8, frameMs: 115, kind: 'motion' },
  { id: 'R02', row: 2, colStart: 0, code: 'R02', title: '向左奔跑', activeCols: 8, frameMs: 115, kind: 'motion' },
  { id: 'R03', row: 3, colStart: 0, code: 'R03', title: '打招呼点头', activeCols: 4, frameMs: 170, kind: 'motion' },
  { id: 'R04', row: 4, colStart: 0, code: 'R04', title: '跳跃腾空', activeCols: 5, frameMs: 130, kind: 'motion' },
  {
    id: 'R04H',
    row: 4,
    colStart: 5,
    code: 'R04H',
    title: '鼠标点住与拖拽',
    activeCols: 3,
    frameMs: 240,
    kind: 'hold',
    colLabels: ['捏起静止', '向左摆动', '向右摆动'],
  },
  { id: 'R05', row: 5, colStart: 0, code: 'R05', title: '报错与疑惑', activeCols: 8, frameMs: 165, kind: 'motion' },
  { id: 'R06', row: 6, colStart: 0, code: 'R06', title: '等待与休眠', activeCols: 6, frameMs: 240, kind: 'motion' },
  { id: 'R07', row: 7, colStart: 0, code: 'R07', title: '工作与思考', activeCols: 6, frameMs: 145, kind: 'motion' },
  { id: 'R08', row: 8, colStart: 0, code: 'R08', title: '阅读与审阅', activeCols: 6, frameMs: 220, kind: 'motion' },
  { id: 'R09', row: 9, colStart: 0, code: 'R09', title: '视线跟随（右半圈）', activeCols: 8, frameMs: 180, kind: 'motion' },
  { id: 'R10', row: 10, colStart: 0, code: 'R10', title: '视线跟随（左半圈）', activeCols: 8, frameMs: 180, kind: 'motion' },
];

const COMPACT_4X3_ROW_SPECS = [
  { id: 'R00', row: 0, colStart: 0, code: 'R00', title: '待机眨眼', activeCols: 4, frameMs: 260, kind: 'motion' },
  { id: 'R01', row: 1, colStart: 0, code: 'R01', title: '移动奔跑', activeCols: 4, frameMs: 130, kind: 'motion' },
  { id: 'R02', row: 2, colStart: 0, code: 'R02', title: '工作状态', activeCols: 4, frameMs: 160, kind: 'motion' },
];

const occupancyCache = new Map();

function inspectAtlasCellsOccupancy(assetPath, variant) {
  if (!assetPath || !variant || variant.layout === 'single-image') return null;
  const cols = Number(variant.cols) || (variant.layout === 'codex-v2-8x11' ? 8 : 4);
  const rows = Number(variant.rows) || (variant.layout === 'codex-v2-8x11' ? 11 : 3);
  const fw = Number(variant.frameWidth) || 192;
  const fh = Number(variant.frameHeight) || 208;
  const tag = safeFileMtimeTag(assetPath);
  const cacheKey = `${assetPath}|${tag}|${cols}x${rows}|${fw}x${fh}`;
  if (occupancyCache.has(cacheKey)) {
    return occupancyCache.get(cacheKey);
  }

  const pyBin = findPythonWithPil();
  if (!pyBin) return null;

  const pyCheck = `
import json, sys
from PIL import Image
p, cols, rows, fw, fh = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
im = Image.open(p).convert("RGBA")
w, h = im.size
alpha = im.getchannel("A")
occ = []
for r in range(rows):
    row_flags = []
    y0 = r * fh
    y1 = min(h, y0 + fh)
    for c in range(cols):
        x0 = c * fw
        x1 = min(w, x0 + fw)
        if x0 >= x1 or y0 >= y1:
            row_flags.append(False)
            continue
        cell_a = alpha.crop((x0, y0, x1, y1))
        hist = cell_a.histogram()
        cnt = sum(hist[17:])
        row_flags.append(cnt >= 24)
    occ.append(row_flags)
print(json.dumps(occ))
`;
  try {
    const res = spawnSync(pyBin, ['-c', pyCheck, assetPath, String(cols), String(rows), String(fw), String(fh)], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(String(res.stdout).trim());
      if (Array.isArray(parsed)) {
        if (occupancyCache.size > 64) occupancyCache.clear();
        occupancyCache.set(cacheKey, parsed);
        return parsed;
      }
    }
  } catch { /* fallback cleanly */ }
  return null;
}

function buildStaticSpecsForVariant(pack, variant, assetPath, packsRoot = getPacksRoot()) {
  const thumbFile = variant.thumb ? resolveLocalPackFile(pack.id, variant.thumb, packsRoot) : null;
  const thumbMissing = !thumbFile;
  const occ = inspectAtlasCellsOccupancy(assetPath, variant);
  const isCellEmpty = (r, c) => {
    if (!occ || !Array.isArray(occ[r]) || typeof occ[r][c] !== 'boolean') return false;
    return !occ[r][c];
  };

  if (variant.layout === 'single-image') {
    return {
      hasHoldCell: false,
      staticSpecs: [
        {
          key: 'PORTRAIT',
          code: 'PORTRAIT',
          title: '主静态图 / 角色立绘',
          subtitle: '单图角色主体展示',
          kind: 'image',
          scope: 'asset',
          row: 0,
          col: 0,
          rowCode: 'R00',
          imageUrl: variant.assetUrl || null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: !assetPath,
        },
        {
          key: 'THUMB',
          code: 'THUMB',
          title: '头像缩略图',
          subtitle: '列表与托盘图标',
          kind: 'thumb',
          scope: 'thumb',
          row: null,
          col: null,
          rowCode: null,
          imageUrl: variant.thumbUrl || null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: thumbMissing,
        },
      ],
    };
  }

  if (variant.layout === 'compact-4x3') {
    return {
      hasHoldCell: false,
      staticSpecs: [
        {
          key: 'THUMB',
          code: 'THUMB',
          title: '头像缩略图',
          subtitle: '列表与托盘图标',
          kind: 'thumb',
          scope: 'thumb',
          row: null,
          col: null,
          rowCode: null,
          imageUrl: variant.thumbUrl || null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: thumbMissing,
        },
        {
          key: 'IDLE0',
          code: 'IDLE0',
          title: '待机基准',
          subtitle: 'R00 c0 · 默认静止帧',
          kind: 'cell',
          scope: 'cell',
          row: 0,
          col: 0,
          rowCode: 'R00',
          imageUrl: null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: isCellEmpty(0, 0),
        },
        {
          key: 'HAPPY',
          code: 'HAPPY',
          title: '挥手开心',
          subtitle: 'R00 c2 · 静态互动帧',
          kind: 'cell',
          scope: 'cell',
          row: 0,
          col: 2,
          rowCode: 'R00',
          imageUrl: null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: isCellEmpty(0, 2),
        },
        {
          key: 'LOOK',
          code: 'LOOK',
          title: '好奇观望',
          subtitle: 'R00 c3 · 静态观望帧',
          kind: 'cell',
          scope: 'cell',
          row: 0,
          col: 3,
          rowCode: 'R00',
          imageUrl: null,
          editable: true,
          replaceable: true,
          transformable: true,
          empty: isCellEmpty(0, 3),
        },
      ],
    };
  }

  const hasHoldCell = occ ? Boolean(occ[4]?.[5]) : false;
  return {
    hasHoldCell,
    staticSpecs: [
      {
        key: 'THUMB',
        code: 'THUMB',
        title: '头像缩略图',
        subtitle: '列表与托盘图标',
        kind: 'thumb',
        scope: 'thumb',
        row: null,
        col: null,
        rowCode: null,
        imageUrl: variant.thumbUrl || null,
        editable: true,
        replaceable: true,
        transformable: true,
        empty: thumbMissing,
      },
      {
        key: 'IDLE0',
        code: 'IDLE0',
        title: '待机基准',
        subtitle: 'R00 c0 · 默认静止站姿',
        kind: 'cell',
        scope: 'cell',
        row: 0,
        col: 0,
        rowCode: 'R00',
        imageUrl: null,
        editable: true,
        replaceable: true,
        transformable: true,
        empty: isCellEmpty(0, 0),
      },
      {
        key: 'HOLD',
        code: 'HOLD',
        title: '鼠标捏起静止',
        subtitle: 'R04 c5 · 鼠标按下与悬停',
        kind: 'cell',
        scope: 'cell',
        row: 4,
        col: 5,
        rowCode: 'R04H',
        imageUrl: null,
        editable: true,
        replaceable: true,
        transformable: true,
        empty: isCellEmpty(4, 5),
      },
      {
        key: 'CROUCH',
        code: 'CROUCH',
        title: '起跳蓄力',
        subtitle: 'R04 c0 · 下蹲蓄力静止帧',
        kind: 'cell',
        scope: 'cell',
        row: 4,
        col: 0,
        rowCode: 'R04',
        imageUrl: null,
        editable: true,
        replaceable: true,
        transformable: true,
        empty: isCellEmpty(4, 0),
      },
      {
        key: 'LAND',
        code: 'LAND',
        title: '落地缓冲',
        subtitle: 'R04 c4 · 着陆缓冲静止帧',
        kind: 'cell',
        scope: 'cell',
        row: 4,
        col: 4,
        rowCode: 'R04',
        imageUrl: null,
        editable: true,
        replaceable: true,
        transformable: true,
        empty: isCellEmpty(4, 4),
      },
    ],
  };
}

function readPackDocStrict(packId, packsRoot = getPacksRoot()) {
  if (!packId) {
    throw makeHumanError('INVALID_NAME', '请选择形象方案。');
  }
  if (packId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', '内置默认「哈基米」形象暂不支持此操作。');
  }
  if (!isValidPackId(packId)) {
    throw makeHumanError('INVALID_NAME', '未找到对应的形象方案。');
  }
  const rootResolved = path.resolve(packsRoot);
  const packDir = path.resolve(rootResolved, packId);
  if (!packDir.startsWith(rootResolved + path.sep) || !fs.existsSync(packDir)) {
    throw makeHumanError('FILE_NOT_FOUND', '该形象方案已不存在，请刷新列表。');
  }
  const packJsonPath = path.join(packDir, 'pack.json');
  if (!fs.existsSync(packJsonPath)) {
    throw makeHumanError('FILE_NOT_FOUND', '该形象方案缺少配置文件，请刷新列表。');
  }
  let packDoc = null;
  try {
    packDoc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
  } catch {
    packDoc = null;
  }
  if (!packDoc || typeof packDoc !== 'object' || !Array.isArray(packDoc.variants)) {
    throw makeHumanError('INVALID_JSON', '该形象方案配置格式有误，无法修改。');
  }
  return { packDir, packJsonPath, packDoc };
}

function renameLocalPackOrVariant(opts = {}, packsRoot = getPacksRoot()) {
  const packId = String(opts.packId || '').trim();
  const variantId = String(opts.variantId || opts.scheme || '').trim();
  if (packId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', '内置默认「哈基米」形象暂不支持修改名称。');
  }
  const { packJsonPath, packDoc } = readPackDocStrict(packId, packsRoot);

  const rawName = variantId
    ? (opts.name ?? opts.variantName ?? opts.label ?? opts.displayName)
    : (opts.name ?? opts.packName ?? opts.displayName ?? opts.slotLabel);
  const cleanName = sanitizeDisplayName(
    rawName,
    variantId ? '请输入角色名称。' : '请输入归属名称。'
  );

  if (variantId) {
    if (!isValidPackId(variantId)) {
      throw makeHumanError('INVALID_NAME', '未找到对应的角色样式。');
    }
    const targetVar = packDoc.variants.find((v) => v && v.id === variantId);
    if (!targetVar) {
      throw makeHumanError('FILE_NOT_FOUND', '未找到对应的角色样式。');
    }
    targetVar.name = cleanName;
    targetVar.label = cleanName;
  } else {
    packDoc.name = cleanName;
    packDoc.slotLabel = cleanName;
  }

  writeJsonAtomic(packJsonPath, packDoc);

  const allPacks = scanPacks(packsRoot);
  const pack = allPacks.find((p) => p.id === packId) || null;
  const variant = variantId ? (pack?.variants?.find((v) => v.id === variantId) || null) : null;
  return {
    ok: true,
    pack,
    variant,
  };
}

function resolveMovedVariantId(desiredId, targetPackDir, targetPackDoc) {
  const used = new Set(
    (Array.isArray(targetPackDoc?.variants) ? targetPackDoc.variants : [])
      .map((v) => v && v.id)
      .filter(Boolean)
  );
  const hasConflict = (cand) =>
    used.has(cand) ||
    fs.existsSync(path.join(targetPackDir, cand)) ||
    fs.existsSync(path.join(targetPackDir, 'thumbs', `${cand}.png`));
  if (!hasConflict(desiredId)) return desiredId;
  let suffix = 2;
  while (hasConflict(`${desiredId}-${suffix}`)) {
    suffix++;
  }
  return `${desiredId}-${suffix}`;
}

function moveLocalPackVariant(opts = {}, packsRoot = getPacksRoot()) {
  const sourcePackId = String(opts.sourcePackId || opts.fromPackId || opts.packId || '').trim();
  const variantId = String(opts.variantId || opts.scheme || '').trim();
  const rawTargetPackId = String(opts.targetPackId || '').trim();
  const rawTargetPackName = opts.targetPackName ?? opts.packName ?? opts.newPackName ?? '';

  if (!sourcePackId || !variantId) {
    throw makeHumanError('INVALID_NAME', '请选择要移动的角色和目标归属。');
  }
  if (sourcePackId === 'hachimi' || rawTargetPackId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', '内置默认「哈基米」形象不支持移动角色。');
  }
  if (!isValidPackId(variantId)) {
    throw makeHumanError('INVALID_NAME', '未找到对应的角色样式。');
  }

  const src = readPackDocStrict(sourcePackId, packsRoot);
  const srcVariantIdx = src.packDoc.variants.findIndex((v) => v && v.id === variantId);
  if (srcVariantIdx < 0) {
    throw makeHumanError('FILE_NOT_FOUND', '未找到对应的角色样式，可能已被移动或删除。');
  }
  const srcVariant = src.packDoc.variants[srcVariantIdx];

  const isCreatingNewPack = !rawTargetPackId || rawTargetPackId === '__new__';
  let targetPackId = rawTargetPackId;
  let targetPackDir;
  let targetPackJsonPath;
  let targetPackDoc;

  if (isCreatingNewPack) {
    const cleanTargetName = sanitizeDisplayName(rawTargetPackName, '请先输入新的归属名称。');
    targetPackId = resolveAutoPackId({ packName: cleanTargetName }, packsRoot);
    targetPackDir = path.resolve(packsRoot, targetPackId);
    targetPackJsonPath = path.join(targetPackDir, 'pack.json');
    targetPackDoc = {
      id: targetPackId,
      name: cleanTargetName,
      slotLabel: cleanTargetName,
      badgeEmoji: '',
      type: 'sprite',
      defaultVariant: '',
      variants: [],
    };
  } else {
    if (rawTargetPackId === sourcePackId) {
      return {
        ok: true,
        moved: false,
        sourcePackId,
        targetPackId: sourcePackId,
        previousVariantId: variantId,
        variantId,
        sourcePackRemoved: false,
      };
    }
    const dst = readPackDocStrict(rawTargetPackId, packsRoot);
    if (dst.packDoc.type === 'whale') {
      throw makeHumanError('BUILTIN_PROTECTED', '目标方案不支持接收精灵图角色。');
    }
    targetPackId = rawTargetPackId;
    targetPackDir = dst.packDir;
    targetPackJsonPath = dst.packJsonPath;
    targetPackDoc = dst.packDoc;
  }

  const srcAssetRel = cleanRelAssetPath(srcVariant.asset || srcVariant.spritesheet || `${variantId}/spritesheet.webp`);
  const srcAssetAbs = srcAssetRel ? resolveLocalPackFile(sourcePackId, srcAssetRel, packsRoot) : null;
  if (!srcAssetAbs) {
    throw makeHumanError('FILE_NOT_FOUND', '未找到该角色的图集文件，无法移动。');
  }
  const srcThumbRel = cleanRelAssetPath(srcVariant.thumb || `thumbs/${variantId}.png`);
  const srcThumbAbs = srcThumbRel ? resolveLocalPackFile(sourcePackId, srcThumbRel, packsRoot) : null;

  const destVariantId = resolveMovedVariantId(variantId, targetPackDir, targetPackDoc);
  const destVarDir = path.join(targetPackDir, destVariantId);
  const destThumbsDir = path.join(targetPackDir, 'thumbs');

  fs.mkdirSync(destVarDir, { recursive: true });
  fs.mkdirSync(destThumbsDir, { recursive: true });

  const srcVarDir = path.resolve(src.packDir, variantId);
  const assetBasename = path.basename(srcAssetRel);
  const destAssetRel = `${destVariantId}/${assetBasename}`;
  const destAssetAbs = path.join(destVarDir, assetBasename);

  if (fs.existsSync(srcVarDir) && fs.statSync(srcVarDir).isDirectory()) {
    copyDirOrFileSync(srcVarDir, destVarDir);
  }
  if (!fs.existsSync(destAssetAbs)) {
    fs.copyFileSync(srcAssetAbs, destAssetAbs);
  }

  const destThumbRel = `thumbs/${destVariantId}.png`;
  const destThumbAbs = path.join(destThumbsDir, `${destVariantId}.png`);
  if (srcThumbAbs && fs.existsSync(srcThumbAbs)) {
    fs.copyFileSync(srcThumbAbs, destThumbAbs);
  }

  const movedEntry = {
    ...srcVariant,
    id: destVariantId,
    asset: destAssetRel,
    thumb: destThumbRel,
  };
  if ('spritesheet' in movedEntry) delete movedEntry.spritesheet;
  if ('spritesheetPath' in movedEntry) delete movedEntry.spritesheetPath;
  if ('thumbPath' in movedEntry) delete movedEntry.thumbPath;

  targetPackDoc.id = targetPackId;
  targetPackDoc.type = 'sprite';
  if (!Array.isArray(targetPackDoc.variants)) targetPackDoc.variants = [];
  targetPackDoc.variants.push(movedEntry);
  if (!targetPackDoc.defaultVariant || !targetPackDoc.variants.some((v) => v.id === targetPackDoc.defaultVariant)) {
    targetPackDoc.defaultVariant = destVariantId;
  }

  writeJsonAtomic(targetPackJsonPath, targetPackDoc);

  const remaining = src.packDoc.variants.filter((v) => v && v.id !== variantId);
  let sourcePackRemoved = false;
  if (remaining.length === 0) {
    fs.rmSync(src.packDir, { recursive: true, force: true });
    sourcePackRemoved = true;
  } else {
    src.packDoc.variants = remaining;
    if (!remaining.some((v) => v.id === src.packDoc.defaultVariant)) {
      src.packDoc.defaultVariant = remaining[0].id;
    }
    writeJsonAtomic(src.packJsonPath, src.packDoc);

    if (srcVarDir.startsWith(src.packDir + path.sep) && fs.existsSync(srcVarDir)) {
      try { fs.rmSync(srcVarDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (srcThumbAbs && srcThumbAbs.startsWith(src.packDir + path.sep) && fs.existsSync(srcThumbAbs)) {
      try { fs.rmSync(srcThumbAbs, { force: true }); } catch { /* ignore */ }
    }
    if (
      srcAssetAbs &&
      srcAssetAbs.startsWith(src.packDir + path.sep) &&
      fs.existsSync(srcAssetAbs) &&
      !remaining.some((v) => cleanRelAssetPath(v.asset || '') === srcAssetRel)
    ) {
      try { fs.rmSync(srcAssetAbs, { force: true }); } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    moved: true,
    sourcePackId,
    targetPackId,
    previousVariantId: variantId,
    variantId: destVariantId,
    sourcePackRemoved,
  };
}

function deleteLocalPackOrVariant(opts = {}, packsRoot = getPacksRoot()) {
  const packId = String(opts.packId || '').trim();
  const variantId = String(opts.variantId || opts.scheme || '').trim();
  if (!packId) {
    throw makeHumanError('INVALID_NAME', '请选择要删除的形象方案。');
  }
  if (packId === 'hachimi') {
    throw makeHumanError('BUILTIN_PROTECTED', '内置默认形象不支持删除。');
  }
  if (!isValidPackId(packId)) {
    throw makeHumanError('INVALID_NAME', '未找到对应的形象方案。');
  }

  const rootResolved = path.resolve(packsRoot);
  const packDir = path.resolve(rootResolved, packId);
  if (!packDir.startsWith(rootResolved + path.sep) || !fs.existsSync(packDir)) {
    throw makeHumanError('FILE_NOT_FOUND', '该形象方案已不存在，请刷新列表。');
  }

  if (!variantId) {
    fs.rmSync(packDir, { recursive: true, force: true });
    return { deletedPackId: packId, deletedVariantId: null, packRemoved: true };
  }

  if (!isValidPackId(variantId)) {
    throw makeHumanError('INVALID_NAME', '未找到对应的角色样式。');
  }

  const packJsonPath = path.join(packDir, 'pack.json');
  let packDoc = null;
  try {
    packDoc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
  } catch {
    packDoc = null;
  }

  const curVariants = Array.isArray(packDoc?.variants) ? packDoc.variants : [];
  const nextVariants = curVariants.filter((v) => v && v.id !== variantId);
  if (curVariants.length > 0 && nextVariants.length === curVariants.length) {
    throw makeHumanError('FILE_NOT_FOUND', '该角色样式已不存在，请刷新列表。');
  }

  if (nextVariants.length === 0) {
    fs.rmSync(packDir, { recursive: true, force: true });
    return { deletedPackId: packId, deletedVariantId: variantId, packRemoved: true };
  }

  packDoc.variants = nextVariants;
  if (!nextVariants.some((v) => v.id === packDoc.defaultVariant)) {
    packDoc.defaultVariant = nextVariants[0].id;
  }
  writeJsonAtomic(packJsonPath, packDoc);

  const varDir = path.resolve(packDir, variantId);
  if (varDir.startsWith(packDir + path.sep) && fs.existsSync(varDir)) {
    try { fs.rmSync(varDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const thumbFile = path.resolve(packDir, 'thumbs', `${variantId}.png`);
  if (thumbFile.startsWith(packDir + path.sep) && fs.existsSync(thumbFile)) {
    try { fs.rmSync(thumbFile, { force: true }); } catch { /* ignore */ }
  }

  return { deletedPackId: packId, deletedVariantId: variantId, packRemoved: false };
}

function inspectLocalPackVariant(opts = {}, packsRoot = getPacksRoot()) {
  const packId = String(opts.packId || '').trim();
  const variantId = String(opts.variantId || opts.scheme || '').trim();
  if (!packId || packId === 'hachimi' || !isValidPackId(packId)) {
    throw makeHumanError('BUILTIN_PROTECTED', '请选择一个自定义或精灵动作图集角色进行检视。');
  }
  const allPacks = scanPacks(packsRoot);
  const pack = allPacks.find((p) => p.id === packId);
  if (!pack) {
    throw makeHumanError('FILE_NOT_FOUND', '未找到对应的形象方案。');
  }
  const variant =
    pack.variants.find((v) => v.id === variantId) ||
    pack.variants.find((v) => v.id === pack.defaultVariant) ||
    pack.variants[0];
  if (!variant) {
    throw makeHumanError('FILE_NOT_FOUND', '未找到对应的角色样式。');
  }

  const assetPath = resolveLocalPackFile(pack.id, variant.asset, packsRoot);
  if (!assetPath) {
    throw makeHumanError('FILE_NOT_FOUND', '未找到该角色的动作图集文件。');
  }

  const rowSpecs = variant.layout === 'codex-v2-8x11'
    ? CODEX_V2_ROW_SPECS.map((r) => ({ ...r, colLabels: r.colLabels ? [...r.colLabels] : undefined }))
    : variant.layout === 'compact-4x3'
      ? COMPACT_4X3_ROW_SPECS.map((r) => ({ ...r }))
      : [{ id: 'R00', row: 0, colStart: 0, code: 'R00', title: '单图展示', activeCols: 1, frameMs: 400, kind: 'static' }];

  const { hasHoldCell, staticSpecs } = buildStaticSpecsForVariant(pack, variant, assetPath, packsRoot);

  return {
    ok: true,
    pack: { id: pack.id, name: pack.name },
    variant,
    hasHoldCell,
    rowSpecs,
    staticSpecs,
  };
}

function isAnimatedImageFile(pyBin, filePath, ext) {
  if (ext === '.gif') return true;
  if (ext !== '.webp' || !pyBin) return false;
  try {
    const res = spawnSync(pyBin, ['-c', 'import sys; from PIL import Image; im=Image.open(sys.argv[1]); print(getattr(im,"n_frames",1))', filePath], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    if (res.status === 0) {
      return Number(String(res.stdout || '').trim()) > 1;
    }
  } catch { /* ignore */ }
  return false;
}

function editLocalPackFrame(opts = {}, packsRoot = getPacksRoot()) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-edit-frame-'));
  try {
    const allowFilePaths = opts?.allowFilePaths === true;
    const info = inspectLocalPackVariant(opts, packsRoot);
    const { pack, variant } = info;
    const packDir = path.join(packsRoot, pack.id);
    const assetPath = resolveLocalPackFile(pack.id, variant.asset, packsRoot);
    const thumbRel = cleanRelAssetPath(variant.thumb || `thumbs/${variant.id}.png`) || `thumbs/${variant.id}.png`;
    const thumbPath = path.join(packDir, thumbRel);
    if (!assetPath) {
      throw makeHumanError('FILE_NOT_FOUND', '未找到该角色的动作图集文件。');
    }

    const rawAction = String(opts.action || 'transform').trim().toLowerCase();
    const action = rawAction === 'replace_thumb' || rawAction === 'replace_asset' ? rawAction : rawAction;
    const rawScope = String(opts.scope || (action === 'replace_row' ? 'row' : 'cell')).trim().toLowerCase();
    const scope = rawScope === 'thumb'
      ? 'thumb'
      : (rawScope === 'asset' || variant.layout === 'single-image')
        ? (variant.layout === 'single-image' && rawScope !== 'thumb' ? 'asset' : rawScope)
        : rawScope;
    const row = Math.max(0, Math.min((variant.rows || 11) - 1, Number(opts.row) || 0));
    const col = Math.max(0, Math.min((variant.cols || 8) - 1, Number(opts.col) || 0));
    const rowCode = String(opts.rowCode || '').trim().toUpperCase();
    const colStart = opts.colStart !== undefined && opts.colStart !== null ? Number(opts.colStart) : undefined;
    const activeCols = opts.activeCols !== undefined && opts.activeCols !== null ? Number(opts.activeCols) : undefined;

    let tmpImagePath = '';
    let decodedUpload = null;
    if (action === 'replace_cell' || action === 'replace_row' || action === 'replace_thumb' || action === 'replace_asset') {
      const rawImg = opts.imageDataUrl || opts.dataUrl || opts.image || (Array.isArray(opts.files) ? opts.files[0] : null);
      if (!rawImg) {
        throw makeHumanError('MISSING_INPUT', '请先选择 1 张用于修改的图片。');
      }
      decodedUpload = decodeInputImageBuffer(rawImg, 0, '', { allowFilePaths });
      tmpImagePath = writeTempInputs([decodedUpload], tmpDir, 'edit_in')[0].path;
    }

    const pyBin = findPythonWithPil();
    const cwebpBin = findCwebp();
    const tmpOutPng = path.join(tmpDir, 'edited_atlas.png');
    const tmpThumbPng = path.join(tmpDir, 'edited_thumb.png');

    // Special fast-path for animated GIF/WebP replacement on single-image variants
    if (
      variant.layout === 'single-image' &&
      scope !== 'thumb' &&
      (action === 'replace_cell' || action === 'replace_row' || action === 'replace_asset') &&
      decodedUpload &&
      isAnimatedImageFile(pyBin, tmpImagePath, sniffImageExt(decodedUpload.buffer, decodedUpload.ext))
    ) {
      const ext = sniffImageExt(decodedUpload.buffer, decodedUpload.ext);
      const nextRel = `${variant.id}/pet${ext}`;
      const nextAbs = path.join(packDir, nextRel);
      fs.mkdirSync(path.dirname(nextAbs), { recursive: true });
      fs.writeFileSync(nextAbs, decodedUpload.buffer);

      if (pyBin) {
        runInlinePyProcessor(pyBin, { mode: 'thumb-only', input: nextAbs, thumb: tmpThumbPng });
      } else {
        fs.writeFileSync(tmpThumbPng, makeFallbackPawThumbPng(variant.color || '#708D3D'));
      }
      if (fs.existsSync(tmpThumbPng)) {
        fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
        fs.copyFileSync(tmpThumbPng, thumbPath);
      }

      if (cleanRelAssetPath(variant.asset) !== nextRel) {
        const packJsonPath = path.join(packDir, 'pack.json');
        const doc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
        const vEntry = doc.variants?.find((v) => v && v.id === variant.id);
        if (vEntry) {
          vEntry.asset = nextRel;
          vEntry.thumb = thumbRel;
          writeJsonAtomic(packJsonPath, doc);
        }
        if (path.resolve(assetPath) !== path.resolve(nextAbs) && fs.existsSync(assetPath)) {
          try { fs.rmSync(assetPath, { force: true }); } catch { /* ignore */ }
        }
      }

      occupancyCache.clear();
      const updated = inspectLocalPackVariant({ packId: pack.id, variantId: variant.id }, packsRoot);
      return {
        ok: true,
        action,
        scope,
        row: 0,
        col: 0,
        rowCode: 'R00',
        ...updated,
      };
    }

    const builderResult = runThreeViewBuilder('edit-frame', {
      atlasInput: assetPath,
      atlasOutput: tmpOutPng,
      thumbInput: fs.existsSync(thumbPath) ? thumbPath : '',
      thumbOutput: tmpThumbPng,
      layout: variant.layout,
      cols: variant.cols,
      rows: variant.rows,
      frameWidth: variant.frameWidth,
      frameHeight: variant.frameHeight,
      action,
      scope,
      row,
      col,
      rowCode: rowCode || undefined,
      colStart: Number.isFinite(colStart) ? colStart : undefined,
      activeCols: Number.isFinite(activeCols) ? activeCols : undefined,
      imagePath: tmpImagePath,
      flipX: Boolean(opts.flipX),
      dx: Number(opts.dx) || 0,
      dy: Number(opts.dy) || 0,
      scale: Number(opts.scale) || 1.0,
      cleanEdge: Boolean(opts.cleanEdge),
    }, tmpDir);

    if (scope !== 'thumb' && fs.existsSync(tmpOutPng)) {
      if (variant.layout === 'single-image' && !assetPath.toLowerCase().endsWith('.png') && !assetPath.toLowerCase().endsWith('.webp')) {
        const nextRel = `${variant.id}/pet.png`;
        const nextAbs = path.join(packDir, nextRel);
        fs.mkdirSync(path.dirname(nextAbs), { recursive: true });
        fs.copyFileSync(tmpOutPng, nextAbs);
        const packJsonPath = path.join(packDir, 'pack.json');
        const doc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
        const vEntry = doc.variants?.find((v) => v && v.id === variant.id);
        if (vEntry) {
          vEntry.asset = nextRel;
          writeJsonAtomic(packJsonPath, doc);
        }
        if (path.resolve(assetPath) !== path.resolve(nextAbs) && fs.existsSync(assetPath)) {
          try { fs.rmSync(assetPath, { force: true }); } catch { /* ignore */ }
        }
      } else if (assetPath.toLowerCase().endsWith('.webp')) {
        const tmpWebp = path.join(tmpDir, 'edited_atlas.webp');
        if (cwebpBin) {
          encodeWebpWithCwebp(cwebpBin, tmpOutPng, tmpWebp, { lossless: true });
          fs.copyFileSync(tmpWebp, assetPath);
        } else {
          const webpPyBin = pyBin || findPythonForThreeView();
          if (webpPyBin && encodeWebpWithPillow(webpPyBin, tmpOutPng, tmpWebp, { lossless: true })) {
            fs.copyFileSync(tmpWebp, assetPath);
          } else {
            const currentRel = cleanRelAssetPath(variant.asset || `${variant.id}/spritesheet.webp`) || `${variant.id}/spritesheet.webp`;
            const nextRel = /\.webp$/i.test(currentRel)
              ? currentRel.replace(/\.webp$/i, '.png')
              : `${variant.id}/${path.basename(assetPath, path.extname(assetPath))}.png`;
            const nextAbs = path.join(packDir, nextRel);
            fs.mkdirSync(path.dirname(nextAbs), { recursive: true });
            fs.copyFileSync(tmpOutPng, nextAbs);
            const packJsonPath = path.join(packDir, 'pack.json');
            const doc = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
            const vEntry = doc.variants?.find((v) => v && v.id === variant.id);
            if (vEntry) {
              vEntry.asset = nextRel;
              if ('spritesheet' in vEntry) delete vEntry.spritesheet;
              if ('spritesheetPath' in vEntry) delete vEntry.spritesheetPath;
              writeJsonAtomic(packJsonPath, doc);
            }
            const stillReferenced = Array.isArray(doc.variants) && doc.variants.some(
              (v) => v && v.id !== variant.id && cleanRelAssetPath(v.asset || v.spritesheet || v.spritesheetPath || '') === currentRel
            );
            if (!stillReferenced && path.resolve(assetPath) !== path.resolve(nextAbs) && fs.existsSync(assetPath)) {
              try { fs.rmSync(assetPath, { force: true }); } catch { /* ignore */ }
            }
          }
        }
      } else {
        fs.copyFileSync(tmpOutPng, assetPath);
      }
    }

    if (fs.existsSync(tmpThumbPng)) {
      fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
      fs.copyFileSync(tmpThumbPng, thumbPath);
    }

    occupancyCache.clear();
    const updated = inspectLocalPackVariant({ packId: pack.id, variantId: variant.id }, packsRoot);
    return {
      ok: true,
      action,
      scope,
      row,
      col,
      rowCode: builderResult.rowCode || rowCode || `R${String(row).padStart(2, '0')}`,
      ...updated,
    };
  } catch (err) {
    throw wrapHumanError(err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function prepareModelStyleInputs(opts = {}, packsRoot = getPacksRoot()) {
  const allowFilePaths = opts?.allowFilePaths === true;
  const subjectRaw = [];
  if (hasNonEmptyFacets(opts.facets)) {
    const { decoded } = decodeFacetInputs(opts.facets, { allowFilePaths });
    for (const slot of FACET_SLOT_ROLES) {
      if (Array.isArray(decoded[slot])) {
        subjectRaw.push(...decoded[slot]);
      }
    }
  } else {
    const list = extractRawInputs(opts).filter(Boolean);
    if (list.length === 0) {
      throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
    }
    if (list.length > MAX_IMPORT_FILES) {
      throw makeHumanError('TOO_MANY_INPUTS', HUMAN_ERROR_MESSAGES.TOO_MANY_INPUTS);
    }
    for (let i = 0; i < list.length; i++) {
      subjectRaw.push(decodeInputImageBuffer(list[i], i, '', { allowFilePaths }));
    }
  }

  if (subjectRaw.length === 0) {
    throw makeHumanError('MISSING_INPUT', HUMAN_ERROR_MESSAGES.MISSING_INPUT);
  }

  const styleRef = opts.styleRef && typeof opts.styleRef === 'object' ? opts.styleRef : {};
  let customStyleDecoded = null;
  let refAtlasPath = '';
  let refThumbPath = '';

  if (styleRef.dataUrl) {
    customStyleDecoded = decodeInputImageBuffer({ dataUrl: styleRef.dataUrl, name: styleRef.name || 'style.png' }, 0, '', { allowFilePaths });
  } else {
    const allPacks = scanPacks(packsRoot);
    const refPack =
      allPacks.find((p) => p.id === styleRef.packId && !p.isBuiltin) ||
      allPacks.find((p) => p.id === 'six-cats') ||
      allPacks.find((p) => !p.isBuiltin);
    if (refPack) {
      const refVar =
        refPack.variants.find((v) => v.id === styleRef.variantId) ||
        refPack.variants.find((v) => v.id === refPack.defaultVariant) ||
        refPack.variants[0];
      if (refVar) {
        refAtlasPath = resolveLocalPackFile(refPack.id, refVar.asset, packsRoot) || '';
        refThumbPath = resolveLocalPackFile(refPack.id, refVar.thumb, packsRoot) || '';
      }
    }
  }

  return {
    subjectFiles: subjectRaw,
    customStyleDecoded,
    refAtlasPath,
    refThumbPath,
    pyBin: findPythonWithPil(),
  };
}

module.exports = {
  VALID_ID_REGEX,
  BUILTIN_HACHIMI_PACK,
  getPacksRoot,
  isValidPackId,
  scanPacks,
  resolveLocalPackFile,
  resolveThumbFilePath,
  analyzeImportInputs,
  analyzeThreeViewInputs,
  createOrUpdateLocalPack,
  renameLocalPackOrVariant,
  moveLocalPackVariant,
  deleteLocalPackOrVariant,
  inspectLocalPackVariant,
  editLocalPackFrame,
  sanitizeDisplayName,
  prepareModelStyleInputs,
  decodeInputImageBuffer,
  encodeWebpWithPillow,
  toHumanErrorMessage,
  findPythonWithPil,
  findPythonForThreeView,
  findCwebp,
};
