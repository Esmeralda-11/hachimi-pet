import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(PLUGIN_ROOT, 'app');
const LAUNCH_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'launch-pet.mjs');

const PET_PORT = Number(process.env.HACHIMI_PET_PORT || process.env.AGY_WHALE_PORT || 17890);
const PET_HOST = '127.0.0.1';
const WORKSHOP_URL = `http://${PET_HOST}:${PET_PORT}/workshop`;

const HACHIMI_HOME = path.join(os.homedir(), '.hachimi-pet');
const SIDECAR_STATE_PATH = process.env.HACHIMI_SIDECAR_STATE_PATH
  ? path.resolve(process.env.HACHIMI_SIDECAR_STATE_PATH)
  : path.join(HACHIMI_HOME, 'sidecar-state.json');
const PACKS_ROOT = process.env.HACHIMI_PACKS_DIR || path.join(HACHIMI_HOME, 'packs');
const PET_DATA_DIR = process.env.HACHIMI_DATA_DIR
  ? path.resolve(process.env.HACHIMI_DATA_DIR)
  : path.join(os.homedir(), '.agy-whale-pet');
const PET_SETTINGS_PATH = path.join(PET_DATA_DIR, 'settings.json');

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;
const VALID_TEMPERAMENTS = new Set(['daily', 'quiet', 'lively']);
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const THUMB_MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

const BUILTIN_HACHIMI_PACK = {
  id: 'hachimi',
  name: '哈基米',
  slotLabel: '默认形象',
  badgeEmoji: '',
  type: 'whale',
  defaultVariant: 'astral',
  isBuiltin: true,
  variants: [
    { id: 'astral', name: '星瞳紫', label: '星瞳紫', color: '#8B7BF7', thumb: 'thumbs/astral.png' },
    { id: 'sakura', name: '樱桃粉', label: '樱桃粉', color: '#F472B6', thumb: 'thumbs/sakura.png' },
    { id: 'azure', name: '苍穹蓝', label: '苍穹蓝', color: '#38BDF8', thumb: 'thumbs/azure.png' },
    { id: 'emerald', name: '森灵翠', label: '森灵翠', color: '#34D399', thumb: 'thumbs/emerald.png' },
    { id: 'amber', name: '流光金', label: '流光金', color: '#F59E0B', thumb: 'thumbs/amber.png' },
    { id: 'crimson', name: '绯夜红', label: '绯夜红', color: '#FB7185', thumb: 'thumbs/crimson.png' },
    { id: 'arctic', name: '霜月银', label: '霜月银', color: '#94A3B8', thumb: 'thumbs/arctic.png' },
    { id: 'obsidian', name: '暗夜黑', label: '暗夜黑', color: '#6366F1', thumb: 'thumbs/obsidian.png' },
  ],
};

const BUILTIN_VARIANT_IDS = new Set(BUILTIN_HACHIMI_PACK.variants.map((v) => v.id));

const DEFAULT_SETTINGS = {
  packId: 'hachimi',
  scheme: 'astral',
  petHidden: false,
  trayHidden: false,
  temperament: 'daily',
  mainScale: 0.85,
  showSpeechBubble: true,
  showStatusPill: true,
  showTelemetryBar: true,
};

const IS_SIDECAR_ENV = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);
const STANDALONE_PORT = Number(process.env.HACHIMI_SIDECAR_STANDALONE_PORT || 0);

let SdkResponse = null;

function makeResponse(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers } = {}) {
  if (SdkResponse) {
    return new SdkResponse(body, { contentType, status, headers });
  }
  return { body, contentType, status, headers };
}

function makeJsonResponse(payload, status = 200) {
  return makeResponse(JSON.stringify(payload), {
    contentType: 'application/json; charset=utf-8',
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Sidecar persistent switch state (~/.hachimi-pet/sidecar-state.json)
// ---------------------------------------------------------------------------

function readSidecarState() {
  try {
    if (fs.existsSync(SIDECAR_STATE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SIDECAR_STATE_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return { enabled: parsed.enabled !== false };
      }
    }
  } catch { /* fallback to default */ }
  return { enabled: true };
}

function writeSidecarState(next) {
  const payload = {
    enabled: next.enabled !== false,
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(SIDECAR_STATE_PATH), { recursive: true });
    const tmp = path.join(
      path.dirname(SIDECAR_STATE_PATH),
      `.tmp_sidecar-state_${process.pid}_${crypto.randomBytes(4).toString('hex')}.json`
    );
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SIDECAR_STATE_PATH);
  } catch (err) {
    console.error('[hachimi-sidecar] failed to persist sidecar-state.json:', err?.message || err);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Loopback HTTP helper to Electron bridge (127.0.0.1:17890)
// ---------------------------------------------------------------------------

function petRequestJson(pathname, { method = 'GET', body = null, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(
      {
        hostname: PET_HOST,
        port: PET_PORT,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = null;
          }
          const status = res.statusCode || 0;
          finish({
            ok: status >= 200 && status < 300,
            status,
            data,
            unreachable: false,
            error: data?.error || (status >= 400 ? `HTTP ${status}` : ''),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      finish({ ok: false, status: 0, data: null, unreachable: true, error: '请求桌宠服务超时' });
    });

    req.on('error', () => {
      finish({ ok: false, status: 0, data: null, unreachable: true, error: '桌宠服务未响应' });
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function checkPetHealth(timeoutMs = 1000) {
  const res = await petRequestJson('/health', { method: 'GET', timeoutMs });
  const running = Boolean(res.ok && res.data && res.data.ok);
  return {
    running,
    health: running ? res.data : null,
  };
}

// ---------------------------------------------------------------------------
// PID detection (cached across status polls; refreshed only on state change)
// ---------------------------------------------------------------------------

let cachedPid = null;
let pidLookupInFlight = null;

function lookupListeningPid() {
  if (pidLookupInFlight) return pidLookupInFlight;
  if (process.platform === 'win32') {
    return Promise.resolve(cachedPid);
  }
  pidLookupInFlight = new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-ti', `tcp:${PET_PORT}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 1500 },
      (err, stdout) => {
        pidLookupInFlight = null;
        if (err || !stdout) {
          resolve(cachedPid);
          return;
        }
        const first = stdout.trim().split(/\r?\n/).map((line) => Number(line.trim())).find((n) => Number.isInteger(n) && n > 0);
        if (first) cachedPid = first;
        resolve(cachedPid);
      }
    );
  });
  return pidLookupInFlight;
}

// ---------------------------------------------------------------------------
// Pack metadata & secure thumbnail path resolution (works online & offline)
// ---------------------------------------------------------------------------

function isValidId(id) {
  return typeof id === 'string' && VALID_ID_RE.test(id);
}

function cleanRelAssetPath(relPath) {
  if (typeof relPath !== 'string') return '';
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return '';
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return '';
  return parts.join('/');
}

function safeMtimeTag(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.isFile()) return String(Math.floor(st.mtimeMs));
  } catch { /* ignore */ }
  return '';
}

function buildThumbApiUrl(packId, variantId, versionTag = '') {
  const qs = new URLSearchParams({ packId, variantId });
  if (versionTag) qs.set('v', String(versionTag));
  return `/api/thumb?${qs.toString()}`;
}

function extractVersionTag(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const idx = rawUrl.indexOf('?v=');
  if (idx === -1) return '';
  return rawUrl.slice(idx + 3).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 24);
}

function normalizePackForPanel(pack) {
  if (!pack || !isValidId(pack.id)) return null;
  const variants = (Array.isArray(pack.variants) ? pack.variants : [])
    .filter((v) => v && isValidId(v.id))
    .map((v) => {
      const displayName = String(v.name || v.label || v.id).trim() || v.id;
      const versionTag = v.thumbMtime || extractVersionTag(v.thumbUrl) || '';
      return {
        id: v.id,
        name: displayName,
        label: displayName,
        color: typeof v.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.color.trim()) ? v.color.trim() : '#8B7BF7',
        thumbUrl: buildThumbApiUrl(pack.id, v.id, versionTag),
      };
    });
  if (variants.length === 0) return null;
  const defaultVariant = variants.some((v) => v.id === pack.defaultVariant)
    ? pack.defaultVariant
    : variants[0].id;
  return {
    id: pack.id,
    name: String(pack.name || pack.slotLabel || pack.id).trim() || pack.id,
    slotLabel: String(pack.slotLabel || pack.name || pack.id).trim() || pack.id,
    isBuiltin: Boolean(pack.isBuiltin || pack.id === 'hachimi'),
    defaultVariant,
    variants,
  };
}

function scanOfflinePacks() {
  const localPacks = [];
  try {
    if (fs.existsSync(PACKS_ROOT)) {
      const entries = fs.readdirSync(PACKS_ROOT, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        if (ent.name === 'hachimi' || !isValidId(ent.name)) continue;

        const packDir = path.join(PACKS_ROOT, ent.name);
        const packJsonPath = path.join(packDir, 'pack.json');
        if (!fs.existsSync(packJsonPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
          if (!raw || typeof raw !== 'object') continue;
          const packId = ent.name;
          const rawVariants = Array.isArray(raw.variants) ? raw.variants : [];
          const variants = rawVariants
            .filter((v) => v && isValidId(String(v.id || '').trim()))
            .map((v) => {
              const id = String(v.id).trim();
              const relThumb = cleanRelAssetPath(v.thumb || v.thumbPath || `thumbs/${id}.png`);
              const thumbMtime = relThumb ? safeMtimeTag(path.join(packDir, relThumb)) : '';
              return {
                id,
                name: String(v.name || v.label || v.displayName || id).trim() || id,
                color: v.color,
                thumbMtime,
              };
            });
          if (variants.length === 0) continue;

          const normalized = normalizePackForPanel({
            id: packId,
            name: raw.name || packId,
            slotLabel: raw.slotLabel || raw.name || packId,
            isBuiltin: false,
            defaultVariant: raw.defaultVariant,
            variants,
          });
          if (normalized) localPacks.push(normalized);
        } catch {
          // Skip unreadable pack.json cleanly
        }
      }
    }
  } catch { /* ignore */ }

  localPacks.sort((a, b) => a.id.localeCompare(b.id));

  const builtinThumbsDir = path.join(APP_DIR, 'dist', 'coopanion', 'whale', 'thumbs');
  const builtin = normalizePackForPanel({
    ...BUILTIN_HACHIMI_PACK,
    variants: BUILTIN_HACHIMI_PACK.variants.map((v) => ({
      ...v,
      thumbMtime: safeMtimeTag(path.join(builtinThumbsDir, `${v.id}.png`)),
    })),
  });

  return [...localPacks, builtin].filter(Boolean);
}

function orderPacksForPanel(packs) {
  const normalized = (Array.isArray(packs) ? packs : []).map(normalizePackForPanel).filter(Boolean);
  const custom = normalized.filter((p) => !p.isBuiltin);
  const builtin = normalized.filter((p) => p.isBuiltin);
  return [...custom, ...builtin];
}

function readOfflineSettings(packs) {
  const merged = { ...DEFAULT_SETTINGS };
  try {
    if (fs.existsSync(PET_SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(PET_SETTINGS_PATH, 'utf8'));
      if (saved && typeof saved === 'object') {
        if (typeof saved.packId === 'string' && isValidId(saved.packId)) merged.packId = saved.packId;
        if (typeof saved.scheme === 'string' && isValidId(saved.scheme)) merged.scheme = saved.scheme;
        if (typeof saved.petHidden === 'boolean') merged.petHidden = saved.petHidden;
        if (typeof saved.trayHidden === 'boolean') merged.trayHidden = saved.trayHidden;
        if (VALID_TEMPERAMENTS.has(saved.temperament)) merged.temperament = saved.temperament;
        const sc = Number(saved.mainScale ?? saved.scale);
        if (Number.isFinite(sc)) merged.mainScale = Math.min(1.4, Math.max(0.35, Math.round(sc * 100) / 100));
        if (typeof saved.showSpeechBubble === 'boolean') merged.showSpeechBubble = saved.showSpeechBubble;
        if (typeof saved.showStatusPill === 'boolean') merged.showStatusPill = saved.showStatusPill;
        if (typeof saved.showTelemetryBar === 'boolean') merged.showTelemetryBar = saved.showTelemetryBar;
      }
    }
  } catch { /* use defaults */ }

  const activePack = packs.find((p) => p.id === merged.packId) || packs[0];
  if (activePack) {
    merged.packId = activePack.id;
    if (!activePack.variants.some((v) => v.id === merged.scheme)) {
      merged.scheme = activePack.defaultVariant;
    }
  }
  return merged;
}

function pickPanelSettings(rawSettings, fallbackPacks) {
  const base = readOfflineSettings(fallbackPacks);
  if (!rawSettings || typeof rawSettings !== 'object') return base;
  const sc = Number(rawSettings.mainScale ?? rawSettings.scale);
  return {
    packId: typeof rawSettings.packId === 'string' ? rawSettings.packId : base.packId,
    scheme: typeof rawSettings.scheme === 'string' ? rawSettings.scheme : base.scheme,
    petHidden: typeof rawSettings.petHidden === 'boolean' ? rawSettings.petHidden : base.petHidden,
    trayHidden: typeof rawSettings.trayHidden === 'boolean' ? rawSettings.trayHidden : base.trayHidden,
    temperament: VALID_TEMPERAMENTS.has(rawSettings.temperament) ? rawSettings.temperament : base.temperament,
    mainScale: Number.isFinite(sc) ? Math.min(1.4, Math.max(0.35, Math.round(sc * 100) / 100)) : base.mainScale,
    showSpeechBubble: typeof rawSettings.showSpeechBubble === 'boolean' ? rawSettings.showSpeechBubble : base.showSpeechBubble,
    showStatusPill: typeof rawSettings.showStatusPill === 'boolean' ? rawSettings.showStatusPill : base.showStatusPill,
    showTelemetryBar: typeof rawSettings.showTelemetryBar === 'boolean' ? rawSettings.showTelemetryBar : base.showTelemetryBar,
  };
}

function resolveThumbFile(packId, variantId) {
  if (!isValidId(packId) || !isValidId(variantId)) return null;

  if (packId === 'hachimi') {
    if (!BUILTIN_VARIANT_IDS.has(variantId)) return null;
    const baseCandidates = [
      path.join(APP_DIR, 'dist', 'coopanion', 'whale', 'thumbs'),
      path.join(APP_DIR, 'public', 'coopanion', 'whale', 'thumbs'),
    ];
    for (const baseDir of baseCandidates) {
      let realBase;
      try {
        realBase = fs.realpathSync(baseDir);
      } catch {
        continue;
      }
      const target = path.join(realBase, `${variantId}.png`);
      try {
        const realTarget = fs.realpathSync(target);
        if (!realTarget.startsWith(realBase + path.sep)) continue;
        const st = fs.statSync(realTarget);
        if (st.isFile() && st.size <= MAX_THUMB_BYTES) {
          return { filePath: realTarget, contentType: 'image/png' };
        }
      } catch { /* try next */ }
    }
    return null;
  }

  let realPacksRoot;
  let realPackDir;
  try {
    realPacksRoot = fs.realpathSync(PACKS_ROOT);
    realPackDir = fs.realpathSync(path.join(realPacksRoot, packId));
  } catch {
    return null;
  }
  if (!realPackDir.startsWith(realPacksRoot + path.sep)) return null;

  const relCandidates = [];
  try {
    const packJsonPath = path.join(realPackDir, 'pack.json');
    const raw = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
    const variant = Array.isArray(raw?.variants)
      ? raw.variants.find((v) => String(v?.id || '').trim() === variantId)
      : null;
    if (variant) {
      const configured = cleanRelAssetPath(variant.thumb || variant.thumbPath || '');
      if (configured) relCandidates.push(configured);
    }
  } catch { /* fallback below */ }

  relCandidates.push(
    `thumbs/${variantId}.png`,
    `thumbs/${variantId}.webp`,
    `${variantId}/thumb.png`,
    `${variantId}/thumb.webp`
  );

  for (const rel of relCandidates) {
    const cleaned = cleanRelAssetPath(rel);
    if (!cleaned) continue;
    const ext = path.extname(cleaned).toLowerCase();
    const contentType = THUMB_MIME[ext];
    if (!contentType) continue;

    const candidate = path.resolve(realPackDir, cleaned);
    if (!candidate.startsWith(realPackDir + path.sep)) continue;

    try {
      const realTarget = fs.realpathSync(candidate);
      if (!realTarget.startsWith(realPackDir + path.sep)) continue;
      const st = fs.statSync(realTarget);
      if (st.isFile() && st.size <= MAX_THUMB_BYTES) {
        return { filePath: realTarget, contentType };
      }
    } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Power lifecycle control (mutex-serialized, detached launch, health polling)
// ---------------------------------------------------------------------------

let powerChain = Promise.resolve();
let busyAction = null; // null | 'starting' | 'stopping' | 'restarting'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runExclusivePower(actionLabel, fn) {
  const next = powerChain.then(async () => {
    busyAction = actionLabel;
    try {
      return await fn();
    } finally {
      busyAction = null;
    }
  });
  powerChain = next.catch(() => {});
  return next;
}

function spawnDetachedLauncher() {
  if (!fs.existsSync(LAUNCH_SCRIPT)) {
    throw new Error('找不到桌宠启动脚本 scripts/launch-pet.mjs');
  }
  const launcherEnv = {
    ...process.env,
    HACHIMI_PET_PORT: String(PET_PORT),
  };
  delete launcherEnv.NODE_OPTIONS;

  const child = spawn(process.execPath, [LAUNCH_SCRIPT], {
    cwd: PLUGIN_ROOT,
    env: launcherEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdoutBuf.length < 16384) stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = (lines.pop() || '').slice(-4096);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
            cachedPid = parsed.pid;
          }
        } catch { /* ignore partial lines */ }
      }
    });
    child.stdout.unref?.();
  }

  let stderrBuf = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrBuf.length < 4096) stderrBuf += chunk;
    });
    child.stderr.unref?.();
  }

  child.on('error', (err) => {
    console.error('[hachimi-sidecar] failed to spawn launch-pet.mjs:', err?.message || err);
  });
  child.on('exit', (code, signal) => {
    const errText = stderrBuf.trim();
    if ((code !== 0 && code !== null) || signal || errText) {
      console.error(
        `[hachimi-sidecar] launch-pet.mjs exited (code=${code}, signal=${signal || 'none'})${errText ? `: ${errText}` : ''}`
      );
    }
  });

  child.unref();
  return child;
}

async function waitForHealthState(expectedRunning, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const { running } = await checkPetHealth(600);
    if (running === expectedRunning) return true;
    await sleep(intervalMs);
  }
  const finalCheck = await checkPetHealth(600);
  return finalCheck.running === expectedRunning;
}

async function performPowerOn() {
  writeSidecarState({ enabled: true });
  const initial = await checkPetHealth(800);
  if (initial.running) {
    if (!cachedPid) await lookupListeningPid();
    return { ok: true, alreadyRunning: true };
  }

  spawnDetachedLauncher();
  const up = await waitForHealthState(true, 15000, 300);
  if (!up) {
    return { ok: false, error: '启动桌宠超时（15 秒内未就绪），请稍后再试。' };
  }
  await lookupListeningPid();
  return { ok: true };
}

async function performPowerOff() {
  writeSidecarState({ enabled: false });
  const initial = await checkPetHealth(800);
  if (!initial.running) {
    cachedPid = null;
    return { ok: true, alreadyStopped: true };
  }

  await petRequestJson('/api/quit', { method: 'POST', body: {}, timeoutMs: 2000 });
  const down = await waitForHealthState(false, 5000, 200);
  if (!down) {
    return { ok: false, error: '关闭桌宠超时，桌面进程仍在响应。' };
  }
  cachedPid = null;
  return { ok: true };
}

async function performPowerRestart() {
  writeSidecarState({ enabled: true });
  const initial = await checkPetHealth(800);
  if (initial.running) {
    await petRequestJson('/api/quit', { method: 'POST', body: {}, timeoutMs: 2000 });
    const down = await waitForHealthState(false, 5000, 200);
    if (!down) {
      return { ok: false, error: '重启失败：旧桌宠进程未在 5 秒内退出。' };
    }
    cachedPid = null;
    await sleep(250);
  }

  spawnDetachedLauncher();
  const up = await waitForHealthState(true, 15000, 300);
  if (!up) {
    return { ok: false, error: '重启超时：桌宠未能重新拉起，请稍后再试。' };
  }
  await lookupListeningPid();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Aggregated status snapshot
// ---------------------------------------------------------------------------

async function buildStatus() {
  const sidecarState = readSidecarState();
  const { running, health } = await checkPetHealth(1000);

  let packs;
  let settings;
  let pid = null;

  if (running) {
    const [stateRes, packsRes, resolvedPid] = await Promise.all([
      petRequestJson('/api/state', { method: 'GET', timeoutMs: 1800 }),
      petRequestJson('/api/packs', { method: 'GET', timeoutMs: 1800 }),
      cachedPid ? Promise.resolve(cachedPid) : lookupListeningPid(),
    ]);
    pid = resolvedPid || null;

    const livePacks = packsRes.ok && Array.isArray(packsRes.data?.packs)
      ? packsRes.data.packs
      : (stateRes.ok && Array.isArray(stateRes.data?.packs) ? stateRes.data.packs : null);

    packs = livePacks ? orderPacksForPanel(livePacks) : scanOfflinePacks();
    settings = pickPanelSettings(stateRes.ok ? stateRes.data?.settings : null, packs);
  } else {
    cachedPid = null;
    packs = scanOfflinePacks();
    settings = readOfflineSettings(packs);
  }

  const activePack = packs.find((p) => p.id === settings.packId) || packs[0] || null;
  const activePackId = activePack ? activePack.id : settings.packId;
  const activeVariant = activePack
    ? (activePack.variants.find((v) => v.id === settings.scheme) || activePack.variants.find((v) => v.id === activePack.defaultVariant) || activePack.variants[0])
    : null;
  const activeVariantId = activeVariant ? activeVariant.id : settings.scheme;

  return {
    ok: true,
    running,
    pid,
    enabled: sidecarState.enabled,
    busyAction,
    health,
    settings,
    packs,
    activePackId,
    activeVariantId,
    workshopUrl: WORKSHOP_URL,
  };
}

// ---------------------------------------------------------------------------
// Route handlers (shared by SidecarApp and Standalone HTTP Server)
// ---------------------------------------------------------------------------

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function readStaticAssetResponse(fileName, contentType) {
  try {
    const content = fs.readFileSync(path.join(__dirname, fileName), 'utf8');
    return makeResponse(content, {
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const isNotFound = err?.code === 'ENOENT';
    console.error(`[hachimi-sidecar] failed to read static asset ${fileName}:`, err?.message || err);
    return makeResponse(
      isNotFound ? 'Static asset not found' : 'Failed to load static asset',
      {
        contentType: 'text/plain; charset=utf-8',
        status: isNotFound ? 404 : 500,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}

function registerRoutes(registrar) {
  registrar.page('/', () => readStaticAssetResponse('index.html', 'text/html; charset=utf-8'));

  for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
    registrar.api(
      route,
      () => readStaticAssetResponse(file, contentType),
      'GET'
    );
  }

  registrar.api('/favicon.ico', () => makeResponse('', {
    contentType: 'image/x-icon',
    status: 204,
    headers: { 'Cache-Control': 'private, max-age=86400' },
  }), 'GET');

  registrar.api('/api/status', async () => {
    return makeJsonResponse(await buildStatus(), 200);
  }, 'GET');

  registrar.api('/api/power', async (data) => {
    const action = typeof data?.action === 'string' ? data.action.trim().toLowerCase() : '';
    if (!['on', 'off', 'restart'].includes(action)) {
      return makeJsonResponse({ ok: false, error: '无效的电源操作，仅支持开启、关闭或重启。' }, 400);
    }

    const label = action === 'on' ? 'starting' : action === 'off' ? 'stopping' : 'restarting';
    const result = await runExclusivePower(label, async () => {
      if (action === 'on') return performPowerOn();
      if (action === 'off') return performPowerOff();
      return performPowerRestart();
    });

    const status = await buildStatus();
    if (!result.ok) {
      return makeJsonResponse({ ok: false, action, error: result.error || '操作失败，请稍后重试。', status }, 502);
    }
    return makeJsonResponse({ ok: true, action, status }, 200);
  }, 'POST');

  registrar.api('/api/select', async (data) => {
    const packId = typeof data?.packId === 'string' ? data.packId.trim() : '';
    const variantId = typeof (data?.variantId ?? data?.scheme) === 'string'
      ? String(data.variantId ?? data.scheme).trim()
      : '';

    if (!isValidId(packId) || (variantId && !isValidId(variantId))) {
      return makeJsonResponse({ ok: false, error: '形象包或角色标识无效。' }, 400);
    }

    const { running } = await checkPetHealth(800);
    if (!running) {
      const powerRes = await runExclusivePower('starting', performPowerOn);
      if (!powerRes.ok) {
        return makeJsonResponse({
          ok: false,
          error: powerRes.error || '拉起桌宠失败，无法切换角色。',
          status: await buildStatus(),
        }, 502);
      }
    }

    const payload = variantId ? { packId, scheme: variantId } : { packId };
    const res = await petRequestJson('/api/packs/select', { method: 'POST', body: payload, timeoutMs: 3000 });
    const status = await buildStatus();
    if (!res.ok || !res.data?.ok) {
      return makeJsonResponse({
        ok: false,
        error: res.data?.error || res.error || '切换形象失败，请稍后重试。',
        status,
      }, res.status >= 400 ? res.status : 502);
    }
    return makeJsonResponse({ ok: true, status }, 200);
  }, 'POST');

  registrar.api('/api/settings', async (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return makeJsonResponse({ ok: false, error: '设置参数格式无效。' }, 400);
    }

    const patch = {};
    for (const key of ['petHidden', 'trayHidden', 'showSpeechBubble', 'showStatusPill', 'showTelemetryBar']) {
      if (typeof data[key] === 'boolean') patch[key] = data[key];
    }
    if (typeof data.temperament === 'string') {
      const t = data.temperament.trim();
      if (!VALID_TEMPERAMENTS.has(t)) {
        return makeJsonResponse({ ok: false, error: '互动模式仅支持日常、内敛或活泼。' }, 400);
      }
      patch.temperament = t;
    }
    if (data.mainScale !== undefined) {
      const n = Number(data.mainScale);
      if (!Number.isFinite(n)) {
        return makeJsonResponse({ ok: false, error: '主宠尺寸数值无效。' }, 400);
      }
      patch.mainScale = Math.min(1.4, Math.max(0.35, Math.round(n * 100) / 100));
    }

    if (Object.keys(patch).length === 0) {
      return makeJsonResponse({ ok: false, error: '未提供可更新的设置项。' }, 400);
    }

    const { running } = await checkPetHealth(800);
    if (!running) {
      return makeJsonResponse({
        ok: false,
        error: '桌宠尚未启动，请先打开主开关。',
        status: await buildStatus(),
      }, 409);
    }

    const res = await petRequestJson('/api/settings', { method: 'POST', body: patch, timeoutMs: 2500 });
    const status = await buildStatus();
    if (!res.ok || !res.data?.ok) {
      return makeJsonResponse({
        ok: false,
        error: res.data?.error || res.error || '更新设置失败，请稍后重试。',
        status,
      }, 502);
    }
    return makeJsonResponse({ ok: true, settings: status.settings, status }, 200);
  }, 'POST');

  registrar.api('/api/wave', async (data) => {
    const { running } = await checkPetHealth(800);
    if (!running) {
      return makeJsonResponse({
        ok: false,
        error: '桌宠尚未启动，请先打开主开关。',
        status: await buildStatus(),
      }, 409);
    }

    const message = typeof data?.message === 'string' && data.message.trim()
      ? data.message.trim().slice(0, 60)
      : '哈基米向你挥手打招呼！';
    const expression = typeof data?.expression === 'string' && data.expression.trim()
      ? data.expression.trim().slice(0, 24)
      : 'happy';
    const motion = typeof data?.motion === 'string' && data.motion.trim()
      ? data.motion.trim().slice(0, 24)
      : 'wave';

    const res = await petRequestJson('/api/mcp/notify', {
      method: 'POST',
      body: { message, expression, motion },
      timeoutMs: 2500,
    });
    if (!res.ok) {
      return makeJsonResponse({ ok: false, error: res.error || '向桌宠打招呼失败。' }, 502);
    }
    return makeJsonResponse({ ok: true }, 200);
  }, 'POST');

  registrar.api('/api/thumb', (data) => {
    const packId = typeof data?.packId === 'string' ? data.packId.trim() : '';
    const variantId = typeof data?.variantId === 'string' ? data.variantId.trim() : '';
    if (!isValidId(packId) || !isValidId(variantId)) {
      return makeResponse('Invalid thumbnail parameters', { status: 400 });
    }
    const resolved = resolveThumbFile(packId, variantId);
    if (!resolved) {
      return makeResponse('Not found', { status: 404 });
    }
    try {
      const bytes = fs.readFileSync(resolved.filePath);
      return makeResponse(bytes, {
        contentType: resolved.contentType,
        status: 200,
        headers: {
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return makeResponse('Not found', { status: 404 });
    }
  }, 'GET');
}

// ---------------------------------------------------------------------------
// Standalone loopback HTTP server (for headless verification without LS env)
// ---------------------------------------------------------------------------

function createStandaloneServer(port) {
  const pages = new Map();
  const apis = new Map();

  const registrar = {
    page(route, handler) {
      pages.set(route, handler);
    },
    api(route, handler, method = 'POST') {
      if (!apis.has(route)) apis.set(route, new Map());
      apis.get(route).set(method.toUpperCase(), handler);
    },
  };

  registerRoutes(registrar);
  pages.set('/preload.js', () => makeResponse(
    '/* standalone preview stub */\n',
    { contentType: 'application/javascript; charset=utf-8', headers: { 'Cache-Control': 'no-store' } }
  ));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && pages.has(url.pathname)) {
      try {
        const result = await pages.get(url.pathname)();
        if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
          const out = typeof result.body === 'string' ? result.body : Buffer.from(result.body);
          res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
          res.end(out);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(String(result ?? ''));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal error' }));
      }
      return;
    }

    if (apis.has(url.pathname)) {
      const methodMap = apis.get(url.pathname);
      if (!methodMap.has(req.method)) {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
        return;
      }
      const handler = methodMap.get(req.method);
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total <= 1024 * 1024) chunks.push(c);
      });
      req.on('end', async () => {
        try {
          const data = {};
          for (const [k, v] of url.searchParams.entries()) {
            if (k.toLowerCase() !== 'token') data[k] = v;
          }
          const rawBody = Buffer.concat(chunks).toString('utf8').trim();
          if (rawBody) {
            const parsed = JSON.parse(rawBody);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              Object.assign(data, parsed);
            }
          }
          const result = await handler(data);
          if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
            const out = typeof result.body === 'string' ? result.body : Buffer.from(result.body);
            res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
            res.end(out);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(err instanceof SyntaxError ? 400 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal error' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address()?.port || port;
      console.log(`[hachimi-sidecar] standalone listening on 127.0.0.1:${actualPort}`);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Async startup attach / auto-launch (never blocks app.run())
// ---------------------------------------------------------------------------

function scheduleStartupCheck() {
  if (process.env.HACHIMI_SIDECAR_NO_AUTOLAUNCH === '1') return;
  const { enabled } = readSidecarState();
  if (!enabled) return;

  queueMicrotask(async () => {
    try {
      const { running } = await checkPetHealth(1200);
      if (running) {
        await lookupListeningPid();
        return;
      }
      await runExclusivePower('starting', performPowerOn);
    } catch (err) {
      console.error('[hachimi-sidecar] startup check error:', err?.message || err);
    }
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (!IS_SIDECAR_ENV && STANDALONE_PORT > 0) {
  await createStandaloneServer(STANDALONE_PORT);
  if (process.env.HACHIMI_SIDECAR_AUTOLAUNCH === '1') {
    scheduleStartupCheck();
  }
} else {
  const sdk = await import('sidecar_sdk');
  SdkResponse = sdk.Response;
  const app = new sdk.SidecarApp();
  registerRoutes(app);
  await app.run();
  scheduleStartupCheck();
}
