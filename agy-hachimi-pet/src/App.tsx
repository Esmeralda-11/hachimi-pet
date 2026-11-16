import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WhaleStage, type WhaleControllerHandle } from './components/WhaleStage';
import { StatusBubble } from './components/StatusBubble';
import { ApprovalPopover } from './components/ApprovalPopover';
import { useBridgeSocket } from './hooks/useBridgeSocket';
import type { PetReactionEvent } from './types';

export const App: React.FC = () => {
  const whaleRef = useRef<WhaleControllerHandle | null>(null);
  const [speechText, setSpeechText] = useState('');
  const [anchorPos, setAnchorPos] = useState({
    x: window.innerWidth - 150,
    y: window.innerHeight - 235,
    sideX: window.innerWidth - 150,
    sideY: window.innerHeight - 130,
  });

  const handleReaction = useCallback((ev: PetReactionEvent) => {
    whaleRef.current?.triggerReaction(ev);
    if (ev.speech) {
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

  const currentStatus = snapshot.agyRunning
    ? 'THINKING'
    : activeSession?.status || 'IDLE';

  const currentBadge = activeSession?.badge || (connected ? '🐳 已连接 · 待机伴随中' : '🔌 正在连接本地桥接服务…');

  const handlePetCheer = useCallback(() => {
    whaleRef.current?.triggerReaction({ expression: 'happy', motion: 'wave' });
  }, []);

  return (
    <div className="desktop-overlay-root">
      <WhaleStage
        ref={whaleRef}
        settings={snapshot.settings}
        subagents={snapshot.subagents}
        onAnchorMove={setAnchorPos}
        onDiag={reportDiag}
      />

      <StatusBubble
        anchor={{ x: anchorPos.x, y: anchorPos.y }}
        status={currentStatus}
        badge={currentBadge}
        thinkingText={liveThinking || activeSession?.lastThinking || ''}
        speechText={speechText}
        telemetry={activeSession?.telemetry || null}
        onClickBadge={handlePetCheer}
      />

      <ApprovalPopover
        approval={snapshot.pendingApprovals[0] || null}
        onResolve={resolveApproval}
      />
    </div>
  );
};
