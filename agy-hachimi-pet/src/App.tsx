import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WhaleStage, type WhaleControllerHandle } from './components/WhaleStage';
import { StatusBubble } from './components/StatusBubble';
import { ApprovalPopover } from './components/ApprovalPopover';
import { useBridgeSocket } from './hooks/useBridgeSocket';
import type { PetExecutionStatus, PetPalette, PetReactionEvent, PetTemperament, PetThemeMode } from './types';

function isUrgentSpeechReaction(
  ev: PetReactionEvent,
  status: PetExecutionStatus,
  hasPendingApproval: boolean
): boolean {
  if (status === 'ERROR' || status === 'WAITING_USER' || hasPendingApproval) {
    return true;
  }
  if (
    ev.expression === 'cry' ||
    ev.expression === 'flustered' ||
    ev.expression === 'confused' ||
    ev.expression === 'scared'
  ) {
    return true;
  }
  if (ev.badge && /(报错|错误|异常|中断|提问|审批|等待)/.test(ev.badge)) {
    return true;
  }
  if (ev.speech && /(报错|错误|出错|异常|提问|选择题|审批|允许或拦截)/.test(ev.speech)) {
    return true;
  }
  return false;
}

export const App: React.FC = () => {
  const whaleRef = useRef<WhaleControllerHandle | null>(null);
  const [speechText, setSpeechText] = useState('');
  const [anchorPos, setAnchorPos] = useState({
    x: window.innerWidth - 150,
    y: window.innerHeight - 235,
    sideX: window.innerWidth - 150,
    sideY: window.innerHeight - 130,
  });

  const temperamentRef = useRef<PetTemperament>('daily');
  const statusRef = useRef<PetExecutionStatus>('IDLE');
  const pendingApprovalRef = useRef(false);
  const petHiddenRef = useRef(false);

  const handleReaction = useCallback((ev: PetReactionEvent) => {
    const allowSpeech =
      temperamentRef.current !== 'quiet' ||
      isUrgentSpeechReaction(ev, statusRef.current, pendingApprovalRef.current);
    const effectiveEv = allowSpeech ? ev : { ...ev, speech: undefined };

    if (!petHiddenRef.current) {
      whaleRef.current?.triggerReaction(effectiveEv);
    }
    if (allowSpeech && ev.speech) {
      setSpeechText(ev.speech);
    }
  }, []);

  const handleHostCommand = useCallback((cmd: { type: string }) => {
    if (cmd?.type === 'resetPosition') {
      whaleRef.current?.resetCornerPosition();
    }
  }, []);

  const {
    connected,
    snapshot,
    liveThinking,
    resolveApproval,
    reportDiag,
  } = useBridgeSocket(handleReaction, handleHostCommand);

  // Listen for native host commands (Electron IPC / WebView2 WebMessage)
  useEffect(() => {
    if (!window.petHost) return;
    return window.petHost.onCommand(handleHostCommand);
  }, [handleHostCommand]);

  const activeSession =
    snapshot.sessions.find((s) => s.conversationId === snapshot.activeConversationId) || snapshot.sessions[0];

  const currentStatus: PetExecutionStatus = snapshot.agyRunning
    ? 'THINKING'
    : activeSession?.status || 'IDLE';

  const settings = snapshot.settings;
  const petHidden = Boolean(settings.petHidden);
  const temperament: PetTemperament = settings.temperament || 'daily';
  const themeMode: PetThemeMode = settings.theme || 'system';
  const palette: PetPalette = settings.palette || 'forest';

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  temperamentRef.current = temperament;
  statusRef.current = currentStatus;
  pendingApprovalRef.current = snapshot.pendingApprovals.length > 0;
  petHiddenRef.current = petHidden;

  useEffect(() => {
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const applyTheme = () => {
      const resolved: 'light' | 'dark' =
        themeMode === 'light' || themeMode === 'dark'
          ? themeMode
          : mq?.matches
            ? 'dark'
            : 'light';
      document.documentElement.dataset.theme = resolved;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
      if (meta) {
        meta.content = themeMode === 'system' ? 'light dark' : resolved;
      }
    };
    applyTheme();
    if (themeMode !== 'system' || !mq) return;
    const onChange = () => applyTheme();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener?.(onChange);
    return () => mq.removeListener?.(onChange);
  }, [themeMode]);

  useEffect(() => {
    if (petHidden) {
      window.petHost?.setMouseCapture(false);
      setSpeechText('');
    }
  }, [petHidden]);

  useEffect(() => {
    if (
      temperament === 'quiet' &&
      currentStatus !== 'ERROR' &&
      currentStatus !== 'WAITING_USER' &&
      snapshot.pendingApprovals.length === 0
    ) {
      setSpeechText('');
    }
  }, [temperament, currentStatus, snapshot.pendingApprovals.length]);

  const activePackObj =
    snapshot.packs?.find((p) => p.id === settings.packId) || snapshot.activePack || null;
  const activeVariantObj =
    activePackObj?.variants?.find((v) => v.id === settings.scheme) ||
    activePackObj?.variants?.find((v) => v.id === activePackObj.defaultVariant) ||
    activePackObj?.variants?.[0] ||
    null;
  const rawThumbUrl = activeVariantObj?.thumbUrl || '';
  const avatarUrl =
    rawThumbUrl && rawThumbUrl.startsWith('/local-packs/') && window.location.port === '5179'
      ? `http://127.0.0.1:${window.petHost?.bridgePort || 17890}${rawThumbUrl}`
      : rawThumbUrl;

  const currentBadge = activeSession?.badge || (connected ? '已连接 · 待机' : '正在连接服务…');

  const handlePetCheer = useCallback(() => {
    whaleRef.current?.triggerReaction({ expression: 'happy', motion: 'wave', interactive: true });
  }, []);

  return (
    <div className="desktop-overlay-root">
      <WhaleStage
        ref={whaleRef}
        settings={settings}
        packs={snapshot.packs}
        activePack={snapshot.activePack}
        status={currentStatus}
        subagents={snapshot.subagents}
        hidden={petHidden}
        onAnchorMove={setAnchorPos}
        onDiag={reportDiag}
      />

      {!petHidden && (
        <StatusBubble
          anchor={{ x: anchorPos.x, y: anchorPos.y }}
          status={currentStatus}
          badge={currentBadge}
          avatarUrl={avatarUrl}
          thinkingText={liveThinking || activeSession?.lastThinking || ''}
          speechText={speechText}
          telemetry={activeSession?.telemetry || null}
          temperament={temperament}
          showSpeechBubble={settings.showSpeechBubble ?? true}
          showStatusPill={settings.showStatusPill ?? true}
          showTelemetryBar={settings.showTelemetryBar ?? true}
          onClickBadge={handlePetCheer}
        />
      )}

      {!petHidden && (
        <ApprovalPopover
          approval={snapshot.pendingApprovals[0] || null}
          onResolve={resolveApproval}
        />
      )}
    </div>
  );
};
