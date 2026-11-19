import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { stripEmojiChars } from './StatusBubble';
import type { PetExecutionStatus, PetPackSummary, PetReactionEvent, PetSettings, SubagentItem } from '../types';

export const SCHEME_COLORS: Record<string, string> = {
  astral: '#8B7BF7',
  sakura: '#F472B6',
  azure: '#38BDF8',
  emerald: '#34D399',
  amber: '#F59E0B',
  crimson: '#FB7185',
  arctic: '#94A3B8',
  obsidian: '#6366F1',
  // Legacy compatibility aliases
  gemini: '#8B7BF7',
  deepseek: '#38BDF8',
  claude: '#F59E0B',
  chatgpt: '#94A3B8',
  qwen: '#8B7BF7',
  kimi: '#34D399',
  minimax: '#F472B6',
  harness: '#6366F1',
};

const VALID_SCHEMES = new Set(['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian']);
const LEGACY_TO_CATGIRL: Record<string, string> = {
  gemini: 'astral',
  deepseek: 'azure',
  claude: 'amber',
  chatgpt: 'arctic',
  qwen: 'astral',
  kimi: 'emerald',
  minimax: 'sakura',
  harness: 'obsidian',
};

function resolveCatgirlCombo(scheme?: string): string {
  const s = String(scheme || 'astral').toLowerCase();
  const mapped = VALID_SCHEMES.has(s) ? s : (LEGACY_TO_CATGIRL[s] || 'astral');
  return `${mapped}-maid`;
}

function packSignature(pack: PetPackSummary | null | undefined): string {
  if (!pack) return '';
  return JSON.stringify({
    packId: pack.id ?? '',
    type: pack.type ?? '',
    defaultVariant: pack.defaultVariant ?? '',
    variants: Array.isArray(pack.variants)
      ? pack.variants.map((v) => ({
          id: v.id ?? '',
          assetUrl: v.assetUrl ?? v.asset ?? '',
          thumbUrl: v.thumbUrl ?? v.thumb ?? '',
          layout: v.layout ?? '',
          frameWidth: v.frameWidth ?? null,
          frameHeight: v.frameHeight ?? null,
          cols: v.cols ?? null,
          rows: v.rows ?? null,
          asymmetric: Boolean(v.asymmetric),
        }))
      : [],
  });
}

function toTranslucentBorderColor(color: string): string {
  const trimmed = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `${trimmed}99`;
  }
  return `color-mix(in srgb, ${trimmed || 'var(--accent)'} 60%, transparent)`;
}

export interface WhaleControllerHandle {
  triggerReaction: (ev: PetReactionEvent) => void;
  resetCornerPosition: () => void;
  doWord: (word: string) => void;
}

interface WhaleStageProps {
  settings: PetSettings;
  packs?: PetPackSummary[];
  activePack?: PetPackSummary | null;
  status?: PetExecutionStatus;
  subagents?: SubagentItem[];
  hidden?: boolean;
  onAnchorMove?: (pos: { x: number; y: number; sideX: number; sideY: number }) => void;
  onDiag?: (diag: Record<string, unknown>) => void;
}

const dynamicImport = new Function('url', 'return import(url)') as (url: string) => Promise<any>;

/**
 * Compute a deterministic positive 31-bit integer seed so each pet gets a distinct phase offset.
 */
function hashPersonaSeed(str: string): number {
  let h = 2166136261;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  const seed = h & 0x7fffffff;
  return seed > 0 ? seed : 1;
}

function matchWorkHintText(text: string): string | null {
  if (!text) return null;
  if (/读|查|搜|检|审|浏览|分析|研究|\b(?:read|search|audit|review)/i.test(text)) return 'read';
  if (/等|休|候|\b(?:wait|sleep|idle)/i.test(text)) return 'wait';
  if (/跑|测|构建|命令|安装|同步|验证|验收|\b(?:run|test|build|verif)/i.test(text)) return 'cmd';
  if (/写|改|编|画|生图|修|\b(?:edit|writ|fix|creat)/i.test(text)) return 'code';
  return null;
}

/**
 * Infer a coarse work-beat hint from a subagent's progress text, role, or status.
 */
function inferSubagentWorkHint(sub: { progressText?: string; role?: string; status?: string }): string {
  return (
    matchWorkHintText(String(sub?.progressText || '')) ||
    matchWorkHintText(String(sub?.role || '')) ||
    (sub?.status === 'WAITING' ? 'wait' : 'think')
  );
}

/**
 * Compute non-overlapping horizontal lane X for a subagent based on `slotIndex` and stage width.
 */
function computeSubagentLaneX(slotIndex: number, stageWidth: number): number {
  const usableRight = Math.max(260, stageWidth - 280);
  const usableLeft = 105;
  const span = Math.max(140, usableRight - usableLeft);
  const spacing = 148;
  const maxCols = Math.max(1, Math.floor(span / spacing) + 1);
  const col = slotIndex % maxCols;
  const wave = Math.floor(slotIndex / maxCols);
  const stagger = wave % 2 === 1 ? 68 : 0;
  return Math.max(usableLeft, Math.min(usableRight, usableRight - col * spacing - stagger));
}

/**
 * Gently resolve horizontal/vertical overlaps between overhead subagent HUD cards so every name & progress bar stays readable.
 */
function resolveHudLayout(
  subagents: SubagentItem[],
  anchors: Record<string, { x: number; y: number }>,
  stageWidth: number
): Record<string, { x: number; y: number }> {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const sorted = [...subagents]
    .filter((s) => Boolean(anchors[s.id]))
    .sort((a, b) => (anchors[a.id]?.x ?? 0) - (anchors[b.id]?.x ?? 0));

  const minX = 92;
  const maxX = Math.max(180, stageWidth - 92);
  const pillHalfW = 86;

  for (const sub of sorted) {
    const raw = anchors[sub.id];
    let x = Math.max(minX, Math.min(maxX, raw.x));
    let y = raw.y - 4;

    for (const prev of placed) {
      const dx = Math.abs(x - prev.x);
      const dy = Math.abs(y - prev.y);
      if (dx < pillHalfW * 1.85 && dy < 46) {
        // Stack vertically above the neighboring pill if whales are standing very close
        y = prev.y - 52;
      }
    }
    placed.push({ id: sub.id, x, y });
  }

  const out: Record<string, { x: number; y: number }> = {};
  for (const p of placed) out[p.id] = { x: p.x, y: p.y };
  return out;
}

/**
 * Inspect `[data-pet-interactive="true"]` elements with strict anti-masking circuit breakers.
 */
function collectInteractiveRects() {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const nodes = document.querySelectorAll<HTMLElement>('[data-pet-interactive="true"]');
  const validRects: Array<{ cls: string; x: number; y: number; w: number; h: number }> = [];
  let skippedOversized = 0;

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    // Circuit breaker: NEVER allow any full-screen or oversized wrapper (>55% width & >55% height) to block desktop clicks!
    if (r.width > vw * 0.55 && r.height > vh * 0.55) {
      skippedOversized++;
      continue;
    }

    const cs = window.getComputedStyle(el);
    if (
      cs.pointerEvents === 'none' ||
      cs.visibility === 'hidden' ||
      cs.display === 'none' ||
      cs.opacity === '0'
    ) {
      continue;
    }

    validRects.push({
      cls: el.className || el.tagName,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }

  return { validRects, skippedOversized };
}

export const WhaleStage = forwardRef<WhaleControllerHandle, WhaleStageProps>(function WhaleStage(
  { settings, packs = [], activePack = null, status = 'IDLE', subagents = [], hidden, onAnchorMove, onDiag },
  ref
) {
  const isHidden = Boolean(hidden ?? settings.petHidden);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<SVGEllipseElement | null>(null);
  const petGRef = useRef<SVGGElement | null>(null);
  const fxGRef = useRef<SVGGElement | null>(null);

  const ctlRef = useRef<any>(null);
  const figRef = useRef<any>(null);
  const sfxRef = useRef<any>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const hiddenRef = useRef(isHidden);
  hiddenRef.current = isHidden;
  const packsRef = useRef(packs);
  packsRef.current = packs;
  const activePackRef = useRef(activePack);
  activePackRef.current = activePack;
  const statusRef = useRef(status);
  statusRef.current = status;
  const scaleRef = useRef(settings.mainScale ?? settings.scale ?? 0.85);
  scaleRef.current = settings.mainScale ?? settings.scale ?? 0.85;
  const subScaleRef = useRef(settings.subagentScale ?? 0.80);
  subScaleRef.current = settings.subagentScale ?? 0.80;
  const rafIdRef = useRef(0);
  const resumeLoopRef = useRef<(() => void) | null>(null);
  const syncAnchorsRef = useRef<(() => void) | null>(null);

  const mainFigureMetaRef = useRef<{
    packId: string;
    type: 'whale' | 'sprite';
    scheme: string;
    outfit: string;
    packSig: string;
  }>({ packId: 'hachimi', type: 'whale', scheme: 'astral-maid', outfit: 'maid', packSig: '' });
  const swapSeqRef = useRef(0);
  const inFlightTargetKeyRef = useRef('');
  const lastDiagReportRef = useRef(0);

  // Subagents controllers, fade-out exit queue, and anchor positions
  const subCtlsRef = useRef<
    Map<string, { ctl: any; figure: any; item: SubagentItem; lastStatus?: string; lastText?: string }>
  >(new Map());
  const mountedRef = useRef(false);
  const spawningIdsRef = useRef<Set<string>>(new Set());
  const spawnTimersRef = useRef<Map<string, number>>(new Map());
  const latestSubMapRef = useRef<Map<string, SubagentItem>>(new Map());
  const exitingIdsRef = useRef<Set<string>>(new Set());
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const [renderSubs, setRenderSubs] = useState<Array<SubagentItem & { exiting?: boolean }>>([]);
  const [subAnchors, setSubAnchors] = useState<Record<string, { x: number; y: number }>>({});
  const [kitReady, setKitReady] = useState(false);
  const kitRef = useRef<{ createPet: any; createWhaleFigure: any; createSpriteFigure: any; origin: string } | null>(null);

  const speechStateRef = useRef<{ text: string; idx: number; nextAt: number }>({
    text: '',
    idx: 0,
    nextAt: 0,
  });

  const onAnchorMoveRef = useRef(onAnchorMove);
  onAnchorMoveRef.current = onAnchorMove;
  const onDiagRef = useRef(onDiag);
  onDiagRef.current = onDiag;

  useImperativeHandle(ref, () => ({
    triggerReaction(ev: PetReactionEvent) {
      const ctl = ctlRef.current;
      if (!ctl) return;
      if (hiddenRef.current) {
        if (typeof ev.thinking === 'boolean') {
          ctl.setThinking(ev.thinking);
        }
        return;
      }
      const isQuiet = (settingsRef.current.temperament || 'daily') === 'quiet';
      const isPassiveWorkExpr =
        !ev.interactive &&
        !ev.motion &&
        !ev.speech &&
        (ev.expression === 'determined' || ev.expression === 'thinking');
      const isAmbientMotion =
        ev.motion === 'hop' || ev.motion === 'jump' || ev.motion === 'nod' || ev.motion === 'look';
      const isPulseMotion =
        ev.motion === 'nod' || ev.motion === 'shake' || ev.motion === 'shiver' || ev.motion === 'wave';

      if (!isPassiveWorkExpr) {
        ctl.holdRoam(!ev.interactive && !ev.speech && isAmbientMotion ? 3.2 : 7);
      }
      if (typeof ev.thinking === 'boolean') {
        ctl.setThinking(ev.thinking);
      }

      const shouldRunMotion = Boolean(ev.motion) && !(isQuiet && !ev.interactive && isAmbientMotion);
      if (shouldRunMotion && isPulseMotion) {
        ctl.doWord(ev.motion!);
        if (ev.expression) {
          ctl.setExpr(ev.expression, 3.2);
        }
      } else {
        if (ev.expression) {
          if (isPassiveWorkExpr) {
            if (ctl.pet?.mode === 'idle' && ctl.pet?.expr !== ev.expression) {
              ctl.setExpr(ev.expression, 2.0);
            }
          } else {
            ctl.setExpr(ev.expression, 3.2);
          }
        }
        if (shouldRunMotion) {
          ctl.doWord(ev.motion!);
        }
      }

      if (ev.speech) {
        speechStateRef.current = { text: ev.speech, idx: 0, nextAt: 0 };
      }
    },
    resetCornerPosition() {
      const ctl = ctlRef.current;
      if (!ctl || !stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      const stageW = r.width > 0 ? r.width : window.innerWidth || 1280;
      ctl.stopWalk?.();
      ctl.pet.x = Math.max(120, stageW - 145);
      ctl.pet.target = ctl.pet.x;
      ctl.pet.facing = -1;
      ctl.pet.faceVis = -1;
      ctl.setExpr('happy', 1.5);
      ctl.doWord('wave');
      lastDiagReportRef.current = 0;
    },
    doWord(word: string) {
      const ctl = ctlRef.current;
      if (!ctl) return;
      ctl.holdRoam(5);
      ctl.doWord(word);
    },
  }));

  // Mount Coopanion Whale figure + physics kit once
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let unlockAudio: (() => void) | null = null;

    async function boot() {
      const stage = stageRef.current;
      const shadowEl = shadowRef.current;
      const petG = petGRef.current;
      const fxG = fxGRef.current;
      if (!stage || !shadowEl || !petG || !fxG) return;

      const origin = window.location.origin;
      const [{ createPet }, { createSfx }, { createWhaleFigure }, { createSpriteFigure }] = await Promise.all([
        dynamicImport(`${origin}/coopanion/kit/body.js`),
        dynamicImport(`${origin}/coopanion/sound.js`),
        dynamicImport(`${origin}/coopanion/whale/figure.js`),
        dynamicImport(`${origin}/coopanion/sprite-pack/figure.js`),
      ]);
      if (cancelled) return;

      kitRef.current = { createPet, createWhaleFigure, createSpriteFigure, origin };

      const sfx = createSfx({ storageKey: 'agy-whale-pet.sound', volume: 0.45 });
      sfx.set(settingsRef.current.soundOn);
      sfxRef.current = sfx;

      unlockAudio = () => sfx.unlock();
      window.addEventListener('pointerdown', unlockAudio, { capture: true });
      window.addEventListener('keydown', unlockAudio, { capture: true });

      const initPack =
        packsRef.current?.find((p) => p.id === settingsRef.current.packId) ||
        activePackRef.current ||
        null;
      const initType: 'whale' | 'sprite' = initPack?.type === 'sprite' ? 'sprite' : 'whale';
      let figure: any;

      if (initType === 'sprite' && initPack) {
        figure = await createSpriteFigure({
          base: origin,
          pack: initPack,
          scheme: settingsRef.current.scheme,
        });
        mainFigureMetaRef.current = {
          packId: initPack.id,
          type: 'sprite',
          scheme: figure.scheme,
          outfit: settingsRef.current.outfit,
          packSig: packSignature(initPack),
        };
      } else {
        const initialCombo = resolveCatgirlCombo(settingsRef.current.scheme);
        figure = await createWhaleFigure(new URL('/coopanion/whale/', origin), {
          scheme: initialCombo,
        });
        mainFigureMetaRef.current = {
          packId: 'hachimi',
          type: 'whale',
          scheme: figure.scheme,
          outfit: settingsRef.current.outfit,
          packSig: packSignature(initPack),
        };
      }

      if (cancelled) {
        figure.dispose?.();
        return;
      }
      figRef.current = figure;

      const rect0 = stage.getBoundingClientRect();
      const stageW0 = rect0.width > 0 ? rect0.width : window.innerWidth || 1280;
      const startX = Math.max(160, stageW0 - 155);

      const ctl = createPet(
        { petG, shadowEl, fxG },
        {
          sfx,
          figure,
          roam: settingsRef.current.roam,
          temperament: settingsRef.current.temperament || 'daily',
          personaSeed: 17,
          enter: 'drop',
          startX,
          bounds: () => {
            const r = stage.getBoundingClientRect();
            const w = r.width > 0 ? r.width : window.innerWidth || 1280;
            const h = r.height > 0 ? r.height : window.innerHeight || 720;
            return {
              W: w,
              H: h,
              floorY: h - 14,
              S: 0.54 * (scaleRef.current || 0.85),
            };
          },
        }
      );
      ctl.pet.x = startX;
      ctl.pet.facing = -1;
      ctl.pet.faceVis = -1;
      ctl.setRoam(settingsRef.current.roam);
      ctl.setTemperament?.(settingsRef.current.temperament || 'daily');
      ctl.setStatus?.(statusRef.current || null);
      sfx.set(settingsRef.current.soundOn);
      ctlRef.current = ctl;
      setKitReady(true);

      let last = performance.now();
      let lastAnchorReport = 0;
      let lastSubAnchorReport = 0;
      lastDiagReportRef.current = 0;
      let lastDiagMeta = { packId: '', scheme: '', subCount: -1 };
      let prevAnchor = { x: -1, y: -1, sideX: -1, sideY: -1 };
      let prevSubKeys = '';
      let prevSubPos: Record<string, { x: number; y: number }> = {};

      const syncAnchorsNow = () => {
        if (cancelled || hiddenRef.current) return;
        const mainCtl = ctlRef.current;
        if (mainCtl) {
          const a = mainCtl.anchor();
          const lay = mainCtl.layout();
          const ax = Math.round(a.x);
          const ay = Math.round(a.y);
          const sx = Math.round(lay.side.x);
          const sy = Math.round(lay.side.y);
          prevAnchor = { x: ax, y: ay, sideX: sx, sideY: sy };
          onAnchorMoveRef.current?.({ x: ax, y: ay, sideX: sx, sideY: sy });
        }
        if (subCtlsRef.current.size > 0) {
          let nextKeys = '';
          const nextPositions: Record<string, { x: number; y: number }> = {};
          for (const [id, entry] of subCtlsRef.current.entries()) {
            const anc = entry.ctl.anchor();
            nextPositions[id] = { x: Math.round(anc.x), y: Math.round(anc.y) };
            nextKeys += `${id}|`;
          }
          prevSubKeys = nextKeys;
          prevSubPos = nextPositions;
          setSubAnchors(nextPositions);
        }
      };
      syncAnchorsRef.current = syncAnchorsNow;

      ro = new ResizeObserver(() => {
        ctl.resize();
        if (!hiddenRef.current) ctl.render();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.resize();
          if (!hiddenRef.current) entry.ctl?.render();
        }
        syncAnchorsNow();
      });
      ro.observe(stage);

      const loop = (now: number) => {
        if (cancelled) return;
        if (hiddenRef.current) {
          rafIdRef.current = 0;
          return;
        }
        const elapsedMs = now - last;

        // Adaptive frame pacing:
        // - Active movement / drag / jump / talk / subagent sky-drop -> smooth ~50fps (min 18ms)
        // - Gentle idle / sleep breathing -> power-saving ~24fps (40ms) to cut GPU/CPU by >55%
        const mainMode = ctl.pet?.mode;
        const isMainActive =
          mainMode === 'walk' ||
          mainMode === 'run' ||
          mainMode === 'air' ||
          mainMode === 'drag' ||
          mainMode === 'crouch' ||
          mainMode === 'dance' ||
          ctl.pet?.pulse ||
          Boolean(speechStateRef.current.text);
        let hasActiveSub = false;
        for (const ent of subCtlsRef.current.values()) {
          const sm = ent.ctl.pet?.mode;
          if (sm === 'air' || sm === 'drag' || sm === 'crouch' || ent.ctl.pet?.pulse) {
            hasActiveSub = true;
            break;
          }
        }
        const minFrameMs = isMainActive || hasActiveSub ? 18 : 40;
        if (elapsedMs < minFrameMs) {
          rafIdRef.current = requestAnimationFrame(loop);
          return;
        }

        const dt = Math.min(0.05, elapsedMs / 1000);
        last = now;

        // Drive mouth lip-sync while speech text types out for main pet
        const sp = speechStateRef.current;
        if (sp.text && now >= sp.nextAt) {
          if (sp.idx < sp.text.length) {
            const ch = sp.text[sp.idx++];
            ctl.talk();
            sfx.babble(ch);
            sp.nextAt = now + 62;
          } else {
            sp.text = '';
          }
        }

        ctl.step(dt);
        ctl.render();

        // Step and render subagent pets (syncing native sleep / wake poses seamlessly!)
        let nextSubKeys = '';
        let subMoved = false;
        const nextSubAnchors: Record<string, { x: number; y: number }> = {};
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (!exitingIdsRef.current.has(id)) {
            const pMode = entry.ctl.pet?.mode;
            const isBusyAir = pMode === 'air' || pMode === 'drag' || pMode === 'crouch';
            if (entry.item.status === 'WAITING') {
              if (!isBusyAir && pMode !== 'sleep') {
                entry.ctl.setThinking?.(false);
                entry.ctl.doWord?.('sleep');
              }
            } else if (pMode === 'sleep' || pMode === 'sit') {
              entry.ctl.doWord?.('stand');
            }
          }
          entry.ctl.step(dt);
          entry.ctl.render();
          const anc = entry.ctl.anchor();
          const ax = Math.round(anc.x);
          const ay = Math.round(anc.y);
          nextSubAnchors[id] = { x: ax, y: ay };
          nextSubKeys += `${id}|`;
          const prevP = prevSubPos[id];
          if (!prevP || Math.abs(ax - prevP.x) >= 1 || Math.abs(ay - prevP.y) >= 1) {
            subMoved = true;
          }
        }

        if ((subMoved || nextSubKeys !== prevSubKeys) && now - lastSubAnchorReport > 36) {
          lastSubAnchorReport = now;
          prevSubKeys = nextSubKeys;
          prevSubPos = nextSubAnchors;
          setSubAnchors(nextSubAnchors);
        }

        const curScheme = figRef.current?.scheme || settingsRef.current.scheme;
        const curPackId = settingsRef.current.packId || 'hachimi';
        const curSubCount = subCtlsRef.current.size;
        const diagChanged =
          curScheme !== lastDiagMeta.scheme ||
          curPackId !== lastDiagMeta.packId ||
          curSubCount !== lastDiagMeta.subCount;

        if (
          ctl.pet.mode !== 'air' &&
          (lastDiagReportRef.current === 0 || diagChanged || now - lastDiagReportRef.current > 2000)
        ) {
          lastDiagReportRef.current = now;
          lastDiagMeta = { packId: curPackId, scheme: curScheme, subCount: curSubCount };
          const cv = petG.querySelector('canvas');
          const svgImg = petG.querySelector('image');
          const lay = ctl.layout();
          const hitSummary = collectInteractiveRects();
          onDiagRef.current?.({
            loaded: true,
            hidden: false,
            packId: curPackId,
            scheme: curScheme,
            temperament: settingsRef.current.temperament || 'daily',
            mainScale: scaleRef.current,
            subagentScale: subScaleRef.current,
            mode: ctl.pet.mode,
            x: Math.round(ctl.pet.x),
            fy: Math.round(ctl.pet.fy),
            box: lay.box,
            bubbleAnchor: {
              x: Math.round(lay.bubble.x),
              y: Math.round(lay.bubble.y),
            },
            canvasW: cv?.width ?? (svgImg ? 256 : 0),
            canvasH: cv?.height ?? (svgImg ? 256 : 0),
            subagentCount: curSubCount,
            subagentBoxes: Array.from(subCtlsRef.current.entries()).map(([sid, ent]) => {
              const subLay = ent.ctl.layout();
              return {
                id: sid,
                scheme: ent.item.scheme,
                box: subLay.box,
                bubbleAnchor: {
                  x: Math.round(subLay.bubble.x),
                  y: Math.round(subLay.bubble.y),
                },
              };
            }),
            interactiveRects: hitSummary.validRects,
            skippedOversizedRects: hitSummary.skippedOversized,
          });
        }

        if (now - lastAnchorReport > 36) {
          lastAnchorReport = now;
          const a = ctl.anchor();
          const lay = ctl.layout();
          const ax = Math.round(a.x);
          const ay = Math.round(a.y);
          const sx = Math.round(lay.side.x);
          const sy = Math.round(lay.side.y);
          if (
            Math.abs(ax - prevAnchor.x) >= 1 ||
            Math.abs(ay - prevAnchor.y) >= 1 ||
            Math.abs(sx - prevAnchor.sideX) >= 1 ||
            Math.abs(sy - prevAnchor.sideY) >= 1
          ) {
            prevAnchor = { x: ax, y: ay, sideX: sx, sideY: sy };
            onAnchorMoveRef.current?.({ x: ax, y: ay, sideX: sx, sideY: sy });
          }
        }

        rafIdRef.current = requestAnimationFrame(loop);
      };

      const scheduleLoop = () => {
        if (cancelled || hiddenRef.current || rafIdRef.current) return;
        last = performance.now();
        rafIdRef.current = requestAnimationFrame(loop);
      };
      resumeLoopRef.current = scheduleLoop;
      if (!hiddenRef.current) {
        ctl.render();
        syncAnchorsNow();
        rafIdRef.current = requestAnimationFrame(loop);
      } else {
        onDiagRef.current?.({
          loaded: true,
          hidden: true,
          packId: settingsRef.current.packId || 'hachimi',
          scheme: figRef.current?.scheme || settingsRef.current.scheme,
          temperament: settingsRef.current.temperament || 'daily',
          mainScale: scaleRef.current,
          subagentScale: subScaleRef.current,
          subagentCount: subCtlsRef.current.size,
          interactiveRects: [],
          skippedOversizedRects: 0,
        });
      }
    }

    boot().catch((err) => {
      console.error('[WhaleStage] Failed to boot Coopanion Whale:', err);
      onDiagRef.current?.({ loaded: false, error: String(err?.stack || err?.message || err) });
    });

    return () => {
      mountedRef.current = false;
      cancelled = true;
      if (unlockAudio) {
        window.removeEventListener('pointerdown', unlockAudio, { capture: true });
        window.removeEventListener('keydown', unlockAudio, { capture: true });
        unlockAudio = null;
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      resumeLoopRef.current = null;
      syncAnchorsRef.current = null;
      ro?.disconnect();
      figRef.current?.dispose?.();
      ctlRef.current = null;
      inFlightTargetKeyRef.current = '';
      for (const t of spawnTimersRef.current.values()) {
        window.clearTimeout(t);
      }
      spawnTimersRef.current.clear();
      for (const t of exitTimersRef.current.values()) {
        window.clearTimeout(t);
      }
      exitTimersRef.current.clear();
      exitingIdsRef.current.clear();
      for (const entry of subCtlsRef.current.values()) {
        entry.figure?.dispose?.();
      }
      subCtlsRef.current.clear();
      spawningIdsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync subagents spawn, live status expressions & smooth fade-out removal
  useEffect(() => {
    const kit = kitRef.current;
    const stage = stageRef.current;
    const currentMap = subCtlsRef.current;
    const activeMap = new Map(subagents.map((s) => [s.id, s]));
    latestSubMapRef.current = activeMap;

    for (const [sid, tid] of spawnTimersRef.current.entries()) {
      if (!activeMap.has(sid)) {
        window.clearTimeout(tid);
        spawnTimersRef.current.delete(sid);
        spawningIdsRef.current.delete(sid);
      }
    }

    // Update renderSubs: keep active subagents, and transition newly removed ones into 480ms smooth fade-out!
    setRenderSubs((prev) => {
      const next: Array<SubagentItem & { exiting?: boolean }> = [];
      const seen = new Set<string>();

      for (const s of subagents) {
        seen.add(s.id);
        const existingTimer = exitTimersRef.current.get(s.id);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
          exitTimersRef.current.delete(s.id);
        }
        exitingIdsRef.current.delete(s.id);
        next.push({ ...s, exiting: false });
      }

      for (const oldItem of prev) {
        if (seen.has(oldItem.id)) continue;
        exitingIdsRef.current.add(oldItem.id);
        spawningIdsRef.current.delete(oldItem.id);

        if (!exitTimersRef.current.has(oldItem.id)) {
          const entry = currentMap.get(oldItem.id);
          entry?.ctl?.setThinking?.(false);
          entry?.ctl?.setExpr?.('happy', 1.2);

          const tid = window.setTimeout(() => {
            exitTimersRef.current.delete(oldItem.id);
            exitingIdsRef.current.delete(oldItem.id);
            const ent = subCtlsRef.current.get(oldItem.id);
            ent?.figure?.dispose?.();
            subCtlsRef.current.delete(oldItem.id);
            lastDiagReportRef.current = 0;
            setSubAnchors((cur) => {
              if (!(oldItem.id in cur)) return cur;
              const copy = { ...cur };
              delete copy[oldItem.id];
              return copy;
            });
            setRenderSubs((cur) => cur.filter((x) => x.id !== oldItem.id));
          }, 480);
          exitTimersRef.current.set(oldItem.id, tid);
        }

        next.push({ ...oldItem, exiting: true });
      }

      return next;
    });

    if (!kit || !stage) return;

    // Spawn new subagents or sync live status/progress animations
    subagents.forEach((sub, index) => {
      if (currentMap.has(sub.id)) {
        const entry = currentMap.get(sub.id)!;
        entry.item = sub;
        const statusChanged = entry.lastStatus !== sub.status;
        const textChanged = entry.lastText !== sub.progressText;
        if (statusChanged || textChanged) {
          entry.ctl?.setWorkHint?.(inferSubagentWorkHint(sub));
        }
        if (statusChanged) {
          entry.lastStatus = sub.status;
          entry.lastText = sub.progressText;
          entry.ctl?.setStatus?.(sub.status || null);
          if (sub.status === 'DONE') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.doWord?.('wave');
          } else if (sub.status === 'THINKING') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(true);
            entry.ctl?.setExpr?.('thinking', 2.5);
          } else if (sub.status === 'WAITING') {
            entry.ctl?.setThinking?.(false);
            entry.ctl?.doWord?.('sleep');
          } else if (sub.status === 'ERROR') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.doWord?.('shiver');
            entry.ctl?.setExpr?.('flustered', 3.0);
          } else if (sub.status === 'WORKING') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.setExpr?.('determined', 2.5);
          }
        } else if (textChanged) {
          entry.lastText = sub.progressText;
        }
        return;
      }

      if (spawningIdsRef.current.has(sub.id)) return;
      spawningIdsRef.current.add(sub.id);

      // Stagger simultaneous sky-drops slightly (95ms apart) so parallel Swarm/Teamwork waves look super lively!
      const dropDelayMs = 45 + (index % 6) * 95;
      const scheduleSpawn = (attempt: number, delayMs: number) => {
        const tid = window.setTimeout(async () => {
          spawnTimersRef.current.delete(sub.id);
          if (
            !mountedRef.current ||
            !kitRef.current ||
            !stageRef.current ||
            exitingIdsRef.current.has(sub.id) ||
            currentMap.has(sub.id)
          ) {
            spawningIdsRef.current.delete(sub.id);
            return;
          }

          const shadowEl = document.getElementById(`sub-shadow-${sub.id}`) as any;
          const petG = document.getElementById(`sub-pet-${sub.id}`) as any;
          const fxG = document.getElementById(`sub-fx-${sub.id}`) as any;
          if (!shadowEl || !petG || !fxG) {
            // React commit can lag slightly behind `setRenderSubs`; poll briefly before giving up.
            if (attempt < 12) {
              scheduleSpawn(attempt + 1, 50);
              return;
            }
            spawningIdsRef.current.delete(sub.id);
            return;
          }

          try {
            const activeKit = kitRef.current;
            const activeStage = stageRef.current;
            if (!activeKit || !activeStage) return;

            const latestSub = latestSubMapRef.current.get(sub.id) || sub;
            const subPackId = latestSub.packId || settingsRef.current.packId || 'hachimi';
            const subPack =
              packsRef.current?.find((p) => p.id === subPackId) ||
              (activePackRef.current?.id === subPackId ? activePackRef.current : null);
            let figure: any;

            if (subPack?.type === 'sprite') {
              figure = await activeKit.createSpriteFigure({
                base: activeKit.origin,
                pack: subPack,
                scheme: latestSub.scheme,
              });
            } else {
              const combo = resolveCatgirlCombo(latestSub.scheme);
              figure = await activeKit.createWhaleFigure(new URL('/coopanion/whale/', activeKit.origin), {
                scheme: combo,
              });
            }

            if (
              !mountedRef.current ||
              exitingIdsRef.current.has(sub.id) ||
              !latestSubMapRef.current.has(sub.id) ||
              !petG.isConnected
            ) {
              figure.dispose?.();
              return;
            }

            const finalSub = latestSubMapRef.current.get(sub.id) || latestSub;
            const stageW = activeStage.getBoundingClientRect().width || window.innerWidth;
            const laneIdx = typeof finalSub.slotIndex === 'number' ? finalSub.slotIndex : index;
            const startX = computeSubagentLaneX(laneIdx, stageW);

            const subCtl = activeKit.createPet(
              { petG, shadowEl, fxG },
              {
                sfx: sfxRef.current,
                figure,
                roam: 'off',
                temperament: settingsRef.current.temperament || 'daily',
                personaSeed: hashPersonaSeed(`${finalSub.id}:${finalSub.scheme}:${laneIdx}`),
                workHint: inferSubagentWorkHint(finalSub),
                enter: 'drop', // Physical sky-drop with gravity & squash-bounce
                startX,
                bounds: () => {
                  const r = activeStage.getBoundingClientRect();
                  const w = r.width > 0 ? r.width : window.innerWidth || 1280;
                  const h = r.height > 0 ? r.height : window.innerHeight || 720;
                  return {
                    W: w,
                    H: h,
                    floorY: h - 14,
                    S: 0.46 * (subScaleRef.current || 0.80),
                  };
                },
              }
            );
            subCtl.pet.x = startX;
            subCtl.pet.facing = -1;
            subCtl.pet.faceVis = -1;
            subCtl.setStatus?.(finalSub.status || null);
            if (finalSub.status === 'THINKING') {
              subCtl.setThinking?.(true);
            }
            subCtl.setExpr('determined', 2.8);
            currentMap.set(sub.id, {
              ctl: subCtl,
              figure,
              item: finalSub,
              lastStatus: finalSub.status,
              lastText: finalSub.progressText,
            });
            if (!hiddenRef.current) {
              subCtl.render();
              syncAnchorsRef.current?.();
            }
            lastDiagReportRef.current = 0;
          } catch (e) {
            console.error('[WhaleStage] Failed to spawn subagent pet:', e);
          } finally {
            spawningIdsRef.current.delete(sub.id);
          }
        }, delayMs);
        spawnTimersRef.current.set(sub.id, tid);
      };

      scheduleSpawn(0, dropDelayMs);
    });
  }, [subagents, kitReady]);

  // Sync main pet status into kit frame
  useEffect(() => {
    ctlRef.current?.setStatus?.(status || null);
  }, [status]);

  // Hot-swap between Whale Maid and Sprite-Pack figures + sync color scheme/variant live
  useEffect(() => {
    const ctl = ctlRef.current;
    const fig = figRef.current;
    const kit = kitRef.current;
    if (!ctl || !fig || !kit) return;

    const targetPack = packs?.find((p) => p.id === settings.packId) || activePack || null;
    const targetType: 'whale' | 'sprite' = targetPack?.type === 'sprite' ? 'sprite' : 'whale';
    const targetPackId = targetPack?.id || settings.packId || 'hachimi';
    const targetPackSig = packSignature(targetPack);
    const meta = mainFigureMetaRef.current;

    const targetWhaleCombo = targetType === 'whale' ? resolveCatgirlCombo(settings.scheme) : '';
    const targetSpriteVariantId =
      targetType === 'sprite' && targetPack
        ? targetPack.variants?.find((v) => v.id === settings.scheme)?.id ||
          targetPack.variants?.find((v) => v.id === targetPack.defaultVariant)?.id ||
          targetPack.variants?.[0]?.id ||
          settings.scheme
        : '';
    const targetKey = `${targetType}|${targetPackId}|${targetPackSig}|${
      targetType === 'whale' ? targetWhaleCombo : targetSpriteVariantId
    }`;

    if (inFlightTargetKeyRef.current && inFlightTargetKeyRef.current === targetKey) {
      return;
    }
    const isInterruptingInFlight = Boolean(inFlightTargetKeyRef.current);

    const needsTypeSwap = targetType !== meta.type;
    const needsWhaleSchemeSwap =
      !needsTypeSwap && targetType === 'whale' && (fig.scheme !== targetWhaleCombo || isInterruptingInFlight);
    const needsSpritePackSwap =
      !needsTypeSwap &&
      targetType === 'sprite' &&
      Boolean(targetPack) &&
      (targetPackId !== meta.packId || targetPackSig !== meta.packSig || isInterruptingInFlight);
    const needsSpriteSchemeSwap =
      !needsTypeSwap &&
      !needsSpritePackSwap &&
      targetType === 'sprite' &&
      Boolean(targetPack) &&
      fig.scheme !== targetSpriteVariantId;

    if (!needsTypeSwap && !needsWhaleSchemeSwap && !needsSpritePackSwap && !needsSpriteSchemeSwap) {
      return;
    }

    const seq = ++swapSeqRef.current;
    inFlightTargetKeyRef.current = targetKey;

    (async () => {
      try {
        if (needsTypeSwap) {
          const nextFig =
            targetType === 'sprite' && targetPack
              ? await kit.createSpriteFigure({
                  base: kit.origin,
                  pack: targetPack,
                  scheme: settings.scheme,
                })
              : await kit.createWhaleFigure(new URL('/coopanion/whale/', kit.origin), {
                  scheme: targetWhaleCombo,
                });

          if (seq !== swapSeqRef.current || !ctlRef.current) {
            nextFig.dispose?.();
            return;
          }

          ctlRef.current.setFigure(nextFig);
          ctlRef.current.setStatus?.(statusRef.current || null);
          figRef.current = nextFig;
          mainFigureMetaRef.current = {
            packId: targetPackId,
            type: targetType,
            scheme: nextFig.scheme,
            outfit: settings.outfit,
            packSig: targetPackSig,
          };
          ctlRef.current.pet.sqv += 1.1;
          ctlRef.current.setExpr('happy', 1.1);
          if (!hiddenRef.current) {
            ctlRef.current.render?.();
            syncAnchorsRef.current?.();
          }
          lastDiagReportRef.current = 0;
          return;
        }

        if (needsWhaleSchemeSwap) {
          await figRef.current.setScheme(targetWhaleCombo, { fade: 0.42 });
          if (seq !== swapSeqRef.current || !ctlRef.current) return;
          mainFigureMetaRef.current = {
            ...meta,
            packId: targetPackId,
            scheme: targetWhaleCombo,
            packSig: targetPackSig,
          };
          ctlRef.current.pet.sqv += 1.1;
          ctlRef.current.setExpr('happy', 1.1);
          if (!hiddenRef.current) {
            ctlRef.current.render?.();
            syncAnchorsRef.current?.();
          }
          lastDiagReportRef.current = 0;
          return;
        }

        if (targetType === 'sprite' && targetPack) {
          if (needsSpritePackSwap) {
            await figRef.current.setPack(targetPack, settings.scheme);
            if (seq !== swapSeqRef.current || !ctlRef.current) return;
            mainFigureMetaRef.current = {
              ...meta,
              packId: targetPackId,
              scheme: figRef.current.scheme,
              packSig: targetPackSig,
            };
            ctlRef.current.pet.sqv += 1.1;
            ctlRef.current.setExpr('happy', 1.1);
            if (!hiddenRef.current) {
              ctlRef.current.render?.();
              syncAnchorsRef.current?.();
            }
            lastDiagReportRef.current = 0;
          } else if (needsSpriteSchemeSwap) {
            await figRef.current.setScheme(settings.scheme);
            if (seq !== swapSeqRef.current || !ctlRef.current) return;
            mainFigureMetaRef.current = {
              ...meta,
              scheme: figRef.current.scheme,
              packSig: targetPackSig,
            };
            ctlRef.current.pet.sqv += 1.1;
            ctlRef.current.setExpr('happy', 1.1);
            if (!hiddenRef.current) {
              ctlRef.current.render?.();
              syncAnchorsRef.current?.();
            }
            lastDiagReportRef.current = 0;
          }
        }
      } catch (err) {
        console.error('[WhaleStage] Failed to hot-swap figure:', err);
      } finally {
        if (seq === swapSeqRef.current) {
          inFlightTargetKeyRef.current = '';
        }
      }
    })();
  }, [settings.packId, settings.scheme, settings.outfit, activePack, packs, kitReady]);

  // Sync roam, temperament, independent scales, sound, and hidden state
  useEffect(() => {
    ctlRef.current?.setRoam(settings.roam);
  }, [settings.roam]);

  useEffect(() => {
    const nextTemperament = settings.temperament || 'daily';
    ctlRef.current?.setTemperament?.(nextTemperament);
    for (const entry of subCtlsRef.current.values()) {
      entry.ctl?.setTemperament?.(nextTemperament);
    }
  }, [settings.temperament]);

  useEffect(() => {
    ctlRef.current?.resize();
    if (!hiddenRef.current) {
      ctlRef.current?.render?.();
    }
    for (const entry of subCtlsRef.current.values()) {
      entry.ctl?.resize();
      if (!hiddenRef.current) {
        entry.ctl?.render?.();
      }
    }
    syncAnchorsRef.current?.();
    lastDiagReportRef.current = 0;
  }, [settings.mainScale, settings.subagentScale, settings.scale]);

  useEffect(() => {
    lastDiagReportRef.current = 0;
  }, [settings.showSubagentHud]);

  useEffect(() => {
    sfxRef.current?.set(settings.soundOn);
  }, [settings.soundOn]);

  useEffect(() => {
    if (isHidden) {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      window.petHost?.setMouseCapture(false);
      onDiagRef.current?.({
        loaded: Boolean(figRef.current),
        hidden: true,
        packId: settingsRef.current.packId || 'hachimi',
        scheme: figRef.current?.scheme || settingsRef.current.scheme,
        temperament: settingsRef.current.temperament || 'daily',
        mainScale: scaleRef.current,
        subagentScale: subScaleRef.current,
        subagentCount: subCtlsRef.current.size,
        interactiveRects: [],
        skippedOversizedRects: 0,
      });
    } else {
      ctlRef.current?.resize();
      ctlRef.current?.render?.();
      for (const entry of subCtlsRef.current.values()) {
        entry.ctl?.resize();
        entry.ctl?.render?.();
      }
      syncAnchorsRef.current?.();
      lastDiagReportRef.current = 0;
      resumeLoopRef.current?.();
    }
  }, [isHidden, kitReady]);

  // Windows click-through cursor polling hit-test integration (with anti-masking circuit breaker)
  useEffect(() => {
    if (!window.petHost) return;
    return window.petHost.onCursor((pt) => {
      if (hiddenRef.current) {
        window.petHost?.setMouseCapture(false);
        return;
      }
      const ctl = ctlRef.current;
      const stageRect = stageRef.current?.getBoundingClientRect();
      const localPt = stageRect
        ? { ...pt, x: pt.x - stageRect.left, y: pt.y - stageRect.top }
        : pt;
      ctl?.hostCursorMove?.(localPt);

      if (pt.locked || !pt.insideWindow) {
        window.petHost?.setMouseCapture(false);
        return;
      }
      let overWhale = false;
      if (ctl) {
        overWhale = !!(ctl.pressing || ctl.hitPet({ x: localPt.x, y: localPt.y }));
      }
      if (!overWhale) {
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (exitingIdsRef.current.has(id)) continue;
          if (entry.ctl?.pressing || entry.ctl?.hitPet({ x: localPt.x, y: localPt.y })) {
            overWhale = true;
            break;
          }
        }
      }

      let overUI = false;
      if (!overWhale) {
        const vw = window.innerWidth || 1920;
        const vh = window.innerHeight || 1080;
        const nodes = document.querySelectorAll<HTMLElement>('[data-pet-interactive="true"]');
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          // Circuit breaker: ignore any oversized layout layer (>55% screen width & height)
          if (r.width > vw * 0.55 && r.height > vh * 0.55) continue;
          const cs = window.getComputedStyle(el);
          if (
            cs.pointerEvents === 'none' ||
            cs.visibility === 'hidden' ||
            cs.display === 'none' ||
            cs.opacity === '0'
          ) {
            continue;
          }
          if (
            pt.x >= r.left - 6 &&
            pt.x <= r.right + 6 &&
            pt.y >= r.top - 6 &&
            pt.y <= r.bottom + 6
          ) {
            overUI = true;
            break;
          }
        }
      }

      window.petHost?.setMouseCapture(overWhale || overUI);
    });
  }, []);

  const toStagePoint = (e: React.PointerEvent | React.MouseEvent) => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
  };

  const stageWidth = stageRef.current?.clientWidth || window.innerWidth || 1920;
  const hudPositions = resolveHudLayout(renderSubs, subAnchors, stageWidth);

  return (
    <div
      ref={stageRef}
      className="whale-stage"
      style={isHidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      onPointerDown={(e) => {
        if (e.button === 2) {
          const ptR = toStagePoint(e);
          if (ctlRef.current?.hitPet(ptR)) {
            e.preventDefault();
            ctlRef.current?.doWord?.('wave');
            ctlRef.current?.setExpr?.('happy', 1.8);
          }
          return;
        }
        const pt = toStagePoint(e);
        const ctl = ctlRef.current;
        if (ctl?.pointerDown(pt)) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          return;
        }
        // Subagent drag & click interaction (skip fading-out pets)
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (exitingIdsRef.current.has(id)) continue;
          if (entry.ctl?.pointerDown(pt)) {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            entry.ctl.setExpr('wink', 1.6);
            return;
          }
        }
      }}
      onPointerMove={(e) => {
        const pt = toStagePoint(e);
        const ctl = ctlRef.current;
        if (ctl) {
          const cur = ctl.pointerMove(pt);
          if (cur && stageRef.current) {
            stageRef.current.style.cursor = cur;
            return;
          }
        }
        for (const entry of subCtlsRef.current.values()) {
          const cur = entry.ctl?.pointerMove(pt);
          if (cur && stageRef.current) {
            stageRef.current.style.cursor = cur;
            return;
          }
        }
        if (stageRef.current) stageRef.current.style.cursor = '';
      }}
      onPointerUp={() => {
        ctlRef.current?.pointerUp();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.pointerUp();
        }
      }}
      onPointerLeave={() => {
        ctlRef.current?.pointerLeave();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.pointerLeave();
        }
      }}
      onDoubleClick={(e) => {
        const pt = toStagePoint(e);
        if (ctlRef.current?.hitPet(pt)) {
          ctlRef.current.doWord('dance');
          ctlRef.current.setExpr('excited', 2.4);
          return;
        }
        for (const entry of subCtlsRef.current.values()) {
          if (entry.ctl?.hitPet(pt)) {
            entry.ctl.doWord('spin');
            entry.ctl.setExpr('excited', 2);
            return;
          }
        }
      }}
      onContextMenu={(e) => {
        const pt = toStagePoint(e);
        if (ctlRef.current?.hitPet(pt)) {
          e.preventDefault();
          window.petHost?.showContextMenu?.();
        }
      }}
    >
      <svg className="whale-svg" aria-hidden="true" style={isHidden ? { display: 'none' } : undefined}>
        {/* Main Pet Figures */}
        <ellipse ref={shadowRef} className="shadow" cx="0" cy="0" rx="0" ry="0" />
        <g ref={petGRef} />
        <g ref={fxGRef} />

        {/* Dynamic Subagent Pets SVG Containers (with smooth fade-out on removal) */}
        {renderSubs.map((sub) => (
          <g key={sub.id} className={`subagent-svg-group ${sub.exiting ? 'is-exiting' : ''}`}>
            <ellipse id={`sub-shadow-${sub.id}`} className="shadow" cx="0" cy="0" rx="0" ry="0" />
            <g id={`sub-pet-${sub.id}`} />
            <g id={`sub-fx-${sub.id}`} />
          </g>
        ))}
      </svg>

      {/* Dynamic Subagents Overhead HUD Layer — strictly click-through on container, interactive ONLY on active compact pills! */}
      {!isHidden && settings.showSubagentHud !== false && (
        <div className="subagents-hud-layer">
        {renderSubs.map((sub) => {
          const pos = hudPositions[sub.id];
          if (!pos) return null;
          const subPack = packs?.find((p) => p.id === (sub.packId || settings.packId)) || activePack;
          const varColor = subPack?.variants?.find((v) => v.id === sub.scheme)?.color;
          const schemeColor = varColor || SCHEME_COLORS[sub.scheme] || 'var(--accent)';
          const pct = sub.exiting
            ? 100
            : typeof sub.progressPercent === 'number'
            ? Math.min(100, Math.max(8, sub.progressPercent))
            : null;
          const isSleeping = sub.status === 'WAITING';
          const pillBorderColor =
            sub.exiting || sub.status === 'DONE'
              ? 'rgba(52, 211, 153, 0.7)'
              : isSleeping
              ? 'rgba(129, 140, 248, 0.55)'
              : toTranslucentBorderColor(schemeColor);
          const barColor =
            sub.status === 'DONE'
              ? 'var(--emerald)'
              : isSleeping
              ? '#818cf8'
              : schemeColor;
          const cleanName = stripEmojiChars(sub.name, '子代理');
          const cleanRole = stripEmojiChars(sub.role, '协作中');
          const cleanProgress = stripEmojiChars(sub.progressText, '处理中');
          return (
            <div
              key={sub.id}
              className={`subagent-hud-card ${sub.status === 'DONE' ? 'is-done' : ''} ${isSleeping ? 'is-sleeping' : ''} ${sub.exiting ? 'is-exiting' : ''}`}
              style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            >
              <div
                className="subagent-hud-pill"
                data-pet-interactive={sub.exiting ? undefined : 'true'}
                style={{ borderColor: pillBorderColor }}
                onClick={
                  sub.exiting
                    ? undefined
                    : () => {
                        const ent = subCtlsRef.current.get(sub.id);
                        if (ent?.ctl && sub.status !== 'WAITING') {
                          ent.ctl.doWord?.('wave');
                          ent.ctl.setExpr?.('wink', 1.6);
                        }
                      }
                }
                title={`${cleanName} (${cleanRole}) · ${cleanProgress}`}
              >
                <div className="subagent-hud-top">
                  <span
                    className={`subagent-status-indicator ${sub.status.toLowerCase()}`}
                    style={{ backgroundColor: barColor }}
                  />
                  <span className="subagent-name-tag">{cleanName}</span>
                  <span className="subagent-role-tag">{isSleeping ? '休眠' : cleanRole}</span>
                </div>
                <div className="subagent-progress-row">
                  <div className="subagent-progress-meta">
                    <span className="subagent-progress-text">{cleanProgress}</span>
                    {pct !== null && <span className="subagent-pct-label">{pct}%</span>}
                  </div>
                  {pct !== null && (
                    <div className="subagent-bar-bg">
                      <div
                        className="subagent-bar-fill"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
});
