export type PetExecutionStatus =
  | 'IDLE'
  | 'THINKING'
  | 'READING'
  | 'CODING'
  | 'RUNNING_CMD'
  | 'WAITING_USER'
  | 'AWAITING_NEXT'
  | 'ERROR';

export interface PetVariantInfo {
  id: string;
  name: string;
  label?: string;
  color?: string;
  thumb?: string;
  thumbUrl?: string;
  asset?: string;
  assetUrl?: string;
  layout?: 'whale' | 'compact-4x3' | 'single-image' | 'codex-v2-8x11';
  frameWidth?: number;
  frameHeight?: number;
  cols?: number;
  rows?: number;
  asymmetric?: boolean;
}

export interface PetPackSummary {
  id: string;
  name: string;
  slotLabel: string;
  badgeEmoji: string;
  type: 'whale' | 'sprite';
  defaultVariant: string;
  isBuiltin?: boolean;
  variants: PetVariantInfo[];
}

export type PetTemperament = 'lively' | 'daily' | 'quiet';
export type PetThemeMode = 'system' | 'light' | 'dark';
export type PetPalette = 'forest' | 'ocean' | 'plum' | 'amber' | 'graphite';

export interface PetSettings {
  mode: 'companion' | 'standalone';
  packId?: string;
  scheme: string;
  outfit: string;
  autoSchemeByModel: boolean;
  roam: 'free' | 'off';
  temperament: PetTemperament;
  theme?: PetThemeMode;
  palette?: PetPalette;
  mainScale: number;
  subagentScale: number;
  scale: number;
  petHidden: boolean;
  trayHidden?: boolean;
  showSpeechBubble: boolean;
  showStatusPill: boolean;
  showTelemetryBar: boolean;
  showSubagentHud: boolean;
  soundOn: boolean;
  safetyGateEnabled: boolean;
  interceptRiskyOnly: boolean;
  interceptAllCommands: boolean;
  defaultWorkspace: string;
  savedProjects: string[];
  selectedProject: string;
  selectedProjectId?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  via?: string;
  ts: number;
}

export interface AntigravityConversationItem {
  conversationId: string;
  title: string;
  projectId: string;
  projectName: string;
  workspacePath: string;
  transcriptPath: string;
  updatedAt: number;
  relativeTime: string;
  status: string;
  source: string;
}

export interface AntigravityProject {
  id: string;
  name: string;
  workspacePath: string;
  workspacePaths: string[];
  isRemote?: boolean;
  updatedAt: number;
  conversations: AntigravityConversationItem[];
}

export interface SessionTelemetry {
  contextUsed: number;
  contextLimit: number;
  contextPercent: number;
  overallTokPerSec: number;
  streamTokPerSec: number;
  ttftSec: number;
  outputTokens: number;
  compacted?: boolean;
  updatedAt: number;
}

export interface SessionInfo {
  conversationId: string;
  projectId?: string;
  projectName?: string;
  title?: string;
  workspacePath: string;
  transcriptPath: string;
  modelName: string;
  status: PetExecutionStatus;
  badge: string;
  lastThinking: string;
  lastUserInput: string;
  lastAssistantReply: string;
  quickReplies?: string[];
  telemetry?: SessionTelemetry | null;
  messages: ChatTurn[];
  updatedAt: number;
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolName: string;
  commandLine: string;
  summary: string;
  createdAt: number;
}

export interface PendingMcpWait {
  id: string;
  conversationId: string;
  summary: string;
  quickReplies: string[];
  createdAt: number;
}

export interface SubagentItem {
  id: string;
  name: string;
  role: string;
  typeName?: string;
  source?: 'subagent' | 'teamwork' | 'swarm' | 'test';
  slotIndex?: number;
  packId?: string;
  scheme: string;
  outfit: string;
  status: 'WORKING' | 'THINKING' | 'WAITING' | 'DONE' | 'ERROR';
  progressText: string;
  progressPercent?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BridgeSnapshot {
  palette?: PetPalette;
  settings: PetSettings;
  packs?: PetPackSummary[];
  activePack?: PetPackSummary | null;
  activeConversationId: string | null;
  agyRunning: boolean;
  projects?: AntigravityProject[];
  sessions: SessionInfo[];
  pendingApprovals: PendingApproval[];
  pendingMcpWaits: PendingMcpWait[];
  queuedCounts: Record<string, number>;
  subagents?: SubagentItem[];
}

export interface PetReactionEvent {
  expression?: string | null;
  motion?: string | null;
  speech?: string;
  badge?: string;
  thinking?: boolean;
  openMiniBar?: boolean;
  interactive?: boolean;
}

declare global {
  interface Window {
    petHost?: {
      bridgePort: number;
      setMouseCapture: (capture: boolean) => void;
      focusWindow: () => void;
      blurWindow: () => void;
      openExternal: (url: string) => void;
      showContextMenu?: () => void;
      quitApp: () => void;
      pickDirectory: () => Promise<string | null>;
      onCursor: (cb: (pt: { x: number; y: number; insideWindow: boolean; locked: boolean }) => void) => () => void;
      onCommand: (cb: (cmd: { type: string; [k: string]: unknown }) => void) => () => void;
    };
  }
}
