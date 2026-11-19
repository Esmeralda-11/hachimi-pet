import React, { useEffect, useState } from 'react';
import { Sparkles, MessageSquare } from 'lucide-react';
import type { PetExecutionStatus, PetTemperament, SessionTelemetry } from '../types';

interface StatusBubbleProps {
  anchor: { x: number; y: number };
  status: PetExecutionStatus;
  badge: string;
  avatarUrl?: string;
  thinkingText: string;
  speechText: string;
  telemetry?: SessionTelemetry | null;
  temperament?: PetTemperament;
  showSpeechBubble?: boolean;
  showStatusPill?: boolean;
  showTelemetryBar?: boolean;
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

const EMOJI_CHAR_RE =
  /(?:[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic}|[\u2600-\u27BF]|[\u200D\uFE0E\uFE0F\u20E3])+/gu;
const LEADING_EMOJI_RE =
  /^(?:[\s\u200D\uFE0E\uFE0F\u20E3]+|[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic}|[\u2600-\u27BF])+/u;

export function stripEmojiChars(raw: string, fallback = ''): string {
  const cleaned = String(raw || '').replace(EMOJI_CHAR_RE, '').replace(/\s{2,}/g, ' ').trim();
  return cleaned || fallback;
}

function stripLeadingEmoji(raw: string): string {
  return String(raw || '').replace(LEADING_EMOJI_RE, '').trim();
}

function getContextRingColor(pct: number): string {
  if (pct >= 85) return 'var(--rose)';
  if (pct >= 62) return 'var(--amber)';
  return 'var(--emerald)';
}

export const StatusBubble: React.FC<StatusBubbleProps> = ({
  anchor,
  status,
  badge,
  avatarUrl,
  thinkingText,
  speechText,
  telemetry,
  temperament = 'daily',
  showSpeechBubble = true,
  showStatusPill = true,
  showTelemetryBar = true,
  onClickBadge,
}) => {
  const [typedSpeech, setTypedSpeech] = useState('');
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [avatarUrl]);

  const cleanSpeech = stripLeadingEmoji(speechText);
  const allowSpeechInMood =
    temperament !== 'quiet' ||
    status === 'ERROR' ||
    status === 'WAITING_USER' ||
    Boolean(cleanSpeech && /(报错|错误|出错|异常|提问|选择题|审批|允许或拦截)/.test(cleanSpeech));
  const effectiveSpeechText = showSpeechBubble && allowSpeechInMood ? cleanSpeech : '';

  useEffect(() => {
    if (!effectiveSpeechText) {
      setTypedSpeech('');
      return;
    }
    let idx = 0;
    setTypedSpeech('');
    const iv = window.setInterval(() => {
      idx++;
      setTypedSpeech(effectiveSpeechText.slice(0, idx));
      if (idx >= effectiveSpeechText.length) {
        clearInterval(iv);
      }
    }, 45);
    const hideTimer = window.setTimeout(() => {
      setTypedSpeech('');
    }, Math.max(4800, effectiveSpeechText.length * 60 + 3000));

    return () => {
      clearInterval(iv);
      clearTimeout(hideTimer);
    };
  }, [effectiveSpeechText]);

  if (!showSpeechBubble && !showStatusPill && !showTelemetryBar) {
    return null;
  }

  const GAP_PX = 6;
  const anchorX = Number.isFinite(anchor.x) ? anchor.x : window.innerWidth - 150;
  const anchorY = Number.isFinite(anchor.y) ? anchor.y : window.innerHeight - 230;
  const clampedX = Math.max(160, Math.min(window.innerWidth - 160, anchorX));
  const clampedY = Math.max(40, Math.min(window.innerHeight - 16, anchorY - GAP_PX));

  const cleanBadge = stripEmojiChars(badge, '待机');
  const cleanThinking = stripLeadingEmoji(thinkingText);
  const showThinking =
    showSpeechBubble &&
    (status === 'THINKING' || status === 'READING' || status === 'CODING') &&
    Boolean(cleanThinking);

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
      {showSpeechBubble && (typedSpeech ? (
        <div
          className="dynamic-speech-cloud"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          {avatarUrl && !avatarError ? (
            <img
              className="speech-avatar-img"
              src={avatarUrl}
              alt=""
              width={16}
              height={16}
              onError={() => setAvatarError(true)}
            />
          ) : (
            <span className="speech-avatar-icon" aria-hidden="true">
              <Sparkles size={13} />
            </span>
          )}
          <span className="speech-text">{typedSpeech}</span>
        </div>
      ) : showThinking ? (
        <div
          className="dynamic-thinking-island"
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className="thinking-icon" aria-hidden="true">
            <MessageSquare size={12} />
          </span>
          <span className="thinking-marquee">{cleanThinking}</span>
        </div>
      ) : null)}

      {/* Main Agent Status Feedback Pill */}
      {showStatusPill && (
        <button
          type="button"
          className={`status-pill status-${status.toLowerCase()}`}
          data-pet-interactive="true"
          onClick={onClickBadge}
        >
          <span className={`status-dot ${STATUS_DOT_CLASS[status]}`} />
          <span className="status-badge-text">{cleanBadge}</span>
        </button>
      )}

      {/* Antigravity Native-Style Context Window & Token Throughput Telemetry Bar */}
      {showTelemetryBar && (hasContext || hasTok) && (
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
              <span className={`ctx-pct-text${ctxPct >= 85 ? ' is-critical' : ''}`}>
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
