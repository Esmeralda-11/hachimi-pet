const { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createBridgeServer, DEFAULT_PORT } = require('./bridge-server.cjs');
const { getPacksRoot } = require('./pack-registry.cjs');
const { decodePng, encodePng } = require('./png-codec.cjs');

const isDev = process.argv.includes('--dev');
const FORWARD_MOVES = process.platform !== 'win32';

// Ensure single instance (important when launched via Antigravity Sidecar + manual shortcut)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let mainWin = null;
/** @type {Tray | null} */
let tray = null;
/** @type {NodeJS.Timeout | null} */
let trayDestroyTimer = null;
let clickThroughLocked = false;
let bridge = null;

// Mouse capture lease state (inspired by Coopanion's mouse-lease.cjs)
let wantedCapture = false;
let leaseExpiresAt = 0;
let appliedIgnore = null;

function applyMouseState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const isHidden = !!bridge?.getSettings?.()?.petHidden;
  if (isHidden) {
    wantedCapture = false;
    leaseExpiresAt = 0;
  }
  const now = Date.now();
  const shouldCapture = !isHidden && !clickThroughLocked && wantedCapture && now < leaseExpiresAt && mainWin.isVisible();
  const shouldIgnore = !shouldCapture;
  if (appliedIgnore === shouldIgnore) return;
  appliedIgnore = shouldIgnore;
  if (shouldIgnore) {
    mainWin.setIgnoreMouseEvents(true, FORWARD_MOVES ? { forward: true } : undefined);
  } else {
    mainWin.setIgnoreMouseEvents(false);
  }
}

/**
 * Compute work-area bounds leaving a 2px safety margin from full monitor bounds
 * so Windows DWM never classifies the transparent overlay as a fullscreen exclusive app.
 */
function getOverlayBounds() {
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const b = disp.bounds;
  let { x, y, width, height } = wa;
  if (x === b.x && y === b.y && width === b.width && height === b.height) {
    height = Math.max(200, height - 2);
  }
  return { x, y, width, height };
}

const TRAY_CANVAS_SIZE = 44;
const TRAY_INNER_MAX = 36;
let lastTrayThumbKey = '';

function findAlphaBboxRgba(img, threshold = 8) {
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

function cropRgbaRect(img, rx, ry, rw, rh) {
  const data = new Uint8Array(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const sy = ry + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < rw; x++) {
      const sx = rx + x;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (y * rw + x) * 4;
      data[di] = img.data[si];
      data[di + 1] = img.data[si + 1];
      data[di + 2] = img.data[si + 2];
      data[di + 3] = img.data[si + 3];
    }
  }
  return { width: rw, height: rh, data };
}

/**
 * Premultiplied-alpha bilinear / fractional-area resampler for smooth @2x tray icons.
 */
function resizeRgbaBilinear(src, dstW, dstH) {
  const data = new Uint8Array(dstW * dstH * 4);
  const scaleX = src.width / dstW;
  const scaleY = src.height / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const di = (y * dstW + x) * 4;
      if (scaleX > 1.2 || scaleY > 1.2) {
        const sx0 = x * scaleX;
        const sx1 = (x + 1) * scaleX;
        const sy0 = y * scaleY;
        const sy1 = (y + 1) * scaleY;
        const ix0 = Math.max(0, Math.floor(sx0));
        const ix1 = Math.min(src.width - 1, Math.floor(sx1 - 1e-6));
        const iy0 = Math.max(0, Math.floor(sy0));
        const iy1 = Math.min(src.height - 1, Math.floor(sy1 - 1e-6));
        let sr = 0, sg = 0, sb = 0, sa = 0, wSum = 0;
        for (let iy = iy0; iy <= iy1; iy++) {
          const wy = Math.min(iy + 1, sy1) - Math.max(iy, sy0);
          if (wy <= 0) continue;
          for (let ix = ix0; ix <= ix1; ix++) {
            const wx = Math.min(ix + 1, sx1) - Math.max(ix, sx0);
            if (wx <= 0) continue;
            const w = wx * wy;
            const si = (iy * src.width + ix) * 4;
            const a = (src.data[si + 3] / 255) * w;
            sr += src.data[si] * a;
            sg += src.data[si + 1] * a;
            sb += src.data[si + 2] * a;
            sa += a;
            wSum += w;
          }
        }
        if (wSum > 0 && sa > 1e-4) {
          const avgA = sa / wSum;
          data[di] = Math.min(255, Math.round(sr / sa));
          data[di + 1] = Math.min(255, Math.round(sg / sa));
          data[di + 2] = Math.min(255, Math.round(sb / sa));
          data[di + 3] = Math.min(255, Math.round(avgA * 255));
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
        const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let k = 0; k < 4; k++) {
          const a = (src.data[idx[k] + 3] / 255) * weights[k];
          sr += src.data[idx[k]] * a;
          sg += src.data[idx[k] + 1] * a;
          sb += src.data[idx[k] + 2] * a;
          sa += a;
        }
        if (sa > 1e-4) {
          data[di] = Math.min(255, Math.round(sr / sa));
          data[di + 1] = Math.min(255, Math.round(sg / sa));
          data[di + 2] = Math.min(255, Math.round(sb / sa));
          data[di + 3] = Math.min(255, Math.round(sa * 255));
        }
      }
    }
  }
  return { width: dstW, height: dstH, data };
}

/**
 * Center any sprite RGBA into a 44x44 (@2x = 22x22pt) transparent canvas within 36x36 max inner bounds,
 * leaving at least 4px (2pt) transparent margin on top and bottom so macOS menu bar stays balanced without clipping.
 */
function renderTrayCanvas44FromRgba(srcRgba) {
  const bb = findAlphaBboxRgba(srcRgba, 8);
  const cropped = bb ? cropRgbaRect(srcRgba, bb.x, bb.y, bb.w, bb.h) : srcRgba;
  const scale = Math.min(TRAY_INNER_MAX / cropped.width, TRAY_INNER_MAX / cropped.height);
  const nw = Math.max(1, Math.min(TRAY_INNER_MAX, Math.round(cropped.width * scale)));
  const nh = Math.max(1, Math.min(TRAY_INNER_MAX, Math.round(cropped.height * scale)));
  const resized = resizeRgbaBilinear(cropped, nw, nh);

  const canvas = new Uint8Array(TRAY_CANVAS_SIZE * TRAY_CANVAS_SIZE * 4);
  const dx = Math.floor((TRAY_CANVAS_SIZE - nw) / 2);
  const dy = Math.floor((TRAY_CANVAS_SIZE - nh) / 2);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = (y * nw + x) * 4;
      const di = ((dy + y) * TRAY_CANVAS_SIZE + (dx + x)) * 4;
      canvas[di] = resized.data[si];
      canvas[di + 1] = resized.data[si + 1];
      canvas[di + 2] = resized.data[si + 2];
      canvas[di + 3] = resized.data[si + 3];
    }
  }
  return encodePng(TRAY_CANVAS_SIZE, TRAY_CANVAS_SIZE, canvas);
}

function buildTrayIconPngBuffer(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const rawBuf = fs.readFileSync(filePath);
  const src = decodePng(rawBuf);
  return renderTrayCanvas44FromRgba(src);
}

/**
 * Generate a clean 44x44 (@2x = 22x22pt) RGBA whale icon PNG in memory without external binary dependencies.
 */
function createWhaleTrayImage() {
  const W = 48, H = 48;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (y * W + x) * 4;
      const dx = (x - 23.0) / 16.5;
      const dy = (y - 25.0) / 13.5;
      const inBody = dx * dx + dy * dy <= 1.0;
      const inTail = x >= 34 && x <= 45 && Math.abs(y - 22 - (x - 34) * 0.3) < 6.0;
      const inBelly = dx * dx + ((y - 30.0) / 8.0) ** 2 <= 0.72 && y >= 27 && x < 34;
      const inEye = (x - 15) ** 2 + (y - 22) ** 2 <= 4.5;

      if (inEye) {
        data[px] = 20; data[px + 1] = 30; data[px + 2] = 60; data[px + 3] = 255;
      } else if (inBelly) {
        data[px] = 238; data[px + 1] = 245; data[px + 2] = 255; data[px + 3] = 255;
      } else if (inBody || inTail) {
        data[px] = 77; data[px + 1] = 115; data[px + 2] = 254; data[px + 3] = 255;
      }
    }
  }
  const pngBuf = renderTrayCanvas44FromRgba({ width: W, height: H, data });
  return nativeImage.createFromBuffer(pngBuf, { scaleFactor: 2 }).resize({ width: 22, height: 22 });
}

function createTrayIcon() {
  const activeThumb = bridge?.getActiveThumbPath?.();
  const candidates = [
    activeThumb,
    path.join(__dirname, '..', 'dist', 'coopanion', 'whale', 'thumbs', 'astral.png'),
    path.join(__dirname, '..', 'public', 'coopanion', 'whale', 'thumbs', 'astral.png'),
    path.join(__dirname, '..', 'dist', 'coopanion', 'whale', 'assets', 'favicon.png'),
    path.join(__dirname, '..', 'public', 'coopanion', 'whale', 'assets', 'favicon.png'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const pngBuf = buildTrayIconPngBuffer(p);
      if (pngBuf) {
        const im = nativeImage.createFromBuffer(pngBuf, { scaleFactor: 2 });
        if (!im.isEmpty()) return im.resize({ width: 22, height: 22 });
      }
    } catch { /* fallback to next */ }
  }
  return createWhaleTrayImage();
}

function resolveTrayThumbKey() {
  const activeThumb = bridge?.getActiveThumbPath?.() || '';
  if (!activeThumb) return '__whale__';
  try {
    const st = fs.statSync(activeThumb);
    return `${activeThumb}:${st.mtimeMs}`;
  } catch {
    return activeThumb;
  }
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(createTrayIcon());
  lastTrayThumbKey = resolveTrayThumbKey();
  tray.on('click', () => {
    if (bridge?.getSettings?.()?.petHidden) {
      bridge?.updateSettings?.({ petHidden: false });
      appliedIgnore = null;
      applyMouseState();
      refreshTray();
    }
    sendRendererCommand({ type: 'resetPosition' });
  });
  return tray;
}

function destroyTrayNow() {
  if (trayDestroyTimer) {
    clearTimeout(trayDestroyTimer);
    trayDestroyTimer = null;
  }
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy();
    } catch { /* ignore */ }
  }
  tray = null;
  lastTrayThumbKey = '';
}

function syncTrayVisibility({ deferDestroy = false } = {}) {
  const trayHidden = Boolean(bridge?.getSettings?.()?.trayHidden);
  if (trayHidden) {
    if (!tray || tray.isDestroyed()) {
      destroyTrayNow();
      return false;
    }
    if (deferDestroy) {
      if (!trayDestroyTimer) {
        trayDestroyTimer = setTimeout(() => {
          trayDestroyTimer = null;
          if (Boolean(bridge?.getSettings?.()?.trayHidden)) {
            destroyTrayNow();
          }
        }, 30);
      }
    } else {
      destroyTrayNow();
    }
    return false;
  }
  if (trayDestroyTimer) {
    clearTimeout(trayDestroyTimer);
    trayDestroyTimer = null;
  }
  ensureTray();
  return true;
}

function refreshTray(options = false) {
  const forceIcon = typeof options === 'boolean' ? options : Boolean(options?.forceIcon);
  const deferDestroy = typeof options === 'object' && options !== null ? Boolean(options.deferDestroy) : false;
  if (!syncTrayVisibility({ deferDestroy })) return;
  if (!tray || tray.isDestroyed()) return;
  try {
    const thumbKey = resolveTrayThumbKey();
    if (forceIcon || thumbKey !== lastTrayThumbKey) {
      tray.setImage(createTrayIcon());
      lastTrayThumbKey = thumbKey;
    }
    const activePack = bridge?.getActivePack?.();
    const s = bridge?.getSettings?.();
    const activeVar = activePack?.variants?.find((v) => v.id === s?.scheme);
    const hiddenTag = s?.petHidden ? ' · 已隐藏' : '';
    const varName = activeVar?.name || activeVar?.label || activeVar?.id || '';
    const title = activePack
      ? `桌宠 · ${activePack.name}${varName ? ` · ${varName}` : ''}${hiddenTag}`
      : `桌宠${hiddenTag}`;
    tray.setToolTip(title);
  } catch { /* ignore */ }
  rebuildTrayMenu();
}

function buildPetMenu() {
  const s = bridge?.getSettings?.() || {
    packId: 'hachimi',
    scheme: 'astral',
    outfit: 'maid',
    roam: 'free',
    temperament: 'daily',
    theme: 'system',
    palette: 'forest',
    mainScale: 0.85,
    subagentScale: 0.80,
    petHidden: false,
    trayHidden: false,
    showSpeechBubble: true,
    showStatusPill: true,
    showTelemetryBar: true,
    showSubagentHud: true,
    soundOn: true,
    interceptRiskyOnly: true,
    interceptAllCommands: false,
  };
  const packs = bridge?.getPacks?.() || [];
  const activePack = bridge?.getActivePack?.() || packs[0];
  const variants = Array.isArray(activePack?.variants) ? activePack.variants : [];
  const temperament = ['lively', 'daily', 'quiet'].includes(s.temperament) ? s.temperament : 'daily';
  const mainScale = Number(s.mainScale ?? s.scale ?? 0.85);
  const subagentScale = Number(s.subagentScale ?? 0.80);

  const packMenuItems = packs.length > 0
    ? packs.map((p) => ({
        label: p.slotLabel || p.name || p.id,
        type: 'radio',
        checked: s.packId === p.id,
        click: () => {
          bridge?.selectPack?.(p.id);
          refreshTray(true);
        },
      }))
    : [{ label: '默认形象', type: 'radio', checked: true }];

  const memberMenuItems = variants.length > 0
    ? variants.map((v) => ({
        label: v.name || v.label || v.id,
        type: 'radio',
        checked: s.scheme === v.id,
        click: () => {
          bridge?.selectPack?.(activePack.id, v.id);
          refreshTray(true);
        },
      }))
    : [{ label: '星瞳紫', type: 'radio', checked: true }];

  const mainScalePresets = [
    { label: '大', value: 1.10 },
    { label: '中', value: 0.85 },
    { label: '小', value: 0.65 },
  ];
  const subScalePresets = [
    { label: '大', value: 1.00 },
    { label: '中', value: 0.80 },
    { label: '小', value: 0.60 },
  ];

  const menu = Menu.buildFromTemplate([
    // 1. 桌宠即时控制（高频控场，离菜单栏图标最近）
    {
      label: '隐藏桌宠',
      type: 'checkbox',
      checked: !!s.petHidden,
      click: (item) => {
        bridge?.updateSettings?.({ petHidden: Boolean(item.checked) });
        appliedIgnore = null;
        applyMouseState();
        refreshTray();
      },
    },
    {
      label: '回到右下角',
      click: () => {
        if (bridge?.getSettings?.()?.petHidden) {
          bridge?.updateSettings?.({ petHidden: false });
          appliedIgnore = null;
          applyMouseState();
          refreshTray();
        }
        sendRendererCommand({ type: 'resetPosition' });
      },
    },
    {
      label: '穿透锁定',
      type: 'checkbox',
      accelerator: 'Alt+Shift+W',
      checked: clickThroughLocked,
      click: (item) => {
        clickThroughLocked = item.checked;
        appliedIgnore = null;
        applyMouseState();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    // 2. 角色切换
    {
      label: '形象',
      submenu: packMenuItems,
    },
    {
      label: '成员',
      submenu: memberMenuItems,
    },
    { type: 'separator' },
    // 3. 表现与显示（与设置页顺序一致，先子菜单后开关）
    {
      label: '模式',
      submenu: [
        {
          label: '活泼',
          type: 'radio',
          checked: temperament === 'lively',
          click: () => {
            bridge?.updateSettings?.({ temperament: 'lively', roam: 'free' });
            rebuildTrayMenu();
          },
        },
        {
          label: '日常',
          type: 'radio',
          checked: temperament === 'daily',
          click: () => {
            bridge?.updateSettings?.({ temperament: 'daily' });
            rebuildTrayMenu();
          },
        },
        {
          label: '内敛',
          type: 'radio',
          checked: temperament === 'quiet',
          click: () => {
            bridge?.updateSettings?.({ temperament: 'quiet' });
            rebuildTrayMenu();
          },
        },
      ],
    },
    {
      label: '主宠尺寸',
      submenu: mainScalePresets.map((p) => ({
        label: p.label,
        type: 'radio',
        checked: Math.abs(mainScale - p.value) < 0.025,
        click: () => {
          bridge?.updateSettings?.({ mainScale: p.value, scale: p.value });
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '子代理尺寸',
      submenu: subScalePresets.map((p) => ({
        label: p.label,
        type: 'radio',
        checked: Math.abs(subagentScale - p.value) < 0.025,
        click: () => {
          bridge?.updateSettings?.({ subagentScale: p.value });
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '头顶信息',
      submenu: [
        {
          label: '对话与思考',
          type: 'checkbox',
          checked: s.showSpeechBubble !== false,
          click: (item) => {
            bridge?.updateSettings?.({ showSpeechBubble: Boolean(item.checked) });
            rebuildTrayMenu();
          },
        },
        {
          label: '状态',
          type: 'checkbox',
          checked: s.showStatusPill !== false,
          click: (item) => {
            bridge?.updateSettings?.({ showStatusPill: Boolean(item.checked) });
            rebuildTrayMenu();
          },
        },
        {
          label: '上下文与速率',
          type: 'checkbox',
          checked: s.showTelemetryBar !== false,
          click: (item) => {
            bridge?.updateSettings?.({ showTelemetryBar: Boolean(item.checked) });
            rebuildTrayMenu();
          },
        },
        {
          label: '子代理',
          type: 'checkbox',
          checked: s.showSubagentHud !== false,
          click: (item) => {
            bridge?.updateSettings?.({ showSubagentHud: Boolean(item.checked) });
            rebuildTrayMenu();
          },
        },
        { type: 'separator' },
        {
          label: '全部显示',
          click: () => {
            bridge?.updateSettings?.({
              showSpeechBubble: true,
              showStatusPill: true,
              showTelemetryBar: true,
              showSubagentHud: true,
            });
            rebuildTrayMenu();
          },
        },
        {
          label: '全部隐藏',
          click: () => {
            bridge?.updateSettings?.({
              showSpeechBubble: false,
              showStatusPill: false,
              showTelemetryBar: false,
              showSubagentHud: false,
            });
            rebuildTrayMenu();
          },
        },
      ],
    },
    {
      label: '自由走动',
      type: 'checkbox',
      checked: s.roam === 'free',
      click: (item) => {
        bridge?.updateSettings?.({ roam: item.checked ? 'free' : 'off' });
        rebuildTrayMenu();
      },
    },
    {
      label: '音效',
      type: 'checkbox',
      checked: s.soundOn !== false,
      click: (item) => {
        bridge?.updateSettings?.({ soundOn: item.checked });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    // 4. 安全与维护（低频工具）
    {
      label: '命令确认',
      submenu: [
        {
          label: '全部命令',
          type: 'radio',
          checked: !!s.interceptAllCommands,
          click: () => {
            bridge?.updateSettings?.({ interceptAllCommands: true, interceptRiskyOnly: true });
            rebuildTrayMenu();
          },
        },
        {
          label: '仅高危命令',
          type: 'radio',
          checked: !s.interceptAllCommands && s.interceptRiskyOnly !== false,
          click: () => {
            bridge?.updateSettings?.({ interceptRiskyOnly: true, interceptAllCommands: false });
            rebuildTrayMenu();
          },
        },
        {
          label: '关闭',
          type: 'radio',
          checked: !s.interceptAllCommands && s.interceptRiskyOnly === false,
          click: () => {
            bridge?.updateSettings?.({ interceptRiskyOnly: false, interceptAllCommands: false });
            rebuildTrayMenu();
          },
        },
      ],
    },
    {
      label: '子代理预览',
      submenu: [
        {
          label: '生成测试子代理',
          click: () => bridge?.spawnTestSubagent?.(),
        },
        {
          label: '清空子代理',
          click: () => bridge?.clearSubagents?.(),
        },
      ],
    },
    {
      label: '重新加载形象',
      click: () => {
        bridge?.reloadPacks?.();
        refreshTray(true);
      },
    },
    {
      label: '打开本地目录',
      click: () => {
        try {
          const packsDir = getPacksRoot();
          fs.mkdirSync(packsDir, { recursive: true });
          shell.openPath(packsDir);
        } catch { /* ignore */ }
      },
    },
    { type: 'separator' },
    // 5. 系统与退出（macOS 标准底栏）
    {
      label: '设置…',
      click: () => {
        shell.openExternal(`http://127.0.0.1:${DEFAULT_PORT}/workshop`);
      },
    },
    {
      label: s.trayHidden ? '显示状态栏' : '关闭状态栏',
      click: () => {
        const nextHidden = !Boolean(bridge?.getSettings?.()?.trayHidden);
        bridge?.updateSettings?.({ trayHidden: nextHidden });
        refreshTray({ forceIcon: !nextHidden, deferDestroy: nextHidden });
      },
    },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  return menu;
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildPetMenu());
}

function sendRendererCommand(cmd) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('petHost:command', cmd);
}

function createOverlayWindow() {
  const bounds = getOverlayBounds();
  mainWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start in click-through mode until cursor enters pet or UI
  appliedIgnore = null;
  applyMouseState();

  if (isDev) {
    mainWin.loadURL('http://127.0.0.1:5179');
  } else {
    mainWin.loadURL(`http://127.0.0.1:${DEFAULT_PORT}/`);
  }

  // Explicitly call show() + showInactive() on load so Win32 STARTUPINFO SW_HIDE
  // inherited from headless sidecars/daemons never hides the first BrowserWindow!
  mainWin.webContents.once('did-finish-load', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (process.platform === 'darwin') {
      mainWin.showInactive();
    } else {
      mainWin.show();
      mainWin.showInactive();
    }
    mainWin.setAlwaysOnTop(true, 'screen-saver');
    appliedIgnore = null;
    applyMouseState();
  });

  mainWin.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    bridge?.pushRendererLog?.({ level, message, line, sourceId, ts: Date.now() });
  });

  let overlayBounds = getOverlayBounds();
  const updateBounds = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    overlayBounds = getOverlayBounds();
    mainWin.setBounds(overlayBounds);
  };
  screen.on('display-metrics-changed', updateBounds);
  screen.on('display-added', updateBounds);
  screen.on('display-removed', updateBounds);

  // Adaptive ~30Hz cursor hit-test loop for Windows click-through without starving main thread
  let lastX = -99999, lastY = -99999, lastSentAt = 0, lastTopmostAt = 0;
  const cursorTimer = setInterval(() => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const now = Date.now();
    applyMouseState();
    // Re-assert topmost gently every 6s instead of modulo jitter
    if (now - lastTopmostAt > 6000) {
      lastTopmostAt = now;
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    }

    const pt = screen.getCursorScreenPoint();
    const wb = overlayBounds;
    const rx = pt.x - wb.x;
    const ry = pt.y - wb.y;

    if (rx !== lastX || ry !== lastY || now - lastSentAt > 400) {
      lastX = rx;
      lastY = ry;
      lastSentAt = now;
      mainWin.webContents.send('petHost:cursor', {
        x: rx,
        y: ry,
        insideWindow: rx >= 0 && ry >= 0 && rx <= wb.width && ry <= wb.height,
        locked: clickThroughLocked,
      });
    }
  }, 33);

  mainWin.on('closed', () => {
    clearInterval(cursorTimer);
    mainWin = null;
  });
}

app.on('second-instance', () => {
  const s = bridge?.getSettings?.();
  if (s?.petHidden && s?.trayHidden) {
    bridge?.updateSettings?.({ petHidden: false, trayHidden: false });
    appliedIgnore = null;
    applyMouseState();
    refreshTray({ forceIcon: true });
  }
  sendRendererCommand({ type: 'resetPosition' });
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
  bridge = createBridgeServer({
    port: DEFAULT_PORT,
    onShowPanel: () => {},
    onPackChange: () => {
      appliedIgnore = null;
      applyMouseState();
      refreshTray({ deferDestroy: true });
    },
    onGetMouseState: () => ({
      clickThroughLocked,
      petHidden: !!bridge?.getSettings?.()?.petHidden,
      trayHidden: !!bridge?.getSettings?.()?.trayHidden,
      trayActive: Boolean(tray && !tray.isDestroyed()),
      wantedCapture,
      ignoringMouseEvents: appliedIgnore,
      leaseRemainingMs: Math.max(0, leaseExpiresAt - Date.now()),
    }),
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    onCheckPixels: async (box) => {
      if (!mainWin || mainWin.isDestroyed()) return null;
      const rx = Math.max(0, Math.floor(box.x));
      const ry = Math.max(0, Math.floor(box.y));
      const rw = Math.max(16, Math.min(320, Math.ceil(box.w)));
      const rh = Math.max(16, Math.min(320, Math.ceil(box.h)));
      const img = await Promise.race([
        mainWin.webContents.capturePage({ x: rx, y: ry, width: rw, height: rh }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage timeout (transparent DWM idle)')), 900)),
      ]);
      const bmp = img.toBitmap(); // BGRA
      let visiblePixels = 0;
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] > 16) visiblePixels++;
      }
      return { rect: { x: rx, y: ry, w: rw, h: rh }, totalPixels: bmp.length / 4, visiblePixels };
    },
  });
  await bridge.start();

  createOverlayWindow();

  refreshTray({ forceIcon: true });

  // Register Alt+Shift+W emergency hotkey to toggle 100% click-through pass-through mode
  globalShortcut.register('Alt+Shift+W', () => {
    clickThroughLocked = !clickThroughLocked;
    wantedCapture = false;
    leaseExpiresAt = 0;
    appliedIgnore = null;
    applyMouseState();
    rebuildTrayMenu();
  });

  ipcMain.on('petHost:mouseCapture', (_ev, capture) => {
    wantedCapture = !!capture;
    if (wantedCapture) {
      leaseExpiresAt = Date.now() + 1600;
    } else {
      leaseExpiresAt = 0;
    }
    applyMouseState();
  });

  ipcMain.on('petHost:focusWindow', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    wantedCapture = true;
    leaseExpiresAt = Date.now() + 5000;
    appliedIgnore = null;
    applyMouseState();
    mainWin.focus();
  });

  ipcMain.on('petHost:blurWindow', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    wantedCapture = false;
    leaseExpiresAt = 0;
    appliedIgnore = null;
    applyMouseState();
    mainWin.blur();
  });

  ipcMain.on('petHost:openExternal', (_ev, url) => {
    if (typeof url === 'string' && /^https?:\/\/|^file:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('petHost:showContextMenu', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const menu = buildPetMenu();
    menu.popup({
      window: mainWin,
      callback: () => {
        appliedIgnore = null;
        applyMouseState();
      },
    });
  });

  ipcMain.on('petHost:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.handle('petHost:pickDirectory', async () => {
    wantedCapture = true;
    leaseExpiresAt = Date.now() + 60000;
    appliedIgnore = null;
    applyMouseState();
    const res = await dialog.showOpenDialog(mainWin || undefined, {
      title: '选择项目文件夹',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return null;
    }
    return res.filePaths[0];
  });
});

app.on('will-quit', () => {
  if (trayDestroyTimer) {
    clearTimeout(trayDestroyTimer);
    trayDestroyTimer = null;
  }
  globalShortcut.unregisterAll();
  bridge?.close();
});
