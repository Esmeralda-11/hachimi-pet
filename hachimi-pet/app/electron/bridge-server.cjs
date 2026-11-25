const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { WebSocketServer } = require('./mini-ws.cjs');
const { TranscriptWatcher } = require('./transcript-watcher.cjs');
const { AgyRunner } = require('./agy-runner.cjs');
const { SubagentTracker } = require('./subagent-tracker.cjs');
const {
  readLatestDbTelemetry,
  buildTranscriptTelemetry,
  buildCompactedTelemetry,
  readInitialTranscriptTelemetry,
} = require('./telemetry-reader.cjs');
const {
  ANNOTATIONS_DIR,
  loadAntigravityCatalog,
  readSingleAnnotation,
  isTranscriptLikelySubagent,
  findTranscriptPath,
  saveConversationAnnotationTitle,
  formatRelativeTime,
} = require('./antigravity-catalog.cjs');
const packRegistry = require('./pack-registry.cjs');
const {
  scanPacks,
  resolveLocalPackFile,
  resolveThumbFilePath,
  createOrUpdateLocalPack,
  renameLocalPackOrVariant,
  moveLocalPackVariant,
  deleteLocalPackOrVariant,
  inspectLocalPackVariant,
  editLocalPackFrame,
  prepareModelStyleInputs,
  decodeInputImageBuffer,
} = packRegistry;
const {
  exportVariantStyleAnchorPng,
  generateStylizedTurnaround,
  generateRedrawnRowWithModel,
} = require('./ai-style-generator.cjs');

const DEFAULT_PORT = Number(process.env.HACHIMI_PET_PORT || process.env.AGY_WHALE_PORT || 17890);
const DATA_DIR = process.env.HACHIMI_DATA_DIR
  ? path.resolve(process.env.HACHIMI_DATA_DIR)
  : path.join(os.homedir(), '.agy-whale-pet');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PARENT_WORKSPACE = path.resolve(PROJECT_ROOT, '..');

function resolveReviewKitScriptPath() {
  if (process.env.HACHIMI_REVIEW_KIT_SCRIPT) {
    return path.resolve(process.env.HACHIMI_REVIEW_KIT_SCRIPT);
  }
  return path.resolve(PROJECT_ROOT, '..', '..', 'six-cats-frames-review', 'build_review_kit.py');
}

function resolveReviewKitPythonBin() {
  if (typeof packRegistry.findPythonWithPil === 'function') {
    try {
      const found = packRegistry.findPythonWithPil();
      if (found) return found;
    } catch { /* fall through */ }
  }
  return 'python3';
}

function sanitizeWorkspace(dir) {
  if (!dir || typeof dir !== 'string') return PARENT_WORKSPACE;
  if (/[\\/]\.gemini[\\/]/i.test(dir)) return PARENT_WORKSPACE;
  return fs.existsSync(dir) ? dir : PARENT_WORKSPACE;
}

function isNativeCliSession(cid, transcriptPath = '') {
  if (!cid || cid === 'default-session' || cid.startsWith('local-')) return false;
  if (String(transcriptPath).toLowerCase().includes('antigravity-cli')) return true;
  const cliDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', cid);
  return fs.existsSync(cliDir);
}

const RISKY_CMD_REGEX = /\b(rm\s+-rf|Remove-Item\b.*-Recurse|del\s+\/[fsq]|git\s+push\b.*--force|git\s+reset\s+--hard|format\s+[a-z]:|drop\s+(table|database)|shutdown\b|Restart-Computer)\b/i;

const LEGACY_WHALE_SCHEME_MAP = {
  gemini: 'astral',
  deepseek: 'azure',
  claude: 'amber',
  minimax: 'sakura',
  qwen: 'astral',
  kimi: 'emerald',
  chatgpt: 'arctic',
  harness: 'obsidian',
};
const VALID_WHALE_SCHEMES = new Set(['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian']);

function resolveSchemeForPack(pack, rawScheme) {
  if (!pack || !Array.isArray(pack.variants) || pack.variants.length === 0) {
    return 'astral';
  }
  const str = String(rawScheme || '').trim();
  const low = str.toLowerCase();
  if (pack.id === 'hachimi') {
    if (VALID_WHALE_SCHEMES.has(low)) return low;
    if (LEGACY_WHALE_SCHEME_MAP[low]) return LEGACY_WHALE_SCHEME_MAP[low];
    return pack.defaultVariant || 'astral';
  }
  const exact = pack.variants.find((v) => v.id === str);
  if (exact) return exact.id;
  const ci = pack.variants.find((v) => v.id.toLowerCase() === low);
  if (ci) return ci.id;
  return pack.defaultVariant || pack.variants[0].id;
}

const VALID_TEMPERAMENTS = new Set(['lively', 'daily', 'quiet']);
const VALID_THEMES = new Set(['system', 'light', 'dark']);
const VALID_PALETTES = new Set(['forest', 'ocean', 'plum', 'amber', 'graphite']);

function normalizePaletteId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (VALID_PALETTES.has(s)) return s;
  if (s === 'meadow' || s === 'porcelain') return 'forest';
  return 'forest';
}

const TECH_LEAK_RE = /(?:Traceback|Command failed|\b(?:Error|Exception|SyntaxError|TypeError|ReferenceError|ENOENT|EINVAL|EACCES|EPERM|ECONNREFUSED)\b|invalid arguments|maxItems|ImagePaths|got \d+,\s*want \d+|stream-json|statusCode|\/Users\/|\/Volumes\/|\/var\/|\/tmp\/|[A-Za-z]:\\|127\.0\.0\.1|localhost:\d+)/i;

function sanitizeHumanErrorText(msg, fallback) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  if (!s || TECH_LEAK_RE.test(s) || !/[\u4e00-\u9fff]/.test(s)) {
    return fallback;
  }
  return s;
}

function humanizeBridgeError(err, fallback = '处理图片或请求时遇到一点问题，请换一张图片或稍后再试。') {
  const raw = String(err?.message || err || '');
  if (err instanceof SyntaxError) {
    return '提交的数据格式有误，请刷新页面后再试。';
  }
  if (typeof packRegistry.toHumanErrorMessage === 'function') {
    try {
      const translated = packRegistry.toHumanErrorMessage(err);
      if (translated) {
        return sanitizeHumanErrorText(translated, fallback);
      }
    } catch { /* fall through */ }
  }
  if (/maxitems|imagepaths|invalid arguments/i.test(raw)) {
    return '发送给模型的参考图参数超出限制，请减少参考图数量或关闭「模型协助生成」直接导入。';
  }
  if (/quota|rate limit|resource exhausted|429/i.test(raw)) {
    return '模型调用额度暂满或请求过于频繁，请稍后再试或关闭「模型协助生成」直接导入。';
  }
  if (err?.statusCode === 413 || /payload too large|entity too large/i.test(raw)) {
    return '上传的图片或数据总体积太大了，建议减少单次数量或换中小尺寸图片再试。';
  }
  if (/unexpected token|unexpected end of json|invalid json/i.test(raw)) {
    return '提交的数据格式有误，请刷新页面后再试。';
  }
  if (/no input|missing image/i.test(raw)) {
    return '请先上传至少一张角色图片，再开始生成。';
  }
  if (/unsupported|invalid|decode|corrupt|heic|avif|svg|tiff/i.test(raw)) {
    return '这张图片格式暂不支持或文件已损坏，请改用 PNG、JPG、WebP 或动图 GIF。';
  }
  return sanitizeHumanErrorText(raw, fallback);
}

function clampNumber(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
}

function normalizeSettingsBooleans(target, defaults) {
  const boolKeys = [
    'petHidden',
    'trayHidden',
    'showSpeechBubble',
    'showStatusPill',
    'showTelemetryBar',
    'showSubagentHud',
    'soundOn',
    'autoSchemeByModel',
    'safetyGateEnabled',
    'interceptRiskyOnly',
    'interceptAllCommands',
  ];
  for (const key of boolKeys) {
    target[key] = typeof target[key] === 'boolean' ? target[key] : defaults[key];
  }
}

function loadSettings(packs = scanPacks()) {
  const initialProjects = Array.from(new Set([PARENT_WORKSPACE, PROJECT_ROOT]));
  const sixCatsPack = packs.find((p) => p.id === 'six-cats');
  const hachimiPack = packs.find((p) => p.id === 'hachimi') || packs[0];

  const defaults = {
    mode: 'companion',          // 'companion' | 'standalone'
    packId: sixCatsPack ? 'six-cats' : 'hachimi',
    scheme: sixCatsPack ? resolveSchemeForPack(sixCatsPack, '22') : 'astral',
    outfit: 'maid',             // 'maid' (Starry Gothic Dress)
    autoSchemeByModel: false,   // Auto-switch color scheme based on modelName (when packId === 'hachimi')
    roam: 'free',               // 'free' | 'off' (pinned corner)
    temperament: 'daily',       // 'lively' | 'daily' | 'quiet'
    theme: 'system',            // 'system' | 'light' | 'dark'
    palette: 'forest',          // 'forest' | 'ocean' | 'plum' | 'amber' | 'graphite'
    mainScale: 0.85,            // 0.35..1.40 (中 = 85%)
    subagentScale: 0.80,        // 0.30..1.35 (中 = 80%)
    scale: 0.85,                // kept in sync with mainScale
    petHidden: false,
    trayHidden: false,
    showSpeechBubble: true,
    showStatusPill: true,
    showTelemetryBar: true,
    showSubagentHud: true,
    soundOn: true,
    safetyGateEnabled: false,   // Toggle PreToolUse hook on run_command
    interceptRiskyOnly: true,   // Pop Allow/Deny bubble on risky run_command
    interceptAllCommands: false,// Pop Allow/Deny bubble on EVERY run_command
    defaultWorkspace: sanitizeWorkspace(process.cwd()),
    savedProjects: initialProjects,
    selectedProject: PARENT_WORKSPACE,
  };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      const hasMainScale = typeof saved.mainScale === 'number' && Number.isFinite(saved.mainScale);

      saved.defaultWorkspace = sanitizeWorkspace(saved.defaultWorkspace);
      const mergedProjects = Array.from(
        new Set([...(Array.isArray(saved.savedProjects) ? saved.savedProjects : []), ...initialProjects])
      ).filter((p) => typeof p === 'string' && !/[\\/]\.gemini[\\/]/i.test(p) && fs.existsSync(p));
      saved.savedProjects = mergedProjects.length > 0 ? mergedProjects : initialProjects;
      saved.selectedProject = sanitizeWorkspace(saved.selectedProject || saved.defaultWorkspace);
      if (!saved.savedProjects.includes(saved.selectedProject)) {
        saved.savedProjects.unshift(saved.selectedProject);
      }

      const hasSavedPackId = typeof saved.packId === 'string' && saved.packId.trim().length > 0;
      let resolvedPack = null;
      let resolvedScheme = 'astral';

      if (!hasSavedPackId) {
        if (sixCatsPack) {
          resolvedPack = sixCatsPack;
          resolvedScheme = resolveSchemeForPack(sixCatsPack, '22');
        } else {
          resolvedPack = hachimiPack;
          resolvedScheme = resolveSchemeForPack(hachimiPack, saved.scheme);
        }
      } else {
        resolvedPack = packs.find((p) => p.id === saved.packId.trim()) || hachimiPack;
        resolvedScheme = resolveSchemeForPack(resolvedPack, saved.scheme);
      }

      saved.packId = resolvedPack.id;
      saved.scheme = resolvedScheme;
      saved.outfit = 'maid';

      const merged = { ...defaults, ...saved };
      const hasValidTheme = typeof saved.theme === 'string' && VALID_THEMES.has(saved.theme);
      const hasValidPalette = typeof saved.palette === 'string' && VALID_PALETTES.has(saved.palette);
      if (!hasMainScale) {
        merged.mainScale = 0.85;
        merged.scale = 0.85;
        merged.subagentScale = 0.80;
        merged.temperament = 'daily';
      } else {
        merged.mainScale = clampNumber(merged.mainScale, 0.35, 1.40, 0.85);
        merged.scale = merged.mainScale;
        merged.subagentScale = clampNumber(merged.subagentScale, 0.30, 1.35, 0.80);
        merged.temperament = VALID_TEMPERAMENTS.has(merged.temperament) ? merged.temperament : 'daily';
      }
      merged.theme = hasValidTheme ? saved.theme : 'system';
      merged.palette = normalizePaletteId(saved.palette);
      merged.mode = merged.mode === 'standalone' ? 'standalone' : 'companion';
      merged.roam = merged.roam === 'off' ? 'off' : 'free';
      normalizeSettingsBooleans(merged, defaults);

      if (!hasMainScale || !hasValidTheme || !hasValidPalette) {
        saveSettings(merged);
      }
      return merged;
    }
  } catch { /* ignore */ }
  return defaults;
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function shortPath(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function mapToolPresentation(toolName, args = {}) {
  const name = String(toolName || '').toLowerCase();
  if (/read_file|view_file|list_dir|find_by_name|grep_search/.test(name)) {
    const target = shortPath(args.Path || args.SearchPath || args.DirectoryPath || args.Query || '');
    return {
      status: 'READING',
      badge: `查阅 ${target || name}`,
      expression: 'determined',
      motion: 'look',
      thinking: false,
    };
  }
  if (/edit_file|write_file|replace|multi_replace/.test(name)) {
    const target = shortPath(args.Path || args.TargetFile || '');
    return {
      status: 'CODING',
      badge: `编辑 ${target || '代码'}`,
      expression: 'determined',
      motion: 'nod',
      thinking: false,
    };
  }
  if (/run_command/.test(name)) {
    const cmd = String(args.CommandLine || args.command || '').trim();
    const shortCmd = cmd.length > 42 ? cmd.slice(0, 40) + '…' : cmd;
    return {
      status: 'RUNNING_CMD',
      badge: `执行 ${shortCmd || '命令'}`,
      expression: 'determined',
      motion: 'nod',
      thinking: false,
    };
  }
  if (/search_web|read_url|browser/.test(name)) {
    const q = String(args.query || args.Url || '').trim();
    return {
      status: 'READING',
      badge: `检索 ${q.slice(0, 34) || '网页'}`,
      expression: 'thinking',
      motion: 'look',
      thinking: true,
    };
  }
  if (/invoke_subagent|send_message/.test(name)) {
    return {
      status: 'THINKING',
      badge: `调度子代理 · ${args.Role || args.TypeName || '协作任务'}`,
      expression: 'love',
      motion: 'wave',
      thinking: true,
    };
  }
  if (/^swarm$|post_message|read_board/.test(name)) {
    return {
      status: 'THINKING',
      badge: `蜂群协作 · ${args.name || args.action || 'Swarm'}`,
      expression: 'excited',
      motion: 'jump',
      thinking: true,
    };
  }
  if (/ask_question/.test(name)) {
    return {
      status: 'WAITING_USER',
      badge: '等待确认',
      expression: 'confused',
      motion: 'wave',
      thinking: false,
    };
  }
  return {
    status: 'THINKING',
    badge: `调用 ${toolName}`,
    expression: 'thinking',
    motion: null,
    thinking: true,
  };
}

function detectSchemeForModel(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini') || m.includes('argon')) return 'astral';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'amber';
  if (m.includes('gpt') || m.includes('codex') || m.includes('o1') || m.includes('o3')) return 'arctic';
  if (m.includes('deepseek')) return 'azure';
  if (m.includes('qwen')) return 'astral';
  if (m.includes('kimi')) return 'emerald';
  if (m.includes('minimax')) return 'sakura';
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function serveLocalPackAsset(reqPath, res, isHead = false) {
  const prefix = '/local-packs/';
  if (!reqPath.startsWith(prefix)) return false;
  let decoded = '';
  try {
    decoded = decodeURIComponent(reqPath.slice(prefix.length));
  } catch {
    return false;
  }
  const slashIdx = decoded.indexOf('/');
  if (slashIdx <= 0) return false;
  const packId = decoded.slice(0, slashIdx);
  const relPath = decoded.slice(slashIdx + 1);
  const filePath = resolveLocalPackFile(packId, relPath);
  if (!filePath) return false;

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (isHead) {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

function isAllowedLocalOrigin(origin) {
  return typeof origin === 'string' && LOCAL_ORIGIN_RE.test(origin.trim());
}

function serveStaticFile(reqPath, res, isHead = false) {
  const projectRoot = path.join(__dirname, '..');
  const distDir = path.join(projectRoot, 'dist');
  const publicDir = path.join(projectRoot, 'public');
  let cleanRel = '';
  try {
    cleanRel = decodeURIComponent(reqPath === '/' ? '/index.html' : reqPath).replace(/^\/+/, '');
  } catch {
    return false;
  }
  if (cleanRel.includes('\0')) return false;
  const baseDirs = cleanRel === 'workshop.html' ? [publicDir, distDir] : [distDir, publicDir];

  for (const baseDir of baseDirs) {
    const resolvedBase = path.resolve(baseDir);
    const candidate = path.resolve(resolvedBase, cleanRel);
    if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + path.sep)) continue;
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          const ext = path.extname(candidate).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
          });
          if (isHead) {
            res.end();
          } else {
            fs.createReadStream(candidate).pipe(res);
          }
          return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}

function createBridgeServer({ port = DEFAULT_PORT, onShowPanel, onCheckPixels, onGetMouseState, onPackChange, onQuit } = {}) {
  let packs = scanPacks();
  let settings = loadSettings(packs);
  let whaleDiag = null;
  let hostMouseState = null;
  let rendererLogs = [];
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, string>} Maps companion CLI trajectory ID -> parent Desktop session ID */
  const linkedCliToOwner = new Map();
  /** @type {Array<any>} Antigravity Projects & Conversations catalog */
  let antigravityProjects = [];
  /** @type {Set<string>} Known subagent/swarm child conversation IDs */
  const knownChildIds = new Set();
  let activeConversationId = null;
  let lastReactionMotionAt = 0;
  let lastStatusChangeAt = 0;
  let lastToolStatusChangeAt = 0;
  /** @type {Map<string, NodeJS.Timeout>} */
  const awaitingIdleTimers = new Map();
  /** @type {Map<string, number>} */
  const awaitingSinceMap = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const toolDebounceTimers = new Map();

  function getActivePack() {
    return packs.find((p) => p.id === settings.packId) || packs.find((p) => p.id === 'hachimi') || packs[0];
  }

  const LEADING_EMOJI_RE = /^(?:[\u{1F000}-\u{1FAFF}\u2190-\u2BFF\uFE00-\uFE0F\u200D]+\s*)+/u;

  function getBadgeEmoji() {
    return '';
  }

  function cleanBadgeText(text) {
    return String(text || '').replace(LEADING_EMOJI_RE, '').trim();
  }

  function refreshActiveBadgesEmoji() {
    for (const s of sessions.values()) {
      if (typeof s.badge === 'string' && s.badge) {
        const cleaned = cleanBadgeText(s.badge);
        s.badge = cleaned || '待机';
      }
    }
  }

  function applySettingsUpdate(patch = {}, { forceBroadcastScheme = false } = {}) {
    if (!patch || typeof patch !== 'object') return settings;
    const prevSnapshot = JSON.stringify(settings);
    const prevPackId = settings.packId;
    const prevScheme = settings.scheme;
    const prevOutfit = settings.outfit;

    const next = { ...settings };
    if (patch.packId !== undefined) next.packId = String(patch.packId || '').trim();
    if (patch.mode === 'companion' || patch.mode === 'standalone') next.mode = patch.mode;
    if (patch.roam === 'free' || patch.roam === 'off') next.roam = patch.roam;
    if (typeof patch.temperament === 'string' && VALID_TEMPERAMENTS.has(patch.temperament)) {
      next.temperament = patch.temperament;
    }
    if (typeof patch.theme === 'string' && VALID_THEMES.has(patch.theme)) {
      next.theme = patch.theme;
    }
    if (typeof patch.palette === 'string') {
      next.palette = normalizePaletteId(patch.palette);
    }

    if (patch.mainScale !== undefined && Number.isFinite(Number(patch.mainScale))) {
      next.mainScale = clampNumber(patch.mainScale, 0.35, 1.40, settings.mainScale ?? 0.85);
      next.scale = next.mainScale;
    } else if (patch.scale !== undefined && Number.isFinite(Number(patch.scale))) {
      next.mainScale = clampNumber(patch.scale, 0.35, 1.40, settings.mainScale ?? 0.85);
      next.scale = next.mainScale;
    } else {
      next.mainScale = clampNumber(next.mainScale, 0.35, 1.40, 0.85);
      next.scale = next.mainScale;
    }

    if (patch.subagentScale !== undefined && Number.isFinite(Number(patch.subagentScale))) {
      next.subagentScale = clampNumber(patch.subagentScale, 0.30, 1.35, settings.subagentScale ?? 0.80);
    } else {
      next.subagentScale = clampNumber(next.subagentScale, 0.30, 1.35, 0.80);
    }

    const boolPatchKeys = [
      'petHidden',
      'trayHidden',
      'showSpeechBubble',
      'showStatusPill',
      'showTelemetryBar',
      'showSubagentHud',
      'soundOn',
      'autoSchemeByModel',
      'safetyGateEnabled',
      'interceptRiskyOnly',
      'interceptAllCommands',
    ];
    for (const k of boolPatchKeys) {
      if (patch[k] !== undefined) {
        next[k] = Boolean(patch[k]);
      }
    }
    if (typeof patch.defaultWorkspace === 'string') {
      next.defaultWorkspace = sanitizeWorkspace(patch.defaultWorkspace);
    }
    if (typeof patch.selectedProject === 'string') {
      next.selectedProject = sanitizeWorkspace(patch.selectedProject);
    }
    if (typeof patch.selectedProjectId === 'string') {
      next.selectedProjectId = patch.selectedProjectId;
    }

    if (patch.packId && !packs.some((p) => p.id === patch.packId)) {
      packs = scanPacks();
    }
    const targetPack = packs.find((p) => p.id === next.packId) || packs.find((p) => p.id === 'hachimi') || packs[0];
    next.packId = targetPack.id;
    const schemeInput = patch.scheme !== undefined
      ? patch.scheme
      : (targetPack.id !== prevPackId ? targetPack.defaultVariant : next.scheme);
    next.scheme = resolveSchemeForPack(targetPack, schemeInput);
    next.outfit = 'maid';

    const anyChanged = JSON.stringify(next) !== prevSnapshot;
    const schemeChanged =
      prevPackId !== next.packId ||
      prevScheme !== next.scheme ||
      prevOutfit !== next.outfit;

    if (anyChanged) {
      settings = next;
      saveSettings(settings);
      refreshActiveBadgesEmoji();
    }

    if (schemeChanged || forceBroadcastScheme) {
      broadcast('pet:scheme', {
        packId: settings.packId,
        scheme: settings.scheme,
        outfit: settings.outfit,
        activePack: targetPack,
      });
    }
    if (anyChanged || forceBroadcastScheme) {
      onPackChange?.(settings, targetPack);
      broadcast('state:sync', snapshotState());
    }
    return settings;
  }

  function selectPack(packId, scheme) {
    if (!packs.some((p) => p.id === packId)) {
      packs = scanPacks();
    }
    const targetPack = packs.find((p) => p.id === packId);
    if (!targetPack) {
      return { ok: false, error: '未找到对应的形象方案，请先刷新列表再试。' };
    }
    const nextScheme = scheme !== undefined
      ? resolveSchemeForPack(targetPack, scheme)
      : (targetPack.id === settings.packId
          ? resolveSchemeForPack(targetPack, settings.scheme)
          : targetPack.defaultVariant);
    applySettingsUpdate({ packId: targetPack.id, scheme: nextScheme, outfit: 'maid' }, { forceBroadcastScheme: true });
    return {
      ok: true,
      packId: settings.packId,
      scheme: settings.scheme,
      activePack: getActivePack(),
      packs,
    };
  }

  function reloadPacks() {
    const prevPackId = settings.packId;
    const prevScheme = settings.scheme;
    packs = scanPacks();
    const targetPack =
      packs.find((p) => p.id === settings.packId) ||
      packs.find((p) => p.id === 'six-cats') ||
      packs.find((p) => p.id === 'hachimi') ||
      packs[0];
    const nextScheme = resolveSchemeForPack(targetPack, settings.scheme);
    const adjusted = targetPack.id !== prevPackId || nextScheme !== prevScheme;
    settings = {
      ...settings,
      packId: targetPack.id,
      scheme: nextScheme,
      outfit: 'maid',
    };
    if (adjusted) {
      saveSettings(settings);
    }
    refreshActiveBadgesEmoji();
    broadcast('pet:scheme', {
      packId: settings.packId,
      scheme: settings.scheme,
      outfit: settings.outfit,
      activePack: targetPack,
    });
    onPackChange?.(settings, targetPack);
    broadcast('state:sync', snapshotState());
    return {
      ok: true,
      packs,
      activePack: targetPack,
      settings,
    };
  }

  function shortTitleLabel(t, maxLen = 18) {
    const clean = String(t || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
  }

  function isSubagentCid(cid, transcriptPath = '') {
    if (!cid) return false;
    if (subagentTracker?.isChildConversation(cid) || knownChildIds.has(cid)) return true;
    const tp = transcriptPath || findTranscriptPath(cid);
    if (tp && isTranscriptLikelySubagent(tp)) {
      knownChildIds.add(cid);
      return true;
    }
    return false;
  }

  /** @type {Map<string, Array<{ id: string, text: string, createdAt: number }>>} */
  const queuedMessages = new Map();
  /** @type {Map<string, { id: string, conversationId: string, toolName: string, commandLine: string, summary: string, createdAt: number, resolve: Function, timer: NodeJS.Timeout }>} */
  const pendingApprovals = new Map();
  /** @type {Map<string, { id: string, conversationId: string, summary: string, quickReplies: string[], createdAt: number, resolve: Function, timer: NodeJS.Timeout }>} */
  const pendingMcpWaits = new Map();

  const watcher = new TranscriptWatcher();
  const runner = new AgyRunner();

  let subagentTracker = null;
  let reviewKitSyncTimer = null;
  let reviewKitRunningPromise = null;
  let reviewKitRerunRequested = false;

  function execReviewKitOnce() {
    const scriptPath = resolveReviewKitScriptPath();
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return Promise.resolve({
        ok: true,
        synced: false,
        skipped: true,
        reason: 'script_not_found',
        updatedAt: Date.now(),
      });
    }
    const pyBin = resolveReviewKitPythonBin();
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = execFile(
        pyBin,
        [scriptPath],
        {
          cwd: path.dirname(scriptPath),
          env: { ...process.env },
          timeout: 90 * 1000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          if (err) {
            const detail = String(stderr || stdout || err.message || '').trim();
            console.warn(`[BridgeServer] build_review_kit.py failed (${durationMs}ms):`, detail || err.message);
            reject(err);
            return;
          }
          resolve({
            ok: true,
            synced: true,
            skipped: false,
            durationMs,
            updatedAt: Date.now(),
          });
        }
      );
      child.unref?.();
    });
  }

  async function runReviewKitSyncNow() {
    if (reviewKitSyncTimer) {
      clearTimeout(reviewKitSyncTimer);
      reviewKitSyncTimer = null;
    }
    if (reviewKitRunningPromise) {
      reviewKitRerunRequested = true;
      return reviewKitRunningPromise;
    }
    const runLoop = async () => {
      let lastRes = null;
      do {
        reviewKitRerunRequested = false;
        lastRes = await execReviewKitOnce();
      } while (reviewKitRerunRequested);
      return lastRes;
    };
    reviewKitRunningPromise = runLoop().finally(() => {
      reviewKitRunningPromise = null;
    });
    return reviewKitRunningPromise;
  }

  function scheduleReviewKitSync(_reason = 'pack-mutation', delayMs = 650) {
    const scriptPath = resolveReviewKitScriptPath();
    if (!scriptPath || !fs.existsSync(scriptPath)) return;
    if (reviewKitSyncTimer) {
      clearTimeout(reviewKitSyncTimer);
    }
    reviewKitSyncTimer = setTimeout(() => {
      reviewKitSyncTimer = null;
      runReviewKitSyncNow().catch(() => {});
    }, delayMs);
    reviewKitSyncTimer.unref?.();
  }

  const server = http.createServer(async (req, res) => {
    try {
    const rawOrigin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const hasOrigin = rawOrigin !== undefined;
    const normalizedOrigin = typeof rawOrigin === 'string' ? rawOrigin.trim() : '';
    const allowedOrigin = hasOrigin && isAllowedLocalOrigin(normalizedOrigin);

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (hasOrigin && !allowedOrigin) {
        res.setHeader('Connection', 'close');
        req.resume();
        sendJson(res, 403, { ok: false, error: '禁止非本机来源的跨域请求。' });
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && hasOrigin && !allowedOrigin) {
      res.setHeader('Connection', 'close');
      req.resume();
      sendJson(res, 403, { ok: false, error: '禁止非本机来源的跨站写请求。' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        activeConversationId,
        sessionCount: sessions.size,
        agyRunning: runner.isRunning,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/diag') {
      let pixelCheck = null;
      if (onCheckPixels && whaleDiag?.box) {
        try { pixelCheck = await onCheckPixels(whaleDiag.box); } catch (e) { pixelCheck = { error: String(e) }; }
      }
      const mouseState = typeof onGetMouseState === 'function' ? onGetMouseState() : hostMouseState;
      sendJson(res, 200, { whaleDiag, mouseState, pixelCheck, rendererLogs: rendererLogs.slice(-25) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, snapshotState());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/packs') {
      sendJson(res, 200, {
        ok: true,
        packs,
        activePack: getActivePack(),
        packId: settings.packId,
        scheme: settings.scheme,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/packs/inspect-frames') {
      try {
        const packId = url.searchParams.get('packId') || settings.packId;
        const variantId = url.searchParams.get('variantId') || url.searchParams.get('scheme') || settings.scheme;
        const inspected = inspectLocalPackVariant({ packId, variantId });
        sendJson(res, 200, inspected);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
      }
      return;
    }

    if (req.method === 'POST') {
      const isLargePackApi =
        url.pathname === '/api/packs/create' ||
        url.pathname === '/api/packs/edit-frame' ||
        url.pathname === '/api/packs/analyze-import' ||
        url.pathname === '/api/packs/analyze-three-view';
      const maxBytes = isLargePackApi ? 80 * 1024 * 1024 : 2 * 1024 * 1024;
      let body = {};
      try {
        body = await readJsonBody(req, maxBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          body = {};
        }
      } catch (err) {
        console.error('[BridgeServer] Request body error:', err);
        if (err && err.statusCode === 413) {
          sendJson(res, 413, { ok: false, error: humanizeBridgeError(err) });
        } else {
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err, '请求数据格式有误，请刷新页面后再试。') });
        }
        return;
      }

      if (url.pathname === '/api/packs/select') {
        const result = selectPack(body.packId, body.scheme);
        if (!result.ok) {
          sendJson(res, 404, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/packs/reload') {
        sendJson(res, 200, reloadPacks());
        return;
      }

      if (url.pathname === '/api/packs/sync-review-kit') {
        try {
          const reloaded = reloadPacks();
          if (body.async === true || body.wait === false) {
            const scriptPath = resolveReviewKitScriptPath();
            if (!scriptPath || !fs.existsSync(scriptPath)) {
              sendJson(res, 200, {
                ok: true,
                queued: false,
                synced: false,
                skipped: true,
                reason: 'script_not_found',
                packs: reloaded.packs,
                activePack: reloaded.activePack,
              });
              return;
            }
            scheduleReviewKitSync('manual-async', 40);
            sendJson(res, 200, {
              ok: true,
              queued: true,
              packs: reloaded.packs,
              activePack: reloaded.activePack,
            });
            return;
          }
          const syncRes = await runReviewKitSyncNow();
          sendJson(res, 200, {
            ...syncRes,
            packs: reloaded.packs,
            activePack: reloaded.activePack,
          });
        } catch (err) {
          console.error('[BridgeServer] packs/sync-review-kit failed:', err);
          sendJson(res, 500, { ok: false, error: humanizeBridgeError(err, '同步动作审阅台数据时遇到问题，请稍后再试。') });
        }
        return;
      }

      if (url.pathname === '/api/packs/rename') {
        try {
          const renamed = renameLocalPackOrVariant({
            packId: body.packId,
            variantId: body.variantId || body.scheme,
            name: body.name,
            packName: body.packName,
            variantName: body.variantName,
            displayName: body.displayName,
          });
          const reloaded = reloadPacks();
          scheduleReviewKitSync('rename');
          sendJson(res, 200, {
            ok: true,
            pack: renamed.pack,
            variant: renamed.variant,
            packs: reloaded.packs,
            activePack: reloaded.activePack,
            settings: reloaded.settings,
          });
        } catch (err) {
          console.error('[BridgeServer] packs/rename failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        }
        return;
      }

      if (url.pathname === '/api/packs/move-variant') {
        try {
          const movedRes = moveLocalPackVariant({
            sourcePackId: body.sourcePackId || body.fromPackId || body.packId,
            variantId: body.variantId || body.scheme,
            targetPackId: body.targetPackId,
            targetPackName: body.targetPackName ?? body.packName ?? body.newPackName,
          });
          if (
            movedRes.moved &&
            settings.packId === movedRes.sourcePackId &&
            (settings.scheme === movedRes.previousVariantId || movedRes.sourcePackRemoved)
          ) {
            settings.packId = movedRes.targetPackId;
            settings.scheme = movedRes.variantId;
            saveSettings(settings);
          }
          const reloaded = reloadPacks();
          scheduleReviewKitSync('move-variant');
          sendJson(res, 200, {
            ...movedRes,
            packs: reloaded.packs,
            activePack: reloaded.activePack,
            settings: reloaded.settings,
          });
        } catch (err) {
          console.error('[BridgeServer] packs/move-variant failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        }
        return;
      }

      if (url.pathname === '/api/packs/delete') {
        try {
          const delRes = deleteLocalPackOrVariant({
            packId: body.packId,
            variantId: body.variantId || body.scheme,
          });
          const reloaded = reloadPacks();
          scheduleReviewKitSync('delete');
          sendJson(res, 200, {
            ok: true,
            ...delRes,
            ...reloaded,
          });
        } catch (err) {
          console.error('[BridgeServer] packs/delete failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        }
        return;
      }

      if (url.pathname === '/api/packs/edit-frame') {
        try {
          let editPayload = { ...body, allowFilePaths: false };
          if (String(body.action || '').trim().toLowerCase() === 'ai_redraw_row') {
            const inspected = inspectLocalPackVariant({
              packId: body.packId,
              variantId: body.variantId || body.scheme,
            });
            const atlasPath = resolveLocalPackFile(inspected.pack.id, inspected.variant.asset) || '';
            const thumbPath = resolveLocalPackFile(inspected.pack.id, inspected.variant.thumb) || '';
            let refDecoded = null;
            if (body.imageDataUrl) {
              refDecoded = decodeInputImageBuffer({ dataUrl: body.imageDataUrl, name: 'ref.png' }, 0, '', { allowFilePaths: false });
            }
            const rowNum = Math.max(0, Number(body.row) || 0);
            const isHoldSub =
              rowNum === 4 &&
              (String(body.rowCode || '').trim().toUpperCase() === 'R04H' ||
                Number(body.colStart) === 5 ||
                Number(body.col) >= 5);
            const redrawn = await generateRedrawnRowWithModel({
              atlasPath,
              thumbPath,
              row: rowNum,
              rowCode: isHoldSub ? 'R04H' : '',
              instruction: String(body.instruction || '').trim(),
              asymmetric: Boolean(inspected.variant?.asymmetric),
              refImageBuffer: refDecoded?.buffer || null,
              refImageExt: refDecoded?.ext || '.png',
              pyBin: (typeof packRegistry.findPythonForThreeView === 'function' ? packRegistry.findPythonForThreeView() : '') || packRegistry.findPythonWithPil(),
            });
            editPayload = {
              ...body,
              action: 'replace_row',
              scope: 'row',
              rowCode: isHoldSub ? 'R04H' : body.rowCode,
              colStart: isHoldSub ? 5 : body.colStart,
              activeCols: isHoldSub ? 3 : body.activeCols,
              asymmetric: Boolean(body.asymmetric ?? inspected.variant?.asymmetric),
              imageDataUrl: redrawn.buffer,
              allowFilePaths: false,
            };
          }
          const edited = editLocalPackFrame(editPayload);
          const reloaded = reloadPacks();
          scheduleReviewKitSync('edit-frame');
          sendJson(res, 200, {
            ...edited,
            packs: reloaded.packs,
            activePack: reloaded.activePack,
            settings: reloaded.settings,
          });
        } catch (err) {
          console.error('[BridgeServer] packs/edit-frame failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        }
        return;
      }

      if (url.pathname === '/api/packs/analyze-import' || url.pathname === '/api/packs/analyze-three-view') {
        try {
          const analyzer = packRegistry.analyzeImportInputs || packRegistry.analyzeThreeViewInputs;
          if (typeof analyzer !== 'function') {
            throw new Error('图像分析组件暂不可用');
          }
          const analyzeOpts = {
            ...body,
            layout: body.layout,
            files: body.files,
            inputs: body.inputs,
            facets: body.facets,
            allowFilePaths: false,
          };
          const analyzed = analyzer(analyzeOpts);
          sendJson(res, 200, { ok: true, ...analyzed });
        } catch (err) {
          console.error('[BridgeServer] analyze-import failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        }
        return;
      }

      if (url.pathname === '/api/packs/create') {
        let styleStageDir = '';
        try {
          let createOpts = {
            ...body,
            layout: body.layout,
            files: body.files,
            inputs: body.inputs,
            facets: body.facets,
            threeViewOptions: body.threeViewOptions,
            aiSheets: undefined,
            allowFilePaths: false,
          };

          let aiSummary = null;
          if (body.modelAssist === true) {
            const prep = prepareModelStyleInputs({ ...body, allowFilePaths: false });
            styleStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hachimi-style-anchor-'));
            const stylePng = path.join(styleStageDir, 'style_ref.png');
            let hasStyleRef = false;
            if (prep.customStyleDecoded) {
              fs.writeFileSync(stylePng, prep.customStyleDecoded.buffer);
              hasStyleRef = true;
            } else if (prep.refAtlasPath || prep.refThumbPath) {
              hasStyleRef = exportVariantStyleAnchorPng(prep.pyBin, prep.refAtlasPath, prep.refThumbPath, stylePng);
            }
            const stylized = await generateStylizedTurnaround({
              subjectFiles: prep.subjectFiles,
              styleRefPath: hasStyleRef ? stylePng : '',
              styleAtlasPath: (!prep.customStyleDecoded && prep.refAtlasPath) ? prep.refAtlasPath : '',
              variantName: String(body.variantName || '').trim(),
              asymmetric: Boolean(body.asymmetric),
              pyBin: prep.pyBin,
            });
            aiSummary = stylized.summary || null;
            createOpts = {
              ...body,
              layout: 'auto',
              files: (Array.isArray(stylized.files) && stylized.files.length > 0)
                ? stylized.files
                : [{ name: stylized.name, buffer: stylized.buffer }],
              aiSheets: stylized.aiSheets || undefined,
              inputs: undefined,
              facets: undefined,
              allowFilePaths: false,
            };
          }

          const created = createOrUpdateLocalPack(createOpts);
          packs = scanPacks();
          if (body.select === true && created.pack) {
            selectPack(created.pack.id, created.variant?.id);
          } else {
            onPackChange?.(settings, getActivePack());
            broadcast('state:sync', snapshotState());
          }
          scheduleReviewKitSync('create');
          sendJson(res, 200, {
            ok: true,
            pack: created.pack,
            variant: created.variant,
            engine: body.modelAssist === true ? `ai-style+${created.engine}` : created.engine,
            suggestedColor: created.suggestedColor,
            aiSummary,
            aiReport: created.aiReport || null,
            packs,
            activePack: getActivePack(),
          });
        } catch (err) {
          console.error('[BridgeServer] packs/create failed:', err);
          sendJson(res, 400, { ok: false, error: humanizeBridgeError(err) });
        } finally {
          if (styleStageDir) {
            try { fs.rmSync(styleStageDir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
        return;
      }

      if (url.pathname.startsWith('/api/hook/')) {
        const eventName = url.pathname.slice('/api/hook/'.length);
        const hookReply = await handleHookEvent(eventName, body);
        sendJson(res, 200, hookReply);
        return;
      }

      if (url.pathname === '/api/mcp/notify') {
        handleMcpNotify(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/mcp/await-command') {
        const result = await handleMcpAwaitCommand(body, req, res);
        if (!res.writableEnded) {
          sendJson(res, 200, result);
        }
        return;
      }

      if (url.pathname === '/api/subagents') {
        if (body.action === 'clear') {
          subagentTracker?.clearAll();
          sendJson(res, 200, { ok: true, subagents: [] });
        } else if (body.action === 'remove' && body.id) {
          subagentTracker?.removeById(body.id);
          sendJson(res, 200, { ok: true, subagents: subagentTracker?.getPublicList() || [] });
        } else {
          const item = subagentTracker?.spawnTestSubagent(body);
          const list = subagentTracker?.getPublicList() || [];
          const pubItem = item ? list.find((x) => x.id === item.id) || null : null;
          sendJson(res, 200, { ok: true, item: pubItem, subagents: list });
        }
        return;
      }

      if (url.pathname === '/api/command') {
        const result = dispatchUserCommand({
          text: body.text,
          targetConversationId: body.conversationId || activeConversationId,
          mode: body.mode || settings.mode,
          cwd: body.cwd,
        });
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/settings') {
        if (body && typeof body === 'object') {
          applySettingsUpdate(body);
        }
        sendJson(res, 200, { ok: true, settings });
        return;
      }

      if (url.pathname === '/api/host-state') {
        if (body && typeof body === 'object') {
          hostMouseState = { ...body, updatedAt: Date.now() };
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/pet-command') {
        broadcast('pet:command', body || {});
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/quit') {
        sendJson(res, 200, { ok: true });
        if (typeof onQuit === 'function') {
          setTimeout(() => onQuit(), 40);
        }
        return;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const isHead = req.method === 'HEAD';
      if (url.pathname === '/workshop' || url.pathname === '/workshop/') {
        if (serveStaticFile('/workshop.html', res, isHead)) return;
      }
      if (url.pathname.startsWith('/local-packs/') && serveLocalPackAsset(url.pathname, res, isHead)) {
        return;
      }
      if (serveStaticFile(url.pathname, res, isHead)) {
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: '请求的接口或资源不存在。' });
    } catch (err) {
      console.error('[BridgeServer] Unhandled request error:', err);
      if (!res.writableEnded) {
        try {
          sendJson(res, 500, { ok: false, error: humanizeBridgeError(err, '服务处理请求时遇到一点问题，请稍后再试。') });
        } catch {
          try { res.end(); } catch {}
        }
      }
    }
  });

  const wss = new WebSocketServer({ server });

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  function broadcastReaction(reaction, { urgent = false } = {}) {
    if (!reaction || typeof reaction !== 'object') return;
    const payload = { ...reaction };
    const now = Date.now();
    const temp = settings.temperament || 'daily';

    if (temp === 'quiet' && !urgent) {
      if ('speech' in payload) delete payload.speech;
      payload.motion = null;
    } else if (temp === 'daily' && !urgent) {
      payload.motion = null;
    } else if (!urgent && payload.motion) {
      if (now - lastReactionMotionAt < 7000) {
        payload.motion = null;
      } else {
        lastReactionMotionAt = now;
      }
    } else if (urgent && payload.motion) {
      lastReactionMotionAt = now;
    }

    broadcast('pet:Reaction', payload);
  }

  function clearAwaitingIdleTimer(cid) {
    if (!cid) return;
    const t = awaitingIdleTimers.get(cid);
    if (t) {
      clearTimeout(t);
      awaitingIdleTimers.delete(cid);
    }
    awaitingSinceMap.delete(cid);
  }

  function clearToolDebounceTimer(cid) {
    if (!cid) return;
    const t = toolDebounceTimers.get(cid);
    if (t) {
      clearTimeout(t);
      toolDebounceTimers.delete(cid);
    }
  }

  function scheduleAwaitingIdleFallback(s) {
    if (!s || !s.conversationId) return;
    const cid = s.conversationId;
    clearAwaitingIdleTimer(cid);
    const scheduledAt = Date.now();
    awaitingSinceMap.set(cid, scheduledAt);
    const timer = setTimeout(() => {
      awaitingIdleTimers.delete(cid);
      const cur = sessions.get(cid);
      if (!cur || cur.status !== 'AWAITING_NEXT') {
        awaitingSinceMap.delete(cid);
        return;
      }
      const since = awaitingSinceMap.get(cid) || scheduledAt;
      if (Date.now() - since < 11500) return;
      awaitingSinceMap.delete(cid);
      cur.status = 'IDLE';
      const label = shortTitleLabel(cur.title || cur.projectName);
      cur.badge = label ? `当前会话 · ${label}` : '待机';
      lastStatusChangeAt = Date.now();
      lastToolStatusChangeAt = 0;
      broadcast('state:sync', snapshotState());
    }, 12000);
    timer.unref?.();
    awaitingIdleTimers.set(cid, timer);
  }

  function scheduleToolStatusDebounce(cid, targetStatus, delayMs) {
    clearToolDebounceTimer(cid);
    const timer = setTimeout(() => {
      toolDebounceTimers.delete(cid);
      const cur = sessions.get(cid);
      if (!cur) return;
      if (cur.status === 'ERROR' || cur.status === 'WAITING_USER' || cur.status === 'AWAITING_NEXT' || cur.status === 'IDLE') {
        return;
      }
      if (cur.status !== targetStatus) {
        cur.status = targetStatus;
        lastStatusChangeAt = Date.now();
        lastToolStatusChangeAt = lastStatusChangeAt;
        broadcast('state:sync', snapshotState());
      }
    }, Math.max(50, delayMs));
    timer.unref?.();
    toolDebounceTimers.set(cid, timer);
  }

  function handleToolPresentationEvent(s, toolName, args, { quiet = false, makeActive = false } = {}) {
    const pres = mapToolPresentation(toolName, args);
    const now = Date.now();
    const isUrgent = pres.status === 'ERROR' || pres.status === 'WAITING_USER';

    if (isUrgent) {
      clearToolDebounceTimer(s.conversationId);
      clearAwaitingIdleTimer(s.conversationId);
      s.status = pres.status;
      s.badge = pres.badge;
      lastStatusChangeAt = now;
      if (!quiet) {
        if (makeActive) activeConversationId = s.conversationId;
        broadcastReaction({
          expression: pres.expression,
          motion: pres.motion,
          badge: pres.badge,
          thinking: pres.thinking,
        }, { urgent: true });
        broadcast('state:sync', snapshotState());
      }
      return pres;
    }

    clearAwaitingIdleTimer(s.conversationId);
    const elapsedSinceToolStatus = now - lastToolStatusChangeAt;
    if (elapsedSinceToolStatus < 850) {
      // Debounce rapid tool status switches: immediately update badge text & defer status switch
      s.badge = pres.badge;
      scheduleToolStatusDebounce(s.conversationId, pres.status, 850 - elapsedSinceToolStatus);
      if (!quiet) {
        if (makeActive) activeConversationId = s.conversationId;
        broadcast('state:sync', snapshotState());
      }
      return pres;
    }

    clearToolDebounceTimer(s.conversationId);
    const statusChanged = s.status !== pres.status;
    s.status = pres.status;
    s.badge = pres.badge;
    if (statusChanged) {
      lastStatusChangeAt = now;
      lastToolStatusChangeAt = now;
    }

    if (!quiet) {
      if (makeActive) activeConversationId = s.conversationId;
      broadcastReaction({
        expression: pres.expression,
        motion: pres.motion,
        badge: pres.badge,
        thinking: pres.thinking,
      }, { urgent: false });
      broadcast('state:sync', snapshotState());
    }
    return pres;
  }

  function findCatalogConversation(cid) {
    if (!cid) return null;
    for (const proj of antigravityProjects) {
      const found = proj.conversations.find((c) => c.conversationId === cid);
      if (found) return { proj, convo: found };
    }
    return null;
  }

  function findCatalogProjectByPath(wsPath) {
    if (!wsPath) return null;
    const norm = String(wsPath).replace(/\\/g, '/').toLowerCase();
    return (
      antigravityProjects.find((p) => p.workspacePaths?.some((wp) => String(wp).replace(/\\/g, '/').toLowerCase() === norm)) ||
      null
    );
  }

  function buildMergedProjectsSnapshot() {
    return antigravityProjects.map((proj) => {
      const convos = [...proj.conversations];
      // Prepend any local newly-created or active sessions belonging to this project that aren't in DB yet
      for (const s of sessions.values()) {
        if (s.projectId === proj.id && !convos.some((c) => c.conversationId === s.conversationId)) {
          convos.unshift({
            conversationId: s.conversationId,
            title: s.title || s.lastUserInput || '新对话',
            projectId: proj.id,
            projectName: proj.name,
            workspacePath: s.workspacePath || proj.workspacePath,
            transcriptPath: s.transcriptPath || '',
            updatedAt: s.updatedAt || Date.now(),
            relativeTime: formatRelativeTime(s.updatedAt || Date.now()),
            status: s.status === 'IDLE' ? 'IDLE' : 'RUNNING',
            source: 'PET',
          });
        }
      }
      return {
        ...proj,
        conversations: convos,
      };
    });
  }

  function snapshotState() {
    return {
      palette: settings.palette || 'forest',
      settings,
      packs,
      activePack: getActivePack(),
      activeConversationId,
      agyRunning: runner.isRunning,
      projects: buildMergedProjectsSnapshot(),
      sessions: Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
      pendingApprovals: Array.from(pendingApprovals.values()).map(({ id, conversationId, toolName, commandLine, summary, createdAt }) => ({
        id, conversationId, toolName, commandLine, summary, createdAt,
      })),
      pendingMcpWaits: Array.from(pendingMcpWaits.values()).map(({ id, conversationId, summary, quickReplies, createdAt }) => ({
        id, conversationId, summary, quickReplies, createdAt,
      })),
      queuedCounts: Object.fromEntries(
        Array.from(queuedMessages.entries()).map(([k, arr]) => [k, arr.length])
      ),
      subagents: subagentTracker ? subagentTracker.getPublicList() : [],
    };
  }

  subagentTracker = new SubagentTracker({
    watcher,
    getMainSettings: () => settings,
    getActivePack,
    getWatchedRootIds: () => {
      const ids = new Set();
      if (activeConversationId) ids.add(activeConversationId);
      for (const s of sessions.values()) ids.add(s.conversationId);
      const now = Date.now();
      for (const proj of antigravityProjects) {
        for (const c of proj.conversations || []) {
          if (c.conversationId && now - (c.updatedAt || 0) < 30 * 60 * 1000) {
            ids.add(c.conversationId);
          }
        }
      }
      return Array.from(ids);
    },
    onChange: () => {
      broadcast('state:sync', snapshotState());
    },
    onReaction: (ev) => {
      broadcastReaction(ev, { urgent: false });
    },
  });

  function ensureSession(payload) {
    const rawCid = payload.conversationId || 'default-session';
    const cid = linkedCliToOwner.get(rawCid) || rawCid;
    let s = sessions.get(cid);
    const catalogHit = findCatalogConversation(cid);
    const candidateWs = Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]
      ? payload.workspacePaths[0]
      : (catalogHit?.convo?.workspacePath || s?.workspacePath || settings.defaultWorkspace);
    const workspacePath = sanitizeWorkspace(candidateWs);
    const matchedProj = catalogHit?.proj || findCatalogProjectByPath(workspacePath);
    const projectId = payload.projectId || s?.projectId || matchedProj?.id || '';
    const projectName = payload.projectName || s?.projectName || matchedProj?.name || path.basename(workspacePath);
    const title = payload.title || catalogHit?.convo?.title || s?.title || '';
    const resolvedTranscript =
      payload.transcriptPath || catalogHit?.convo?.transcriptPath || s?.transcriptPath || (!cid.startsWith('proj-') && !cid.startsWith('mini-') ? findTranscriptPath(cid) : '');

    if (!s) {
      s = {
        conversationId: cid,
        cliCompanionId: isNativeCliSession(cid, resolvedTranscript) ? cid : null,
        projectId,
        projectName,
        title,
        workspacePath,
        transcriptPath: resolvedTranscript,
        modelName: payload.modelName || 'auto',
        status: 'IDLE',
        badge: '待机',
        lastThinking: '',
        lastUserInput: payload.lastUserInput || '',
        lastAssistantReply: '',
        telemetry: resolvedTranscript ? readInitialTranscriptTelemetry(resolvedTranscript) : null,
        lastInvocationStartMs: 0,
        messages: [],
        updatedAt: catalogHit?.convo?.updatedAt || Date.now(),
      };
      sessions.set(cid, s);
      refreshSessionTelemetry(cid);
    } else {
      if (resolvedTranscript && cid === rawCid) s.transcriptPath = resolvedTranscript;
      if (payload.modelName) s.modelName = payload.modelName;
      if (workspacePath) s.workspacePath = workspacePath;
      if (projectId) s.projectId = projectId;
      if (projectName) s.projectName = projectName;
      if (title) s.title = title;
      if (payload.lastUserInput) s.lastUserInput = payload.lastUserInput;
      if (!s.cliCompanionId && isNativeCliSession(cid, s.transcriptPath)) {
        s.cliCompanionId = cid;
      }
      if (!payload.preserveTimestamp) {
        s.updatedAt = Date.now();
      }
    }

    if (projectId && settings.selectedProjectId !== projectId && !payload.preserveSelection) {
      settings.selectedProjectId = projectId;
    }
    if (workspacePath && !settings.savedProjects.includes(workspacePath)) {
      settings.savedProjects.unshift(workspacePath);
      saveSettings(settings);
    }

    if (!payload.preserveSelection) {
      activeConversationId = cid;
    }
    if (s.transcriptPath) {
      watcher.attach(cid, s.transcriptPath);
    }

    if (settings.packId === 'hachimi' && settings.autoSchemeByModel && payload.modelName) {
      const autoScheme = detectSchemeForModel(payload.modelName);
      if (autoScheme && autoScheme !== settings.scheme) {
        applySettingsUpdate({ scheme: autoScheme });
      }
    }
    return s;
  }

  const telemetryPending = new Set();
  function refreshSessionTelemetry(cid) {
    if (!cid || cid.startsWith('proj-') || cid.startsWith('mini-') || telemetryPending.has(cid)) return;
    telemetryPending.add(cid);
    readLatestDbTelemetry(cid)
      .then((tel) => {
        if (!tel) return;
        const s = sessions.get(cid);
        if (!s) return;
        const prev = s.telemetry;
        const changed =
          !prev ||
          prev.contextUsed !== tel.contextUsed ||
          prev.contextLimit !== tel.contextLimit ||
          prev.overallTokPerSec !== tel.overallTokPerSec ||
          prev.streamTokPerSec !== tel.streamTokPerSec ||
          prev.outputTokens !== tel.outputTokens ||
          Boolean(prev.compacted) !== Boolean(tel.compacted);
        s.telemetry = tel;
        if (changed) {
          broadcast('state:sync', snapshotState());
        }
      })
      .catch(() => {})
      .finally(() => {
        telemetryPending.delete(cid);
      });
  }

  function popQueuedMessages(cid) {
    const items = [];
    for (const key of [cid, '__any__']) {
      const q = queuedMessages.get(key);
      if (q && q.length > 0) {
        items.push(...q.splice(0, q.length));
      }
    }
    return items;
  }

  function dockToLatestSession(cid, opts = {}) {
    if (!cid || isSubagentCid(cid, opts.transcriptPath)) return null;
    const prevActive = activeConversationId;
    const catalogHit = findCatalogConversation(cid);
    const s = ensureSession({
      conversationId: cid,
      projectId: opts.projectId || catalogHit?.proj?.id,
      projectName: opts.projectName || catalogHit?.proj?.name,
      title: opts.title || catalogHit?.convo?.title,
      workspacePaths: opts.workspacePath
        ? [opts.workspacePath]
        : catalogHit?.convo?.workspacePath
        ? [catalogHit.convo.workspacePath]
        : undefined,
      transcriptPath: opts.transcriptPath || catalogHit?.convo?.transcriptPath,
      preserveTimestamp: true,
      preserveSelection: true,
    });

    if (opts.timestampMs && opts.timestampMs > (s.updatedAt || 0)) {
      s.updatedAt = opts.timestampMs;
    }

    if (prevActive !== cid) {
      activeConversationId = cid;
      const label = shortTitleLabel(s.title || s.projectName);
      if (s.status === 'IDLE' || s.status === 'AWAITING_NEXT') {
        s.badge = label ? `当前会话 · ${label}` : '已切换至当前会话';
      }
      refreshSessionTelemetry(cid);
      if (opts.announceSwitch && prevActive) {
        broadcastReaction({
          expression: 'happy',
          motion: 'look',
          badge: s.badge,
          thinking: false,
        }, { urgent: false });
      }
      broadcast('state:sync', snapshotState());
    }
    return s;
  }

  async function handleHookEvent(eventName, payload) {
    const rawCid = payload.conversationId || '';
    const isSubagentTurn = Boolean(rawCid && isSubagentCid(rawCid, payload.transcriptPath));

    // If a child subagent / swarm worker triggers hooks, track its nested subagent/swarm calls
    // without overwriting the user's active root conversation in the console!
    if (isSubagentTurn) {
      if (eventName === 'PreToolUse') {
        const tc = payload.toolCall || {};
        const toolName = tc.name || 'tool';
        const args = tc.args || {};
        subagentTracker.handleLiveToolCall(rawCid, toolName, args);
        if (toolName === 'run_command') {
          const cmd = String(args.CommandLine || '').trim();
          const shouldIntercept = settings.interceptAllCommands || (settings.interceptRiskyOnly && RISKY_CMD_REGEX.test(cmd));
          if (shouldIntercept && wss.clients.size > 0) {
            return await requestPetApproval(rawCid, toolName, cmd, args.toolSummary || '');
          }
        }
        return { decision: 'ask' };
      }
      if (eventName === 'Stop') {
        subagentTracker.handleSessionStopped(rawCid, payload);
        return { decision: 'stop' };
      }
      return {};
    }

    const s = ensureSession(payload);

    switch (eventName) {
      case 'SessionStart': {
        clearToolDebounceTimer(s.conversationId);
        clearAwaitingIdleTimer(s.conversationId);
        lastToolStatusChangeAt = 0;
        lastStatusChangeAt = Date.now();
        s.status = 'IDLE';
        s.badge = `已连接 · ${shortPath(s.workspacePath) || 'Workspace'}`;
        broadcastReaction({
          expression: 'happy',
          motion: 'wave',
          speech: '新会话已连接，随时可用。',
          badge: s.badge,
          thinking: false,
        }, { urgent: false });
        broadcast('state:sync', snapshotState());
        return {};
      }

      case 'PreInvocation': {
        clearToolDebounceTimer(s.conversationId);
        clearAwaitingIdleTimer(s.conversationId);
        s.status = 'THINKING';
        s.lastInvocationStartMs = Date.now();
        lastStatusChangeAt = s.lastInvocationStartMs;
        s.badge = '思考中';
        broadcastReaction({
          expression: 'thinking',
          motion: null,
          badge: s.badge,
          thinking: true,
        }, { urgent: false });
        broadcast('state:sync', snapshotState());
        return {};
      }

      case 'PreToolUse': {
        const tc = payload.toolCall || {};
        const toolName = tc.name || 'tool';
        const args = tc.args || {};
        subagentTracker.handleLiveToolCall(s.conversationId, toolName, args);
        handleToolPresentationEvent(s, toolName, args, { quiet: false, makeActive: false });

        // Check if this tool call should trigger interactive approval on the desktop pet
        if (toolName === 'run_command') {
          const cmd = String(args.CommandLine || '').trim();
          const shouldIntercept = settings.interceptAllCommands || (settings.interceptRiskyOnly && RISKY_CMD_REGEX.test(cmd));
          if (shouldIntercept && wss.clients.size > 0) {
            return await requestPetApproval(s.conversationId, toolName, cmd, args.toolSummary || '');
          }
        }
        // Respect Antigravity's standard permission cache ("ask" prompts only when not already allowed)
        return { decision: 'ask' };
      }

      case 'PostToolUse': {
        if (payload.error) {
          clearToolDebounceTimer(s.conversationId);
          clearAwaitingIdleTimer(s.conversationId);
          lastStatusChangeAt = Date.now();
          const shortErr = String(payload.error).slice(0, 80);
          s.status = 'ERROR';
          s.badge = `执行异常 · ${shortErr}`;
          broadcastReaction({
            expression: 'flustered',
            motion: 'shiver',
            speech: `命令执行出错：${shortErr}`,
            badge: s.badge,
            thinking: false,
          }, { urgent: true });
          broadcast('state:sync', snapshotState());
        }
        return {};
      }

      case 'PostInvocation': {
        refreshSessionTelemetry(s.conversationId);
        const queued = popQueuedMessages(s.conversationId);
        if (queued.length > 0) {
          clearToolDebounceTimer(s.conversationId);
          clearAwaitingIdleTimer(s.conversationId);
          const combined = queued.map((m) => m.text).join('\n');
          s.messages.push({ role: 'user', text: combined, via: 'pet-queue', ts: Date.now() });
          s.badge = '已注入排队指令';
          broadcastReaction({
            expression: 'excited',
            motion: 'nod',
            speech: '收到补充指令，继续执行。',
            badge: s.badge,
            thinking: true,
          }, { urgent: false });
          broadcast('state:sync', snapshotState());
          return {
            injectSteps: [{ userMessage: combined }],
            terminationBehavior: 'force_continue',
          };
        }
        return {};
      }

      case 'Stop': {
        const queued = popQueuedMessages(s.conversationId);
        if (queued.length > 0) {
          clearToolDebounceTimer(s.conversationId);
          clearAwaitingIdleTimer(s.conversationId);
          const combined = queued.map((m) => m.text).join('\n');
          s.messages.push({ role: 'user', text: combined, via: 'pet-stop-hook', ts: Date.now() });
          s.badge = '接力执行下一条指令';
          broadcastReaction({
            expression: 'excited',
            motion: 'jump',
            speech: '收到下一步指令，继续执行。',
            badge: s.badge,
            thinking: true,
          }, { urgent: false });
          broadcast('state:sync', snapshotState());
          return {
            decision: 'continue',
            reason: `用户在桌宠下达了下一步指令，请立即按此继续执行：\n${combined}`,
          };
        }

        clearToolDebounceTimer(s.conversationId);
        lastToolStatusChangeAt = 0;
        lastStatusChangeAt = Date.now();
        const reason = String(payload.terminationReason || 'NO_TOOL_CALL');
        if (reason === 'ERROR' || payload.error) {
          clearAwaitingIdleTimer(s.conversationId);
          s.status = 'ERROR';
          s.badge = `执行异常 · ${reason}`;
          broadcastReaction({
            expression: 'cry',
            motion: 'shiver',
            speech: '任务遇到错误停下来了，需要进一步排查吗？',
            badge: s.badge,
            thinking: false,
          }, { urgent: true });
        } else if (reason === 'USER_CANCELED') {
          s.status = 'AWAITING_NEXT';
          s.badge = '已暂停 · 等待指令';
          scheduleAwaitingIdleFallback(s);
          broadcastReaction({
            expression: 'surprised',
            motion: null,
            speech: '已暂停，等待下一步指令。',
            badge: s.badge,
            thinking: false,
          }, { urgent: false });
        } else {
          s.status = 'AWAITING_NEXT';
          s.badge = '已完成';
          scheduleAwaitingIdleFallback(s);
          broadcastReaction({
            expression: 'happy',
            motion: null,
            speech: '本轮任务已完成。',
            badge: s.badge,
            thinking: false,
          }, { urgent: false });
        }
        refreshSessionTelemetry(s.conversationId);
        broadcast('state:sync', snapshotState());
        return { decision: 'stop' };
      }

      default:
        return {};
    }
  }

  function requestPetApproval(conversationId, toolName, commandLine, summary) {
    const id = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    onShowPanel?.();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        broadcast('state:sync', snapshotState());
        resolve({ decision: 'ask' });
      }, 85000);

      pendingApprovals.set(id, {
        id,
        conversationId,
        toolName,
        commandLine,
        summary,
        createdAt: Date.now(),
        timer,
        resolve: (decision, reason) => {
          clearTimeout(timer);
          pendingApprovals.delete(id);
          broadcast('state:sync', snapshotState());
          resolve(reason ? { decision, reason } : { decision });
        },
      });

      broadcastReaction({
        expression: 'surprised',
        motion: 'wave',
        speech: '检测到敏感终端命令，请确认允许或拦截。',
        badge: '命令待确认',
        thinking: false,
      }, { urgent: true });
      broadcast('state:sync', snapshotState());
    });
  }

  function handleMcpNotify(body) {
    const cid = body.conversationId || activeConversationId || 'mcp-session';
    const s = ensureSession({ conversationId: cid });
    if (body.message) s.badge = body.message.slice(0, 48);
    broadcastReaction({
      expression: body.expression || 'happy',
      motion: body.motion || 'wave',
      speech: body.message || '',
      badge: s.badge,
      thinking: false,
    }, { urgent: false });
    broadcast('state:sync', snapshotState());
  }

  function handleMcpAwaitCommand(body) {
    const latestDesktop = Array.from(sessions.values())
      .filter((x) => !x.conversationId.startsWith('proj-') && !x.conversationId.startsWith('mini-') && !isNativeCliSession(x.conversationId, x.transcriptPath))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const cid = body.conversationId || latestDesktop?.conversationId || activeConversationId || 'mcp-session';
    const s = ensureSession({ conversationId: cid });
    const summary = String(body.summary || '已完成');

    clearToolDebounceTimer(cid);
    lastToolStatusChangeAt = 0;
    lastStatusChangeAt = Date.now();
    s.status = 'AWAITING_NEXT';
    s.lastAssistantReply = summary;
    s.badge = '已完成';
    scheduleAwaitingIdleFallback(s);
    refreshSessionTelemetry(cid);

    broadcastReaction({
      expression: 'happy',
      motion: null,
      speech: summary.length > 110 ? summary.slice(0, 108) + '…' : summary,
      badge: s.badge,
      thinking: false,
      openMiniBar: false,
    }, { urgent: false });
    broadcast('state:sync', snapshotState());
    return Promise.resolve({ nextInstruction: '', endCompanion: true, nonBlockingSync: true });
  }

  /**
   * Unified command dispatcher from Whale Girl Mini Command Bar.
   */
  function dispatchUserCommand({ text, targetConversationId, mode, cwd }) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: '指令内容不能为空，请输入后再发送。' };

    // 1. If there is a pending MCP await-command call FOR THIS TARGET SESSION, satisfy it immediately!
    const waitEntry = targetConversationId
      ? Array.from(pendingMcpWaits.values()).find((w) => w.conversationId === targetConversationId)
      : Array.from(pendingMcpWaits.values())[0];

    if (waitEntry && mode !== 'standalone-new') {
      const s = sessions.get(waitEntry.conversationId);
      if (s) {
        clearToolDebounceTimer(s.conversationId);
        clearAwaitingIdleTimer(s.conversationId);
        s.messages.push({ role: 'user', text: trimmed, via: 'mcp-companion', ts: Date.now() });
        s.status = 'THINKING';
        s.badge = '已回传主窗口执行';
      }
      waitEntry.resolve({ nextInstruction: trimmed, endCompanion: false });
      broadcastReaction({
        expression: 'determined',
        motion: 'nod',
        speech: '已回传主会话继续执行。',
        badge: '已回传主窗口执行',
        thinking: true,
      }, { urgent: false });
      broadcast('state:sync', snapshotState());
      return { ok: true, delivery: 'mcp-live' };
    }

    // 2. If target session in Companion mode is currently busy running tools/thinking, queue it for PostInvocation/Stop injection!
    const targetSession = targetConversationId ? sessions.get(targetConversationId) : null;
    const isBusy = targetSession && ['THINKING', 'READING', 'CODING', 'RUNNING_CMD'].includes(targetSession.status);

    if (mode === 'companion' && isBusy && !runner.isRunning) {
      const key = targetSession.conversationId;
      const list = queuedMessages.get(key) || [];
      list.push({ id: `q-${Date.now()}`, text: trimmed, createdAt: Date.now() });
      queuedMessages.set(key, list);
      broadcastReaction({
        expression: 'wink',
        motion: 'nod',
        speech: '已加入队列，当前步骤完成后继续执行。',
        badge: `已排队 ${list.length} 条指令`,
      }, { urgent: false });
      broadcast('state:sync', snapshotState());
      return { ok: true, delivery: 'hook-queue' };
    }

    // 3. Otherwise (Standalone Mini mode OR continuing from an idle session): run via `agy.exe` CLI stream-json!
    let ownerSession = targetSession;
    const selectedProjObj =
      antigravityProjects.find((p) => p.id === settings.selectedProjectId) ||
      antigravityProjects[0] ||
      null;

    if (mode === 'standalone-new' || !ownerSession) {
      const newLocalId = `proj-${Date.now().toString(36)}`;
      ownerSession = ensureSession({
        conversationId: newLocalId,
        projectId: selectedProjObj?.id || '',
        projectName: selectedProjObj?.name || '',
        title: trimmed.slice(0, 36),
        workspacePaths: [cwd || selectedProjObj?.workspacePath || settings.defaultWorkspace],
        lastUserInput: trimmed,
      });
    } else if (!ownerSession.title || ownerSession.title === '新对话') {
      ownerSession.title = trimmed.slice(0, 36);
    }

    const workspaceDir = sanitizeWorkspace(
      cwd || ownerSession.workspacePath || selectedProjObj?.workspacePath || settings.defaultWorkspace
    );
    ownerSession.workspacePath = workspaceDir;

    // Only pass --conversation when we have a valid `antigravity-cli` trajectory UUID!
    // Passing an Antigravity Desktop GUI UUID to `agy.exe --conversation` fails with `trajectory not found`.
    const cliResumeId = mode === 'standalone-new'
      ? null
      : (ownerSession.cliCompanionId || (isNativeCliSession(ownerSession.conversationId, ownerSession.transcriptPath) ? ownerSession.conversationId : null));

    let effectivePrompt = trimmed;
    if (!cliResumeId && mode !== 'standalone-new' && (ownerSession.lastUserInput || ownerSession.lastAssistantReply)) {
      const ctxSnippet = (ownerSession.lastAssistantReply || '').slice(0, 500);
      effectivePrompt =
        `[桌面会话上下文参考（项目: ${ownerSession.projectName || workspaceDir}）：\n` +
        (ownerSession.title ? `- 会话标题：${ownerSession.title}\n` : '') +
        (ownerSession.lastUserInput ? `- 最近用户问题：${ownerSession.lastUserInput.slice(0, 200)}\n` : '') +
        (ctxSnippet ? `- 最近助手结论摘要：${ctxSnippet}\n` : '') +
        `]\n\n请直接针对以下新指令作答或执行操作：\n${trimmed}`;
    }

    clearToolDebounceTimer(ownerSession.conversationId);
    clearAwaitingIdleTimer(ownerSession.conversationId);
    ownerSession.lastUserInput = trimmed;
    ownerSession.messages.push({ role: 'user', text: trimmed, via: 'agy-cli', ts: Date.now() });
    if (ownerSession.messages.length > 40) ownerSession.messages.shift();
    ownerSession.status = 'THINKING';
    ownerSession.badge = '执行指令中';
    activeConversationId = ownerSession.conversationId;

    runner.runTurn({
      prompt: effectivePrompt,
      ownerSessionId: ownerSession.conversationId,
      cliConversationId: cliResumeId,
      projectId: ownerSession.projectId || selectedProjObj?.id || null,
      cwd: workspaceDir,
    });

    broadcastReaction({
      expression: 'determined',
      motion: 'jump',
      speech: cliResumeId ? '正在续接会话执行指令。' : '正在执行指令。',
      badge: '执行指令中',
      thinking: true,
    }, { urgent: false });
    broadcast('state:sync', snapshotState());
    return { ok: true, delivery: 'agy-cli', resumedConversationId: cliResumeId || null };
  }

  // Wire TranscriptWatcher real-time events (both root conversations and recursive subagent/swarm trees)
  watcher.on('step', (ev) => {
    subagentTracker.handleTranscriptStep(ev);

    if (subagentTracker.isChildConversation(ev.conversationId) || knownChildIds.has(ev.conversationId)) {
      return;
    }
    let s = sessions.get(ev.conversationId);
    if (!s && !ev.quiet && !isSubagentCid(ev.conversationId)) {
      s = dockToLatestSession(ev.conversationId, { timestampMs: Date.now(), announceSwitch: true });
    }
    if (!s) return;
    if (!ev.quiet) {
      s.updatedAt = Date.now();
      if (activeConversationId !== ev.conversationId) {
        dockToLatestSession(ev.conversationId, { timestampMs: Date.now(), announceSwitch: true });
      }
    }

    if (ev.kind === 'compacted') {
      const prevLimit = s.telemetry?.contextLimit || (Number(ev.step?.input_tokens || 0) > 256000 ? 512000 : 256000);
      s.telemetry = buildCompactedTelemetry(
        ev.step?.output_tokens || 0,
        prevLimit,
        ev.step?.input_tokens || 0
      );
      if (!ev.quiet) {
        s.badge = '上下文已压缩';
        refreshSessionTelemetry(ev.conversationId);
        broadcastReaction({
          expression: 'happy',
          motion: 'nod',
          badge: s.badge,
          thinking: false,
        }, { urgent: false });
        broadcast('state:sync', snapshotState());
      }
      return;
    }

    if (ev.kind === 'usage') {
      s.telemetry = buildTranscriptTelemetry(ev.step, s.telemetry, s.lastInvocationStartMs);
      if (!ev.quiet) {
        refreshSessionTelemetry(ev.conversationId);
        broadcast('state:sync', snapshotState());
      }
      return;
    }

    if (ev.kind === 'thinking') {
      s.lastThinking = ev.text;
      if (!ev.quiet) {
        broadcast('pet:thinking', { conversationId: ev.conversationId, text: ev.text });
      }
    } else if (ev.kind === 'assistant_reply') {
      s.lastAssistantReply = ev.text;
      if (ev.finalTurn) {
        clearToolDebounceTimer(s.conversationId);
        lastToolStatusChangeAt = 0;
        lastStatusChangeAt = Date.now();
        s.status = 'AWAITING_NEXT';
        const label = shortTitleLabel(s.title || s.projectName);
        s.badge = label ? `已完成 · ${label}` : '已完成';
        scheduleAwaitingIdleFallback(s);
      }
      // Avoid duplicating identical consecutive assistant messages
      const lastMsg = s.messages[s.messages.length - 1];
      if (!lastMsg || lastMsg.text !== ev.text) {
        s.messages.push({ role: 'assistant', text: ev.text, ts: Date.parse(ev.createdAt) || Date.now() });
        if (s.messages.length > 40) s.messages.shift();
      }
      if (!ev.quiet) {
        broadcast('pet:assistant', { conversationId: ev.conversationId, text: ev.text });
        broadcast('state:sync', snapshotState());
      }
    } else if (ev.kind === 'user_input') {
      clearToolDebounceTimer(s.conversationId);
      clearAwaitingIdleTimer(s.conversationId);
      s.lastUserInput = ev.text;
      if (!s.title || s.title === '新对话') s.title = ev.text.slice(0, 36);
      s.status = 'THINKING';
      lastStatusChangeAt = Date.now();
      s.badge = `思考中 · ${shortTitleLabel(ev.text, 16)}`;
      const lastMsg = s.messages[s.messages.length - 1];
      if (!lastMsg || lastMsg.text !== ev.text) {
        s.messages.push({ role: 'user', text: ev.text, ts: Date.parse(ev.createdAt) || Date.now() });
        if (s.messages.length > 40) s.messages.shift();
      }
      if (!ev.quiet) {
        // Auto-yield any pending MCP wait if user typed directly in the main Desktop window
        for (const w of pendingMcpWaits.values()) {
          if (w.conversationId === ev.conversationId) {
            w.resolve({ nextInstruction: '', endCompanion: false, yieldedToMainWindow: true });
          }
        }
        broadcast('state:sync', snapshotState());
      }
    } else if (ev.kind === 'tool_call') {
      handleToolPresentationEvent(s, ev.toolName, ev.args, { quiet: Boolean(ev.quiet), makeActive: !ev.quiet });
    } else if (ev.kind === 'ask_question') {
      clearToolDebounceTimer(s.conversationId);
      clearAwaitingIdleTimer(s.conversationId);
      lastStatusChangeAt = Date.now();
      s.status = 'WAITING_USER';
      s.badge = '等待确认';
      if (!ev.quiet) {
        activeConversationId = ev.conversationId;
        broadcastReaction({
          expression: 'confused',
          motion: 'wave',
          speech: '主窗口有一个问题等待确认。',
          badge: s.badge,
          thinking: false,
        }, { urgent: true });
        broadcast('state:sync', snapshotState());
      }
    }
  });

  // Wire AgyRunner standalone/resumed CLI streaming events
  function bindCliIdToOwner(ownerSessionId, cliConversationId) {
    if (ownerSessionId && cliConversationId && ownerSessionId !== cliConversationId) {
      linkedCliToOwner.set(cliConversationId, ownerSessionId);
      const owner = sessions.get(ownerSessionId);
      if (owner) {
        owner.cliCompanionId = cliConversationId;
        const candidateTitle =
          owner.title && owner.title !== '新对话' ? owner.title : owner.lastUserInput;
        if (candidateTitle) {
          saveConversationAnnotationTitle(cliConversationId, candidateTitle);
        }
      }
      // Merge & remove accidental duplicate entry if hooks created one milliseconds earlier
      if (sessions.has(cliConversationId)) {
        sessions.delete(cliConversationId);
      }
      if (activeConversationId === cliConversationId) {
        activeConversationId = ownerSessionId;
      }
    }
  }

  runner.on('delta', ({ ownerSessionId, cliConversationId, delta, fullText }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    s.lastAssistantReply = fullText;
    broadcast('pet:stream_delta', { conversationId: cid, delta, fullText });
  });

  runner.on('thinking', ({ ownerSessionId, cliConversationId, thinking }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    const short = thinking.trim().slice(-86);
    s.lastThinking = short;
    broadcast('pet:thinking', { conversationId: cid, text: short });
  });

  runner.on('tool', ({ ownerSessionId, cliConversationId, toolName, toolArgs }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    subagentTracker.handleLiveToolCall(cliConversationId || cid, toolName, toolArgs);
    handleToolPresentationEvent(s, toolName, toolArgs, { quiet: false, makeActive: false });
  });

  runner.on('done', ({ code, ownerSessionId, cliConversationId, reply, stderr }) => {
    bindCliIdToOwner(ownerSessionId, cliConversationId);
    const cid = ownerSessionId || cliConversationId || activeConversationId || 'local-mini';
    const s = ensureSession({ conversationId: cid });
    clearToolDebounceTimer(cid);
    lastToolStatusChangeAt = 0;
    lastStatusChangeAt = Date.now();
    if (code === 0) {
      s.status = 'AWAITING_NEXT';
      s.badge = '已完成';
      if (reply) {
        s.lastAssistantReply = reply;
        const lastMsg = s.messages[s.messages.length - 1];
        if (!lastMsg || lastMsg.text !== reply) {
          s.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
        }
      }
      scheduleAwaitingIdleFallback(s);
      broadcastReaction({
        expression: 'happy',
        motion: null,
        speech: reply ? (reply.length > 100 ? reply.slice(0, 98) + '…' : reply) : '执行完成。',
        badge: s.badge,
        thinking: false,
      }, { urgent: false });
    } else {
      clearAwaitingIdleTimer(cid);
      s.status = 'ERROR';
      s.badge = `执行异常 · 退出码 ${code}`;
      broadcastReaction({
        expression: 'flustered',
        motion: 'shiver',
        speech: `执行出错：${(stderr || '未知错误').slice(0, 80)}`,
        badge: s.badge,
        thinking: false,
      }, { urgent: true });
    }
    broadcast('state:sync', snapshotState());
    refreshCatalog().catch(() => {});
  });

  function startNewConversationUnderProject(proj) {
    if (!proj) return null;
    settings.selectedProjectId = proj.id;
    if (proj.workspacePath) {
      settings.selectedProject = proj.workspacePath;
      settings.defaultWorkspace = proj.workspacePath;
    }
    saveSettings(settings);

    const newId = `proj-${Date.now().toString(36)}`;
    const s = ensureSession({
      conversationId: newId,
      projectId: proj.id,
      projectName: proj.name,
      title: '新对话',
      workspacePaths: [proj.workspacePath || settings.defaultWorkspace],
    });
    s.badge = `已选中项目「${proj.name}」`;
    s.status = 'IDLE';
    activeConversationId = newId;
    return s;
  }

  // WebSocket client connection from Renderer UI
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state:sync', payload: snapshotState(), ts: Date.now() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      const { type, payload = {} } = msg;
      if (type === 'ui:send_command') {
        dispatchUserCommand({
          text: payload.text,
          targetConversationId: payload.conversationId || activeConversationId,
          mode: payload.mode || settings.mode,
          cwd: payload.cwd,
        });
      } else if (type === 'ui:resolve_approval') {
        const appr = pendingApprovals.get(payload.id);
        if (appr) {
          appr.resolve(
            payload.decision === 'allow' ? 'allow' : 'deny',
            payload.decision === 'deny' ? (payload.reason || '用户在桌宠拦截了该命令') : undefined
          );
          broadcast('pet:Reaction', {
            expression: payload.decision === 'allow' ? 'happy' : 'determined',
            motion: payload.decision === 'allow' ? 'nod' : 'shake',
            speech: payload.decision === 'allow' ? '已放行命令～' : '已帮你拦下该命令！',
          });
        }
      } else if (type === 'ui:cancel_mcp_wait') {
        const w = pendingMcpWaits.get(payload.id);
        if (w) {
          w.resolve({ nextInstruction: '用户已结束桌宠值守模式，本轮无需其他操作。', endCompanion: true });
        }
      } else if (type === 'ui:stop_agy') {
        runner.stop();
        broadcast('state:sync', snapshotState());
      } else if (type === 'ui:select_project') {
        const proj = antigravityProjects.find((p) => p.id === payload.projectId);
        if (proj) {
          settings.selectedProjectId = proj.id;
          if (proj.workspacePath) {
            settings.selectedProject = proj.workspacePath;
          }
          saveSettings(settings);

          if (proj.conversations && proj.conversations.length > 0) {
            const topConvo = proj.conversations[0];
            ensureSession({
              conversationId: topConvo.conversationId,
              projectId: proj.id,
              projectName: proj.name,
              title: topConvo.title,
              workspacePaths: [topConvo.workspacePath || proj.workspacePath],
              transcriptPath: topConvo.transcriptPath,
              preserveTimestamp: true,
            });
            activeConversationId = topConvo.conversationId;
          } else {
            startNewConversationUnderProject(proj);
          }
          broadcast('state:sync', snapshotState());
        }
      } else if (type === 'ui:select_session') {
        const cid = payload.conversationId;
        if (!cid) return;
        const catalogHit = findCatalogConversation(cid);
        const sel = ensureSession({
          conversationId: cid,
          projectId: catalogHit?.proj?.id,
          projectName: catalogHit?.proj?.name,
          title: catalogHit?.convo?.title,
          workspacePaths: catalogHit?.convo?.workspacePath ? [catalogHit.convo.workspacePath] : undefined,
          transcriptPath: catalogHit?.convo?.transcriptPath,
          preserveTimestamp: true,
        });
        activeConversationId = cid;
        if (sel?.projectId) {
          settings.selectedProjectId = sel.projectId;
        }
        if (sel?.workspacePath) {
          settings.selectedProject = sel.workspacePath;
        }
        saveSettings(settings);
        broadcast('state:sync', snapshotState());
      } else if (type === 'ui:new_project_chat') {
        const proj =
          antigravityProjects.find((p) => p.id === (payload.projectId || settings.selectedProjectId)) ||
          findCatalogProjectByPath(payload.projectPath || settings.selectedProject) ||
          antigravityProjects[0];
        if (proj) {
          const s = startNewConversationUnderProject(proj);
          broadcastReaction({
            expression: 'excited',
            motion: 'wave',
            speech: `已在项目「${proj.name}」准备好新对话。`,
            badge: s?.badge || `项目「${proj.name}」新对话`,
            thinking: false,
          }, { urgent: false });
          broadcast('state:sync', snapshotState());
        }
      } else if (type === 'ui:update_settings') {
        applySettingsUpdate(payload);
      } else if (type === 'ui:test_spawn_subagent') {
        subagentTracker.spawnTestSubagent(payload);
      } else if (type === 'ui:clear_subagents') {
        subagentTracker.clearAll();
      } else if (type === 'ui:remove_subagent') {
        if (payload.id) {
          subagentTracker.removeById(payload.id);
        }
      } else if (type === 'ui:whale_diag') {
        whaleDiag = { ...payload, ts: Date.now() };
      }
    });
  });

  async function refreshCatalog() {
    try {
      const list = await loadAntigravityCatalog();
      if (list?.childIds) {
        for (const cid of list.childIds) knownChildIds.add(cid);
      }
      if (!Array.isArray(list) || list.length === 0) return;
      antigravityProjects = list;

      const allConvos = [];
      for (const proj of list) {
        for (const c of proj.conversations || []) {
          allConvos.push(c);
          const existing = sessions.get(c.conversationId);
          if (existing) {
            existing.projectId = proj.id;
            existing.projectName = proj.name;
            if (c.title && (!existing.title || existing.title === '新对话' || existing.title.startsWith('对话 '))) {
              existing.title = c.title;
              if ((existing.status === 'IDLE' || existing.status === 'AWAITING_NEXT') && activeConversationId === c.conversationId) {
                existing.badge = `当前会话 · ${shortTitleLabel(c.title)}`;
              }
            }
            if (!existing.transcriptPath && c.transcriptPath) {
              existing.transcriptPath = c.transcriptPath;
              watcher.attach(c.conversationId, c.transcriptPath);
            }
          }
        }
      }

      // Sort globally by most recent view OR message activity (`updatedAt` = max(activityMs, viewTimeMs, transcriptMtimeMs))
      allConvos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      // Pre-attach TranscriptWatcher to top 8 most recent root conversations so any prompt in any open window switches in <50ms!
      for (const c of allConvos.slice(0, 8)) {
        if (!sessions.has(c.conversationId)) {
          ensureSession({
            conversationId: c.conversationId,
            projectId: c.projectId,
            projectName: c.projectName,
            title: c.title,
            workspacePaths: [c.workspacePath],
            transcriptPath: c.transcriptPath,
            preserveTimestamp: true,
            preserveSelection: true,
          });
        }
      }

      // Also scan `brain/` for brand-new conversations created in the last 20 seconds before SQLite summary flushes
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      if (fs.existsSync(brainDir)) {
        const now = Date.now();
        try {
          for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
            if (!ent.isDirectory() || knownChildIds.has(ent.name)) continue;
            const tp = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
            if (!fs.existsSync(tp)) continue;
            const st = fs.statSync(tp);
            if (now - st.mtimeMs < 20000 && !isSubagentCid(ent.name, tp)) {
              const s = sessions.get(ent.name) || ensureSession({
                conversationId: ent.name,
                transcriptPath: tp,
                preserveTimestamp: true,
                preserveSelection: true,
              });
              if (st.mtimeMs > (s.updatedAt || 0)) s.updatedAt = Math.floor(st.mtimeMs);
            }
          }
        } catch { /* ignore */ }
      }

      // Pick the globally newest root session across both catalog and live sessions
      let newestCid = allConvos[0]?.conversationId || null;
      let newestTs = allConvos[0]?.updatedAt || 0;
      for (const s of sessions.values()) {
        if (s.conversationId.startsWith('proj-') || s.conversationId.startsWith('mini-') || isSubagentCid(s.conversationId, s.transcriptPath)) {
          continue;
        }
        if ((s.updatedAt || 0) > newestTs) {
          newestTs = s.updatedAt || 0;
          newestCid = s.conversationId;
        }
      }

      if (newestCid) {
        const curActive = activeConversationId ? sessions.get(activeConversationId) : null;
        const shouldSwitch =
          !activeConversationId ||
          !curActive ||
          (newestCid !== activeConversationId && newestTs > (curActive.updatedAt || 0) + 500);

        if (shouldSwitch) {
          dockToLatestSession(newestCid, {
            timestampMs: newestTs,
            announceSwitch: Boolean(activeConversationId),
          });
        }
      }

      if (activeConversationId) {
        refreshSessionTelemetry(activeConversationId);
      }
      broadcast('state:sync', snapshotState());
    } catch {
      // Ignore transient DB/FS read error
    }
  }

  // Real-time `fs.watch` on `annotations/*.pbtxt`: detects tab switches & `+ New Chat` in Antigravity IDE in <50ms!
  let annotationWatcher = null;
  try {
    if (fs.existsSync(ANNOTATIONS_DIR)) {
      annotationWatcher = fs.watch(ANNOTATIONS_DIR, { persistent: false }, (_ev, filename) => {
        if (!filename || !filename.endsWith('.pbtxt')) return;
        const cid = filename.slice(0, -6);
        setTimeout(() => {
          if (isSubagentCid(cid)) return;
          const ann = readSingleAnnotation(cid);
          if (!ann || !ann.viewTimeMs) return;
          const curActive = activeConversationId ? sessions.get(activeConversationId) : null;
          if (!activeConversationId || (cid !== activeConversationId && ann.viewTimeMs >= (curActive?.updatedAt || 0) - 500)) {
            const s = dockToLatestSession(cid, {
              title: ann.title,
              timestampMs: ann.viewTimeMs,
              announceSwitch: true,
            });
            if (s && ann.title) {
              s.title = ann.title;
              if (s.status === 'IDLE' || s.status === 'AWAITING_NEXT') {
                s.badge = `当前会话 · ${shortTitleLabel(ann.title)}`;
              }
              broadcast('state:sync', snapshotState());
            }
          }
        }, 40);
      });
      annotationWatcher.on('error', () => {});
    }
  } catch { /* fallback timer handles it */ }

  refreshCatalog();
  const brainScanTimer = setInterval(refreshCatalog, 3000);
  brainScanTimer.unref?.();

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[BridgeServer] Port ${port} already in use; attaching to existing bridge.`);
          resolve({ port, reused: true });
        } else {
          reject(err);
        }
      });
      server.requestTimeout = 12 * 60 * 1000;
      server.listen(port, '127.0.0.1', () => {
        console.log(`[BridgeServer] Listening on http://127.0.0.1:${port}`);
        resolve({ port, reused: false });
      });
    });
  }

  function close() {
    clearInterval(brainScanTimer);
    if (reviewKitSyncTimer) {
      clearTimeout(reviewKitSyncTimer);
      reviewKitSyncTimer = null;
    }
    for (const t of awaitingIdleTimers.values()) clearTimeout(t);
    awaitingIdleTimers.clear();
    awaitingSinceMap.clear();
    for (const t of toolDebounceTimers.values()) clearTimeout(t);
    toolDebounceTimers.clear();
    try { annotationWatcher?.close(); } catch { /* ignore */ }
    subagentTracker?.dispose();
    watcher.dispose();
    runner.stop();
    wss.close();
    server.close();
  }

  return {
    start,
    close,
    port,
    pushRendererLog: (entry) => { rendererLogs.push(entry); if (rendererLogs.length > 50) rendererLogs.shift(); },
    getSettings: () => settings,
    getPacks: () => packs,
    getActivePack,
    getActiveThumbPath: () => resolveThumbFilePath(getActivePack(), settings.scheme, PROJECT_ROOT),
    selectPack,
    reloadPacks,
    syncReviewKit: () => runReviewKitSyncNow(),
    broadcastStateSync: () => broadcast('state:sync', snapshotState()),
    updateSettings: (patch) => applySettingsUpdate(patch),
    spawnTestSubagent: (payload) => subagentTracker?.spawnTestSubagent(payload),
    clearSubagents: () => subagentTracker?.clearAll(),
  };
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      totalBytes += c.length;
      if (totalBytes > maxBytes) {
        settled = true;
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

if (require.main === module && process.argv.includes('--standalone')) {
  const bridge = createBridgeServer();
  bridge.start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createBridgeServer, DEFAULT_PORT, isAllowedLocalOrigin };
