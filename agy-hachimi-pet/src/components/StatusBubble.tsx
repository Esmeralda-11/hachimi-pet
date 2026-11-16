import React, { useEffect, useState } from 'react';
import type { PetExecutionStatus, SessionTelemetry } from '../types';

interface StatusBubbleProps {
  anchor: { x: number; y: number };
  status: PetExecutionStatus;
  badge: string;
  thinkingText: string;
  speechText: string;
  telemetry?: SessionTelemetry | null;
  onClickBadge?: () => void;
}

const STATUS_DOT_CLASS: Record<PetExecutionStatus, string> = {
  IDLE: 'dot-idle',
  THINKING: 'dot-thinking',
  READING: 'dot-working',
  CODING: 'dot-working',
  RUNNING_CMD: 'dot-cmd',
  WAITING_USER: 'dot-warn',
  AWAITING_NEXT: 'dot-ready',
  ERROR: 'dot-error',
};

function getContextRingColor(pct: number): string {
  if (pct >= 85) return '#fb7185'; // High / near compaction
  if (pct >= 62) return '#f59e0b'; // Warm amber (matches Antigravity's 70-85% ring)
  return '#34d399';                // Healthy emerald
}

export const StatusBubble: React.FC<StatusBubbleProps> = ({
  anchor,
  status,
  badge,
  thinkingText,
  speechText,
  telemetry,
  onClickBadge,
}) => {
  const [typedSpeech, setTypedSpeech] = useState('');

  useEffect(() => {
    if (!speechText) {
      setTypedSpeech('');
      return;
    }
    let idx = 0;
    setTypedSpeech('');
    const iv = window.setInterval(() => {
      idx++;
      setTypedSpeech(speechText.slice(0, idx));
      if (idx >= speechText.length) {
        clearInterval(iv);
      }
    }, 45);
    const hideTimer = window.setTimeout(() => {
      setTypedSpeech('');
    }, Math.max(4800, speechText.length * 60 + 3000));

    return () => {
      clearInterval(iv);
      clearTimeout(hideTimer);
    };
  }, [speechText]);

  const clampedX = Math.max(160, Math.min(window.innerWidth - 160, anchor.x || window.innerWidth - 150));
  const clampedY = Math.max(56, Math.min(window.innerHeight - 130, (anchor.y || window.innerHeight - 230) - 10));

  const showThinking = (status === 'THINKING' || status === 'READING' || status === 'CODING') && !!thinkingText;

  const hasContext = Boolean(telemetry && telemetry.contextLimit > 0 && (telemetry.contextUsed > 0 || telemetry.compacted));
  const ctxPct = hasContext ? Math.min(100, Math.max(0, telemetry!.contextPercent)) : 0;
  const ctxRingColor = getContextRingColor(ctxPct);
  const radius = 5.8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ctxPct / 100);

  const ctxTooltip = hasContext
    ? `${telemetry!.compacted ? '已压缩 · ' : ''}${telemetry!.contextUsed.toLocaleString('en-US')} / ${telemetry!.contextLimit.toLocaleString('en-US')} (${ctxPct.toFixed(1)}%)`
    : '暂无上下文统计';

  const hasTok = Boolean(telemetry && (telemetry.overallTokPerSec > 0 || telemetry.outputTokens > 0));
  const tokSpeedLabel = hasTok && telemetry!.overallTokPerSec > 0 ? telemetry!.overallTokPerSec.toFixed(1) : '--';
  const tokTooltip = hasTok
    ? [
        `综合 ${telemetry!.overallTokPerSec.toFixed(1)} tok/s`,
        telemetry!.streamTokPerSec > 0 ? `流式 ${telemetry!.streamTokPerSec.toFixed(1)}` : null,
        telemetry!.ttftSec > 0 ? `TTFT ${telemetry!.ttftSec.toFixed(2)}s` : null,
        telemetry!.outputTokens > 0 ? `${telemetry!.outputTokens.toLocaleString('en-US')} tok` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '等待本轮生成统计…';

  return (
    <div
      className="status-bubble-wrap dynamic-head-wrap"
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
    >
      {/* Transient Speech / Live Thinking Island */}
      {typedSpeech ? (
        <div
          className="dynamic-speech-cloud"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className="speech-avatar">🐳</span>
          <span className="speech-text">{typedSpeech}</span>
        </div>
      ) : showThinking ? (
        <div
          className="dynamic-thinking-island"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className="thinking-icon">💭</span>
          <span className="thinking-marquee">{thinkingText}</span>
        </div>
      ) : null}

      {/* Main Agent Status Feedback Pill */}
      <button
        type="button"
        className={`status-pill status-${status.toLowerCase()}`}
        data-pet-interactive="true"
        onClick={onClickBadge}
      >
        <span className={`status-dot ${STATUS_DOT_CLASS[status]}`} />
        <span className="status-badge-text">{badge || '待机伴随中～'}</span>
      </button>

      {/* Antigravity Native-Style Context Window & Token Throughput Telemetry Bar */}
      {(hasContext || hasTok) && (
        <div className="telemetry-bar">
          {hasContext && (
            <div className="telemetry-chip context-chip" data-pet-interactive="true">
              <svg className="ctx-ring-svg" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <circle
                  className="ctx-ring-track"
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  strokeWidth="2.1"
                />
                <circle
                  className="ctx-ring-fill"
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke={ctxRingColor}
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 8 8)"
                />
              </svg>
              <span className="ctx-pct-text" style={{ color: ctxPct >= 85 ? '#fda4af' : '#d5dff7' }}>
                {ctxPct.toFixed(1)}%
              </span>
              <div className="telemetry-tooltip">{ctxTooltip}</div>
            </div>
          )}

          {hasTok && (
            <div className="telemetry-chip tok-chip" data-pet-interactive="true">
              <span className="tok-val">{tokSpeedLabel}</span>
              <span className="tok-unit">tok/s</span>
              <div className="telemetry-tooltip">{tokTooltip}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
