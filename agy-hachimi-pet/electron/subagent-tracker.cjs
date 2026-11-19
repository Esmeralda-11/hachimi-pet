const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findTranscriptPath } = require('./antigravity-catalog.cjs');
const { normalizeToolArgs } = require('./transcript-watcher.cjs');

const SCHEME_LIST = ['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian'];
const OUTFIT_LIST = ['maid'];

const LEGACY_SCHEME_MAP = {
  gemini: 'astral',
  deepseek: 'azure',
  claude: 'amber',
  minimax: 'sakura',
  qwen: 'astral',
  kimi: 'emerald',
  chatgpt: 'arctic',
  harness: 'obsidian',
};

function normalizeSchemeId(id) {
  const k = String(id || '').toLowerCase();
  if (SCHEME_LIST.includes(k)) return k;
  return LEGACY_SCHEME_MAP[k] || 'astral';
}

const BRAIN_ROOTS = [
  path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
];

function shortPathLabel(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-1)[0] || parts.slice(-2).join('/');
}

/**
 * Match monitor sentinel names (`monitor`, `r8-monitor`, `swarm_monitor`, etc.) that must never spawn pets.
 */
function isMonitorMemberName(name) {
  return /^(monitor|.*[-_]monitor)$/i.test(String(name || '').trim());
}

function friendlyRoleForType(typeName, rawRole) {
  const t = String(typeName || '').toLowerCase();
  if (rawRole && String(rawRole).trim()) return String(rawRole).trim();
  if (t === 'research') return '调研探查';
  if (t === 'browser') return '浏览器操作';
  if (t === 'image-generator') return '视觉绘制';
  if (t === 'self') return '镜像分身';
  if (t === 'teamwork') return '团队哨兵';
  if (t === 'teamwork_interviewer') return '需求访谈';
  if (t === 'teamwork_orchestrator') return '主调度';
  if (t === 'teamwork_explorer') return '代码勘探';
  if (t === 'teamwork_worker') return '核心工程';
  if (t === 'teamwork_reviewer') return '代码审查';
  if (t === 'teamwork_challenger') return '红队挑战';
  if (t === 'teamwork_auditor') return '终审审计';
  return typeName ? `${typeName}` : '协作子代理';
}

/**
 * Extract clean identity (`name`, `role`, `source`, `teamworkFolder`, `teamworkDir`) from `invoke_subagent` args.
 */
function extractSubagentIdentity(rawArgs = {}) {
  const args = normalizeToolArgs(rawArgs);
  const typeName = String(args.TypeName || args.type || '').trim();
  const rawRole = String(args.Role || args.role || '').trim();
  const prompt = String(args.Prompt || args.prompt || '');

  let teamworkDir = '';
  let teamworkFolder = '';
  const twFullMatch = prompt.match(/([a-zA-Z]:[\\/][^\r\n"']*?\.agents[\\/]+teamwork[\\/]+([a-zA-Z0-9_-]+))/i);
  const twRelMatch = prompt.match(/(\.agents[\\/]+teamwork[\\/]+([a-zA-Z0-9_-]+))/i);
  if (twFullMatch) {
    teamworkDir = twFullMatch[1].replace(/\\\\/g, '\\');
    teamworkFolder = twFullMatch[2];
  } else if (twRelMatch) {
    teamworkFolder = twRelMatch[2];
  }

  const isTeamwork =
    typeName.toLowerCase().startsWith('teamwork') ||
    Boolean(teamworkFolder);

  if (isTeamwork) {
    const cleanFolder =
      teamworkFolder && teamworkFolder.toLowerCase() !== 'original_request'
        ? teamworkFolder
        : typeName.replace(/^teamwork_?/i, '') || 'sentinel';
    const name = args.Name || cleanFolder || rawRole || typeName;
    const role = friendlyRoleForType(typeName, rawRole);
    return {
      name: String(name),
      role,
      typeName: typeName || 'teamwork',
      source: 'teamwork',
      teamworkFolder: cleanFolder,
      teamworkDir,
      initialBrief: summarizePromptBrief(prompt, rawRole || cleanFolder),
    };
  }

  const name = String(args.Name || rawRole || typeName || 'subagent').trim();
  const role = friendlyRoleForType(typeName, typeName ? friendlyRoleForType(typeName, '') : rawRole);
  return {
    name,
    role,
    typeName: typeName || 'subagent',
    source: 'subagent',
    teamworkFolder: '',
    teamworkDir: '',
    initialBrief: summarizePromptBrief(prompt, rawRole || name),
  };
}

function summarizePromptBrief(prompt, fallback = '准备执行子任务…') {
  if (!prompt || typeof prompt !== 'string') return fallback;
  const lines = prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
    .filter(
      (l) =>
        l.length > 4 &&
        !/^(Teamwork state folder|Your state folder|Your dispatch|Read the original|Relay to|Parameters:|Working directory:|Integrity mode:|<<<|REQUEST>>>)/i.test(l)
    );
  const pick = lines[0] || fallback;
  return pick.length > 44 ? pick.slice(0, 42) + '…' : pick;
}

function describeChildTool(toolName, rawArgs = {}) {
  const args = normalizeToolArgs(rawArgs);
  const n = String(toolName || '').toLowerCase();
  if (/read_file|view_file/.test(n)) {
    const f = shortPathLabel(args.Path || args.TargetFile || '');
    return `读取 ${f || '文件'}`;
  }
  if (/grep_search|find_by_name|list_dir/.test(n)) {
    const q = String(args.Query || args.Pattern || shortPathLabel(args.SearchPath || args.DirectoryPath || '')).slice(0, 26);
    return `检索 ${q || '代码库'}`;
  }
  if (/write_file|edit_file|replace/.test(n)) {
    const f = shortPathLabel(args.Path || args.TargetFile || '');
    if (/handoff\.md$/i.test(f)) return '撰写交付报告 handoff.md';
    if (/progress\.md$/i.test(f)) return '同步任务进度';
    return `编辑 ${f || '代码'}`;
  }
  if (/run_command/.test(n)) {
    const cmd = String(args.toolSummary || args.CommandLine || args.command || '').trim();
    return `终端执行 ${cmd.slice(0, 30) || '命令'}`;
  }
  if (/search_web|read_url/.test(n)) {
    const q = String(args.query || args.Url || '').trim();
    return `检索 ${q.slice(0, 28) || '网页'}`;
  }
  if (/browser|click|navigate|screenshot|evaluate/.test(n)) {
    return '操作浏览器页面';
  }
  if (/invoke_subagent/.test(n)) {
    return `派发子代理 · ${args.Role || args.TypeName || '子任务'}`;
  }
  if (/post_message/.test(n)) {
    return '发布看板消息';
  }
  if (/swarm_wait/.test(n)) {
    return '看板待命中';
  }
  if (/send_message/.test(n)) {
    return '汇报执行结果';
  }
  return `调用 ${toolName}`;
}

/**
 * Inspect the tail of a child transcript on disk to determine whether its active turn has ended or parked.
 */
function inspectTranscriptActivity(transcriptPath, teamworkDir = '') {
  try {
    if (teamworkDir) {
      const handoffPath = path.join(teamworkDir, 'handoff.md');
      if (fs.existsSync(handoffPath)) {
        return {
          exists: true,
          finished: true,
          waitingOnSwarmBoard: false,
          hasRunningBgTask: false,
          activelyWorking: false,
          mtimeMs: fs.statSync(handoffPath).mtimeMs,
        };
      }
    }
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return { exists: false, finished: false, waitingOnSwarmBoard: false, hasRunningBgTask: false, activelyWorking: true, mtimeMs: Date.now() };
    }
    const stat = fs.statSync(transcriptPath);
    const tailLen = Math.min(stat.size, 65536);
    const buf = Buffer.alloc(tailLen);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    let lastPlanner = null;
    let pendingSwarmWait = false;
    let hasSwarmWaitDone = false;
    let wokeSinceLastPlanner = false;
    let serverRestarted = false;
    const runningBgTasks = new Set();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const t = String(obj.type || '').toUpperCase();
        const contentStr = typeof obj.content === 'string' ? obj.content : '';

        if (t.includes('SYSTEM_MESSAGE') && /stopped due to server restart/i.test(contentStr)) {
          serverRestarted = true;
          runningBgTasks.clear();
          continue;
        }

        if (t.includes('USER_INPUT') || t.includes('SYSTEM_MESSAGE')) {
          serverRestarted = false;
          const senderMatch = contentStr.match(/sender=([^\s\r\n>]+)/);
          if (senderMatch) {
            runningBgTasks.delete(senderMatch[1]);
          }
          runningBgTasks.delete('__bg__');
          // A new wake-up prompt/message arrived! Reset turn completion flags until model responds.
          lastPlanner = null;
          pendingSwarmWait = false;
          hasSwarmWaitDone = false;
          wokeSinceLastPlanner = true;
        } else if (t === 'PLANNER_RESPONSE') {
          serverRestarted = false;
          lastPlanner = obj;
          wokeSinceLastPlanner = false;
          const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
          pendingSwarmWait = calls.some((c) => (c.name || c.tool_name) === 'swarm_wait');
          hasSwarmWaitDone = false;
          for (const c of calls) {
            if ((c.name || c.tool_name) === 'manage_task') {
              const a = normalizeToolArgs(c.args || {});
              if (String(a.Action || '').toLowerCase() === 'kill' && a.TaskId) {
                runningBgTasks.delete(String(a.TaskId));
              }
            }
          }
        } else if (t === 'GENERIC') {
          if (obj.status === 'RUNNING') {
            const taskMatch = contentStr.match(/task id:\s*([^\s\r\n"]+)/i);
            if (!pendingSwarmWait) {
              runningBgTasks.add(taskMatch ? taskMatch[1] : '__bg__');
            }
          }
          if (pendingSwarmWait && (obj.status === 'DONE' || obj.status === 'RUNNING')) {
            hasSwarmWaitDone = true;
          }
        }
      } catch { /* ignore partial line */ }
    }

    const calls = Array.isArray(lastPlanner?.tool_calls) ? lastPlanner.tool_calls : [];
    const hasRunningBgTask = runningBgTasks.size > 0 && Date.now() - stat.mtimeMs < 15 * 60 * 1000;
    const finished = Boolean(
      serverRestarted ||
      (lastPlanner && calls.length === 0 && !wokeSinceLastPlanner && !hasRunningBgTask)
    );
    const waitingOnSwarmBoard = Boolean(!serverRestarted && (pendingSwarmWait || hasSwarmWaitDone) && !wokeSinceLastPlanner);
    const activelyWorking = !finished && !waitingOnSwarmBoard;

    return {
      exists: true,
      finished,
      waitingOnSwarmBoard,
      hasRunningBgTask,
      activelyWorking,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { exists: false, finished: false, waitingOnSwarmBoard: false, hasRunningBgTask: false, activelyWorking: false, mtimeMs: Date.now() };
  }
}

/**
 * Inspect `board.jsonl` to check if coordinator already posted `[done]` and get latest post per agent.
 */
function inspectSwarmBoard(boardPath) {
  const result = { isDone: false, hasWorkerPost: false, mtimeMs: 0, latestByAgent: new Map() };
  try {
    if (!boardPath || !fs.existsSync(boardPath)) return result;
    const stat = fs.statSync(boardPath);
    result.mtimeMs = stat.mtimeMs;
    const tailLen = Math.min(stat.size, 65536);
    const buf = Buffer.alloc(tailLen);
    const fd = fs.openSync(boardPath, 'r');
    try {
      fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    for (const line of lines) {
      try {
        const post = JSON.parse(line);
        const agent = String(post.agent || post.sender || '').trim();
        const text = String(post.text || '').replace(/\s+/g, ' ').trim();
        if (!agent) continue;
        result.latestByAgent.set(agent, { seq: post.seq, text });
        if (agent !== 'coordinator') {
          result.hasWorkerPost = true;
          result.isDone = false;
        } else if (/^\[done\]/i.test(text)) {
          result.isDone = true;
        } else {
          // A new assignment or follow-up round posted by coordinator after an earlier `[done]` reopens the board
          result.isDone = false;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return result;
}

/**
 * Universal Multi-Pet Subagent & Swarm Tracker.
 * Immediately removes subagent pets when their task/turn finishes so the UI can play a clean fade-out animation.
 */
class SubagentTracker {
  /**
   * @param {{
   *   watcher: import('./transcript-watcher.cjs').TranscriptWatcher,
   *   getMainSettings: () => { packId?: string, scheme: string, outfit: string, defaultWorkspace?: string },
   *   getActivePack?: () => { id: string, badgeEmoji?: string, defaultVariant?: string, variants?: Array<{ id: string }> },
   *   getWatchedRootIds: () => string[],
   *   onChange: () => void,
   *   onReaction: (ev: any) => void,
   * }} deps
   */
  constructor({ watcher, getMainSettings, getActivePack, getWatchedRootIds, onChange, onReaction, brainRoots }) {
    this.watcher = watcher;
    this.getMainSettings = getMainSettings;
    this.getActivePack = getActivePack;
    this.getWatchedRootIds = getWatchedRootIds;
    this.onChange = onChange;
    this.onReaction = onReaction;
    this.brainRoots = Array.isArray(brainRoots) ? brainRoots : BRAIN_ROOTS;

    /** @type {Map<string, any>} visualId -> SubagentItem & internal metadata */
    this.items = new Map();
    /** @type {Map<string, string>} childConversationId -> visualId */
    this.convToVisualId = new Map();
    /** @type {Map<string, any>} childConversationId -> remembered metadata for waking sleeping swarm/subagents */
    this.knownConvMeta = new Map();
    /** @type {Map<string, string[]>} parentConversationId -> FIFO queue of unbound visualIds */
    this.pendingByParent = new Map();
    /** @type {Set<string>} All conversationIds in the subagent tree */
    this.childConversations = new Set();
    /** @type {Set<string>} Permanently killed subagents & swarm keys */
    this.retiredKeys = new Set();
    /** @type {Set<string>} Coordinator conversationIds whose Swarm posted `[done]` or finished */
    this.closedSwarms = new Set();
    /** @type {Map<string, number>} swarmKey -> timestampMs (60s grace window while waiting for members.json flush) */
    this.pendingSwarmSpawns = new Map();
    /** @type {Map<string, number>} coordinatorId -> timestampMs */
    this.lastSwarmAddAt = new Map();

    this.seq = 1;
    this.pollTimer = setInterval(() => this._pollSwarmAndTeamworkFiles(), 1200);
    this.pollTimer.unref?.();
  }

  _getActivePack() {
    const pack = this.getActivePack?.();
    if (pack && Array.isArray(pack.variants) && pack.variants.length > 0) {
      return pack;
    }
    return {
      id: 'hachimi',
      badgeEmoji: '',
      defaultVariant: 'astral',
      variants: SCHEME_LIST.map((id) => ({ id })),
    };
  }

  _getBadgeEmoji() {
    return this._getActivePack()?.badgeEmoji || '';
  }

  isChildConversation(cid) {
    return this.childConversations.has(cid);
  }

  getPublicList() {
    return Array.from(this.items.values())
      .map((it) => ({
        id: it.id,
        name: it.name,
        role: it.role,
        typeName: it.typeName,
        source: it.source,
        slotIndex: it.slotIndex,
        packId: it.packId || 'hachimi',
        scheme: it.scheme,
        outfit: it.outfit,
        status: it.status,
        progressText: it.progressText,
        progressPercent: it.progressPercent,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  clearAll() {
    for (const it of Array.from(this.items.values())) {
      this._finishAndRemove(it.id, { permanent: true, silent: true });
    }
    this.pendingByParent.clear();
    this.pendingSwarmSpawns.clear();
    this.onChange();
  }

  removeById(id) {
    this._finishAndRemove(id, { permanent: true });
  }

  _isCoordinatorType(typeName) {
    const t = String(typeName || '').toLowerCase();
    return t === 'teamwork' || t === 'teamwork_orchestrator';
  }

  /**
   * Directly remove a finished subagent so the frontend immediately fades out & disposes its Whale Girl!
   */
  _finishAndRemove(id, { permanent = false, silent = false } = {}) {
    const it = this.items.get(id);
    if (!it) return;
    if (it.retireTimer) {
      clearTimeout(it.retireTimer);
      it.retireTimer = null;
    }

    if (it.childConversationId) {
      this.convToVisualId.delete(it.childConversationId);
      if (permanent) {
        this.retiredKeys.add(it.childConversationId);
        if (!this._isCoordinatorType(it.typeName)) {
          this.watcher.detach(it.childConversationId);
        }
      } else if (!this._isCoordinatorType(it.typeName) && it.source !== 'swarm' && it.typeName !== 'browser') {
        // One-shot worker subagents (`research`, `explorer`, `worker`, `reviewer`, `challenger`, `auditor`, `interviewer`)
        // never resume after completing their final turn — detach cleanly!
        this.retiredKeys.add(it.childConversationId);
        this.watcher.detach(it.childConversationId);
      }
    }

    if (permanent && it.swarmKey) {
      this.retiredKeys.add(it.swarmKey);
    }

    this.items.delete(id);
    if (!silent) {
      this.onChange();
    }
  }

  _hasActiveDescendants(conversationId) {
    if (!conversationId) return false;
    for (const it of this.items.values()) {
      if (it.source === 'test') continue;
      if (
        it.parentConversationId === conversationId ||
        this._isDescendantOf(it.parentConversationId, conversationId)
      ) {
        return true;
      }
    }
    return false;
  }

  _isUtilityOnlySubagent(typeName) {
    const t = String(typeName || '').trim().toLowerCase();
    return t === 'image-generator';
  }

  _isSwarmTranscriptBusyWithBgTask(tp) {
    if (!tp || !fs.existsSync(tp)) return false;
    const act = inspectTranscriptActivity(tp);
    return Boolean(act.exists && act.hasRunningBgTask && !act.waitingOnSwarmBoard);
  }

  _resolveMemberTranscriptPath(brainRoot, convId) {
    if (!convId) return '';
    if (brainRoot) {
      const direct = path.join(brainRoot, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(direct)) return direct;
    }
    return this.knownConvMeta.get(convId)?.transcriptPath || findTranscriptPath(convId) || '';
  }

  _isSwarmMemberWorkingOnDisk(coordinatorId, memberName, childCid) {
    if (!coordinatorId) return null;
    for (const brainRoot of this.brainRoots) {
      const membersPath = path.join(brainRoot, coordinatorId, '.system_generated', 'swarm', 'members.json');
      if (!fs.existsSync(membersPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
        const members = data?.members || {};
        const m =
          members[memberName] ||
          Object.values(members).find((x) => x && x.conversation_id === childCid);
        if (!m) return null;
        const isKilled = Boolean(
          m.killed ||
          String(m.phase || '').toUpperCase() === 'KILLED' ||
          String(m.desired_state || '').toUpperCase() === 'KILLED'
        );
        if (isKilled || String(m.phase || '').toUpperCase() !== 'RUNNING') {
          return false;
        }
        if (m.wake_mode === 'working') {
          return true;
        }
        const tp = this._resolveMemberTranscriptPath(brainRoot, m.conversation_id || childCid);
        return this._isSwarmTranscriptBusyWithBgTask(tp);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Called when Antigravity `Stop` hook fires for a specific subagent conversationId.
   * Removes finished subagents/swarm workers unless they still have active descendants,
   * running background tasks, or disk-confirmed `working` status.
   */
  handleSessionStopped(conversationId) {
    if (!conversationId) return;
    if (this._hasActiveDescendants(conversationId)) return;
    const vid = this.convToVisualId.get(conversationId);
    if (!vid) return;
    const item = this.items.get(vid);
    if (!item) return;

    if (item.source === 'swarm') {
      const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
      const bgBusy = diskWorking === null && this._isSwarmTranscriptBusyWithBgTask(item.transcriptPath);
      if (diskWorking !== true && !bgBusy) {
        this._finishAndRemove(vid, { permanent: false });
      }
      return;
    }

    if (item.transcriptPath && fs.existsSync(item.transcriptPath)) {
      const act = inspectTranscriptActivity(item.transcriptPath, item.teamworkDir);
      if (act.hasRunningBgTask) return;
    }

    this._finishAndRemove(vid);
  }

  /**
   * Called ONLY when a Swarm coordinator explicitly posts `[done]` (or explicit manual cleanup).
   * Never called merely because a parent paused its dispatch turn while waiting for async children!
   */
  handleSwarmCompleted(coordinatorId) {
    if (!coordinatorId) return;
    this.closedSwarms.add(coordinatorId);
    const prefix = `swarm:${coordinatorId}:`;
    for (const k of Array.from(this.pendingSwarmSpawns.keys())) {
      if (k.startsWith(prefix)) {
        this.pendingSwarmSpawns.delete(k);
      }
    }

    const toRemove = [];
    for (const it of this.items.values()) {
      if (it.source === 'swarm' && it.parentConversationId === coordinatorId) {
        toRemove.push(it.id);
      }
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        this._finishAndRemove(id, { permanent: true, silent: true });
      }
      this.onChange();
    }
  }

  handleRootTurnCompleted(rootConversationId) {
    this.handleSwarmCompleted(rootConversationId);
  }

  _isDescendantOf(cid, ancestorId) {
    let cur = cid;
    let guard = 0;
    while (cur && guard++ < 8) {
      if (cur === ancestorId) return true;
      const meta = this.knownConvMeta.get(cur);
      cur = meta?.parentConversationId || null;
    }
    return false;
  }

  _allocateSlotIndex() {
    const used = new Set();
    for (const it of this.items.values()) {
      used.add(it.slotIndex);
    }
    let idx = 0;
    while (used.has(idx)) idx++;
    return idx;
  }

  _allocateStyle(seed) {
    const pack = this._getActivePack();
    const packId = pack?.id || 'hachimi';
    const pool = Array.isArray(pack?.variants) && pack.variants.length > 0
      ? pack.variants.map((v) => v.id)
      : SCHEME_LIST;
    const main = this.getMainSettings?.() || { packId: 'hachimi', scheme: 'astral', outfit: 'maid' };
    const rawMain = String(main.scheme || pack?.defaultVariant || pool[0] || 'astral');
    const mainScheme = packId === 'hachimi'
      ? normalizeSchemeId(rawMain)
      : (pool.includes(rawMain) ? rawMain : (pack?.defaultVariant || pool[0]));

    const usedSchemes = new Set([mainScheme]);
    const usageCounts = new Map(pool.map((id) => [id, id === mainScheme ? 1 : 0]));
    for (const it of this.items.values()) {
      if ((it.packId || 'hachimi') !== packId) continue;
      const sNorm = packId === 'hachimi' ? normalizeSchemeId(it.scheme) : it.scheme;
      usedSchemes.add(sNorm);
      usageCounts.set(sNorm, (usageCounts.get(sNorm) || 0) + 1);
    }

    // Sequential selection of distinct unused variants from active pack's pool (avoiding main pet's active scheme)
    const firstUnused = pool.find((id) => !usedSchemes.has(id));
    if (firstUnused) {
      return { packId, scheme: firstUnused, outfit: 'maid' };
    }

    // All variants in pool are currently occupied: pick the least-used one (still preferring non-main first)
    let bestId = pool[0];
    let bestScore = Infinity;
    for (const id of pool) {
      const score = (usageCounts.get(id) || 0) + (id === mainScheme && pool.length > 1 ? 0.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    return { packId, scheme: bestId, outfit: 'maid' };
  }

  /**
   * Spawn a manual/UI test subagent with simulated progress -> automatic smooth fade-out removal on completion!
   */
  spawnTestSubagent(payload = {}) {
    const templates = [
      { name: 'explorer_ui', role: '代码勘探', text: '扫描界面组件与视觉层级' },
      { name: 'worker_core', role: '核心工程', text: '同步多智能体状态' },
      { name: 'swarm_verifier', role: '验证节点', text: '校验构建产物与点击穿透' },
      { name: 'challenger_qa', role: '红队挑战', text: '验证并发动画与边界状态' },
      { name: 'browser_agent', role: '浏览器验证', text: '执行端到端回归检查' },
    ];
    const tpl = templates[this.items.size % templates.length];
    const id = `whale_test_${Date.now()}_${this.seq++}`;
    const style = this._allocateStyle(id + (payload.name || tpl.name));
    const item = {
      id,
      name: payload.name || tpl.name,
      role: payload.role || tpl.role,
      typeName: 'test_subagent',
      source: 'test',
      slotIndex: this._allocateSlotIndex(),
      packId: style.packId,
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: payload.text || tpl.text,
      progressPercent: 25,
      stepCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.items.set(id, item);
    this.onReaction({
      expression: 'excited',
      motion: 'jump',
      speech: `测试子代理「${item.name}」已生成。`,
    });
    this.onChange();

    setTimeout(() => {
      const cur = this.items.get(id);
      if (cur) {
        cur.progressPercent = 72;
        cur.progressText = '推进核心步骤 (2/2)';
        cur.updatedAt = Date.now();
        this.onChange();
      }
    }, 2400);

    item.retireTimer = setTimeout(() => {
      this._finishAndRemove(id);
    }, 4800);

    return item;
  }

  /**
   * Handle instant tool invocations from Hooks (`PreToolUse`) or CLI (`AgyRunner`).
   */
  handleLiveToolCall(parentConversationId, toolName, rawArgs = {}) {
    const args = normalizeToolArgs(rawArgs);
    if (toolName === 'invoke_subagent') {
      this._enqueueOrSpawnSubagent(parentConversationId, args, { quiet: false, origin: 'hook' });
    } else if (toolName === 'send_message') {
      this._handleSendMessage(args, { quiet: false });
    } else if (toolName === 'manage_subagents') {
      this._handleManageSubagents(parentConversationId, args);
    } else if (toolName === 'swarm') {
      this._handleSwarmToolCall(parentConversationId, args, { quiet: false });
    } else if (toolName === 'post_message') {
      const text = String(args.text || '').trim();
      if (/^\[done\]/i.test(text)) {
        this.handleSwarmCompleted(parentConversationId);
      }
    }
  }

  /**
   * Handle every incremental step from `TranscriptWatcher` (both root conversations and child subagent trees).
   */
  handleTranscriptStep(ev) {
    const { conversationId, kind, quiet } = ev;

    const eventTimeMs = Date.parse(ev.createdAt || '') || Date.now();
    const isStaleHistorical = Boolean(quiet && Date.now() - eventTimeMs > 8 * 60 * 1000);

    // 1. Check subagent spawning / management tools in ANY watched conversation
    if (kind === 'tool_call') {
      if (ev.toolName === 'invoke_subagent') {
        if (!isStaleHistorical) {
          this._enqueueOrSpawnSubagent(conversationId, ev.args, { quiet, origin: 'transcript' });
        }
      } else if (ev.toolName === 'send_message') {
        if (!isStaleHistorical) {
          this._handleSendMessage(ev.args, { quiet });
        }
      } else if (ev.toolName === 'manage_subagents') {
        if (!isStaleHistorical) {
          this._handleManageSubagents(conversationId, ev.args);
        }
      } else if (ev.toolName === 'swarm') {
        if (!isStaleHistorical) {
          this._handleSwarmToolCall(conversationId, ev.args, { quiet });
        }
      } else if (ev.toolName === 'post_message' && !quiet) {
        const text = String(ev.args?.text || '').trim();
        // If coordinator posts `[done]` at start of message, immediately close & fade out all swarm workers!
        if (!this.childConversations.has(conversationId) && /^\[done\]/i.test(text)) {
          this.handleSwarmCompleted(conversationId);
          return;
        }
      }
    } else if (kind === 'subagent_created') {
      this._bindCreatedSubagent(conversationId, ev.childConversationId, ev.childTranscriptPath, {
        quiet,
        isStaleHistorical,
      });
    } else if (kind === 'subagent_killed_confirm' && !quiet) {
      this._handleKilledRolesText(conversationId, ev.killedRoles || '');
    } else if (kind === 'subagent_list' && Array.isArray(ev.subagents)) {
      if (!isStaleHistorical) {
        this._reconcileSubagentList(conversationId, ev.subagents, { quiet });
      }
    } else if (kind === 'incoming_message' && !quiet && ev.sender) {
      // If a child subagent just sent its final report back to its parent and has no active children/bg tasks, remove it!
      const senderVid = this.convToVisualId.get(ev.sender);
      if (senderVid && !this._hasActiveDescendants(ev.sender)) {
        const senderItem = this.items.get(senderVid);
        if (senderItem && senderItem.source === 'swarm') {
          const diskWorking = this._isSwarmMemberWorkingOnDisk(
            senderItem.parentConversationId,
            senderItem.name,
            ev.sender
          );
          if (diskWorking !== true) {
            this._finishAndRemove(senderVid, { permanent: false });
          }
        } else if (senderItem && senderItem.transcriptPath) {
          const act = inspectTranscriptActivity(senderItem.transcriptPath, senderItem.teamworkDir);
          if (act.finished || act.waitingOnSwarmBoard) {
            this._finishAndRemove(senderVid);
          }
        }
      }
    }

    // 2. If `conversationId` is a known sleeping Swarm worker or subagent that just woke up with live work, re-spawn it!
    let visualId = this.convToVisualId.get(conversationId);
    if (!visualId && !quiet && this.knownConvMeta.has(conversationId) && !this.retiredKeys.has(conversationId)) {
      const meta = this.knownConvMeta.get(conversationId);
      const isWakeActivity =
        kind === 'thinking' ||
        (kind === 'tool_call' && ev.toolName !== 'swarm_wait' && ev.toolName !== 'read_board');
      if (isWakeActivity) {
        if (meta.source === 'swarm') {
          if (
            !isMonitorMemberName(meta.name) &&
            this._isSwarmMemberWorkingOnDisk(meta.parentConversationId, meta.name, conversationId) === true
          ) {
            this.closedSwarms.delete(meta.parentConversationId);
            this.retiredKeys.delete(`swarm:${meta.parentConversationId}:${meta.name}`);
            this.retiredKeys.delete(conversationId);
            const revived = this._ensureSwarmMember(meta.parentConversationId, meta.name, {
              conversationId,
              transcriptPath: meta.transcriptPath,
              role: meta.rawRole || 'Swarm Worker',
            });
            visualId = revived?.id;
          }
        } else if (
          !this._isCoordinatorType(meta.typeName) &&
          !this._isUtilityOnlySubagent(meta.typeName)
        ) {
          const act = meta.transcriptPath
            ? inspectTranscriptActivity(meta.transcriptPath, meta.teamworkDir)
            : { activelyWorking: true };
          if (act.activelyWorking) {
            const revived = this._spawnNonSwarmSubagent(meta, conversationId, {
              progressText: '恢复执行后续任务',
              progressPercent: 30,
              quiet,
            });
            visualId = revived?.id;
          }
        }
      }
    }

    if (!visualId) return;
    const item = this.items.get(visualId);
    if (!item) return;

    if (kind === 'thinking') {
      item.status = 'THINKING';
      item.stepCount = (item.stepCount || 1) + 1;
      item.progressText = ev.text.slice(0, 36);
      if (!item.hasChecklistProgress) {
        item.progressPercent = Math.min(92, (item.progressPercent || 18) + 5);
      }
      item.updatedAt = Date.now();
      if (!quiet) this.onChange();
      return;
    }

    if (kind === 'tool_call') {
      const tn = String(ev.toolName || '');
      item.stepCount = (item.stepCount || 1) + 1;
      item.lastToolName = tn;

      // In Native Swarm, `swarm_wait` puts this worker to sleep on the board; hide its pet once no longer working on disk!
      if (tn === 'swarm_wait') {
        if (item.source === 'swarm' && !this._hasActiveDescendants(conversationId)) {
          const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
          if (diskWorking !== true) {
            this._finishAndRemove(item.id, { permanent: false, silent: Boolean(quiet) });
          }
        }
        return;
      }

      // Auto-remove pure relay `teamwork` sentinel once it spawns `teamwork_orchestrator`
      if (item.typeName === 'teamwork' && tn === 'invoke_subagent') {
        const childType = String(ev.args?.TypeName || '');
        if (childType === 'teamwork_orchestrator') {
          this._finishAndRemove(item.id);
          return;
        }
      }

      item.status = 'WORKING';
      item.progressText = describeChildTool(tn, ev.args);

      const targetPath = String(ev.args?.Path || ev.args?.TargetFile || '');
      if (/handoff\.md$/i.test(targetPath)) {
        item.wroteHandoff = true;
        item.progressPercent = 96;
      } else if (tn === 'send_message') {
        item.reportedBack = true;
        item.progressPercent = Math.max(item.progressPercent || 80, 96);
      } else if (!item.hasChecklistProgress) {
        item.progressPercent = Math.min(94, (item.progressPercent || 20) + 7);
      }

      item.updatedAt = Date.now();
      if (!quiet) this.onChange();
      return;
    }

    // Subagent reached `assistant_reply` (`finalTurn`) or `turn_end`:
    // Hide Swarm members once no longer working on disk (`permanent: false`), and hide finished subagents!
    if ((kind === 'assistant_reply' && ev.finalTurn) || kind === 'turn_end') {
      if (!quiet && !this._hasActiveDescendants(conversationId)) {
        if (item.source === 'swarm') {
          const diskWorking = this._isSwarmMemberWorkingOnDisk(item.parentConversationId, item.name, conversationId);
          const bgBusy = diskWorking === null && this._isSwarmTranscriptBusyWithBgTask(item.transcriptPath);
          if (diskWorking !== true && !bgBusy) {
            this._finishAndRemove(item.id, { permanent: false });
          }
          return;
        }
        if (item.transcriptPath && fs.existsSync(item.transcriptPath)) {
          const act = inspectTranscriptActivity(item.transcriptPath, item.teamworkDir);
          if (act.hasRunningBgTask) return;
        }
        this._finishAndRemove(item.id);
      }
    }
  }

  _enqueueOrSpawnSubagent(parentConversationId, rawArgs, { quiet = false, origin = 'transcript' } = {}) {
    const ident = extractSubagentIdentity(rawArgs);
    const now = Date.now();

    // Keep ONLY lightweight pending metadata until `subagent_created` provides the real `childConversationId`.
    // This eliminates hook+transcript duplicate pets and prevents failed/rate-limited calls from creating phantom pets.
    const rawList = this.pendingByParent.get(parentConversationId) || [];
    const pendingList = rawList.filter((entry) => entry && now - (entry.createdAt || 0) < 90000);

    if (origin === 'transcript') {
      for (const entry of pendingList) {
        if (
          entry.origin === 'hook' &&
          !entry.matchedTranscript &&
          entry.ident?.name === ident.name
        ) {
          entry.matchedTranscript = true;
          this.pendingByParent.set(parentConversationId, pendingList);
          return null;
        }
      }
    } else if (origin === 'hook') {
      for (const entry of pendingList) {
        if (
          entry.origin === 'transcript' &&
          !entry.matchedHook &&
          entry.ident?.name === ident.name &&
          now - entry.createdAt < 15000
        ) {
          entry.matchedHook = true;
          this.pendingByParent.set(parentConversationId, pendingList);
          return null;
        }
      }
    }

    pendingList.push({
      ident,
      origin,
      quiet: Boolean(quiet),
      matchedTranscript: origin === 'transcript',
      matchedHook: origin === 'hook',
      createdAt: now,
    });
    this.pendingByParent.set(parentConversationId, pendingList);
    return null;
  }

  _spawnNonSwarmSubagent(meta, childConversationId, { progressText, progressPercent = 24, quiet = false, reaction = null } = {}) {
    if (!childConversationId || this.convToVisualId.has(childConversationId)) return null;
    const now = Date.now();
    const id = `whale_sub_${now}_${this.seq++}`;
    const style = this._allocateStyle(`${meta.name}_${childConversationId}`);
    const item = {
      id,
      parentConversationId: meta.parentConversationId,
      childConversationId,
      transcriptPath: meta.transcriptPath || '',
      name: meta.name,
      role: meta.role,
      typeName: meta.typeName,
      source: meta.source,
      teamworkFolder: meta.teamworkFolder || '',
      teamworkDir: meta.teamworkDir || '',
      slotIndex: this._allocateSlotIndex(),
      packId: style.packId,
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: progressText || meta.initialBrief || '协同运行中',
      progressPercent,
      stepCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(id, item);
    this.convToVisualId.set(childConversationId, id);
    if (reaction && !quiet) {
      this.onReaction(reaction);
    }
    this.onChange();
    return item;
  }

  _handleSendMessage(rawArgs = {}, { quiet = false } = {}) {
    const args = normalizeToolArgs(rawArgs);
    const recipient = String(
      args.Recipient || args.recipient || args.ConversationId || args.conversationId || ''
    ).trim();
    if (!recipient) return;

    this.retiredKeys.delete(recipient);
    const meta = this.knownConvMeta.get(recipient);
    if (!meta) return;

    const tp = meta.transcriptPath || findTranscriptPath(recipient);
    if (tp && !meta.transcriptPath) {
      meta.transcriptPath = tp;
    }
    if (tp && !this.watcher.has(recipient)) {
      this.watcher.attach(recipient, tp, { maxInitialBytes: 65536 });
    }

    if (
      !quiet &&
      meta.source !== 'swarm' &&
      !this.convToVisualId.has(recipient) &&
      !this._isCoordinatorType(meta.typeName) &&
      !this._isUtilityOnlySubagent(meta.typeName)
    ) {
      this._spawnNonSwarmSubagent(meta, recipient, {
        progressText: '已唤醒 · 恢复执行任务',
        progressPercent: 30,
        quiet,
      });
    }
  }

  _bindCreatedSubagent(parentConversationId, childConversationId, childTranscriptPath, { quiet = false, isStaleHistorical = false } = {}) {
    if (!childConversationId) return;
    const resolvedPath = childTranscriptPath || findTranscriptPath(childConversationId);
    const now = Date.now();

    const rawList = this.pendingByParent.get(parentConversationId) || [];
    const pendingList = rawList.filter((entry) => entry && now - (entry.createdAt || 0) < 90000);
    const head = pendingList.shift();
    if (pendingList.length === 0) {
      this.pendingByParent.delete(parentConversationId);
    } else {
      this.pendingByParent.set(parentConversationId, pendingList);
    }

    // Always mark childConversationId so child hooks never hijack the user's main session
    this.childConversations.add(childConversationId);

    if (this.convToVisualId.has(childConversationId)) {
      if (resolvedPath) {
        this.watcher.attach(childConversationId, resolvedPath);
      }
      return;
    }

    const deferredIdent = head?.ident || null;
    if (this.retiredKeys.has(childConversationId)) return;

    // Do NOT spawn stage pets for internal asset-generation helper calls (`image-generator`)
    if (deferredIdent && this._isUtilityOnlySubagent(deferredIdent.typeName)) {
      this.retiredKeys.add(childConversationId);
      return;
    }

    const activity = inspectTranscriptActivity(resolvedPath, deferredIdent?.teamworkDir || '');

    if (deferredIdent) {
      this.knownConvMeta.set(childConversationId, {
        parentConversationId,
        transcriptPath: resolvedPath,
        name: deferredIdent.name,
        role: deferredIdent.role,
        typeName: deferredIdent.typeName,
        source: deferredIdent.source,
        teamworkFolder: deferredIdent.teamworkFolder || '',
        teamworkDir: deferredIdent.teamworkDir || '',
      });
    }

    // Watch recent Teamwork coordinators in background so we discover any active Explorer/Worker children
    const isRecentCoordinator =
      deferredIdent &&
      this._isCoordinatorType(deferredIdent.typeName) &&
      now - activity.mtimeMs < 20 * 60 * 1000;

    if (quiet && isStaleHistorical && !isRecentCoordinator) {
      this.retiredKeys.add(childConversationId);
      return;
    }

    if (!activity.activelyWorking && !isRecentCoordinator) {
      this.retiredKeys.add(childConversationId);
      return;
    }

    const ident = deferredIdent || {
      name: `agent_${childConversationId.slice(0, 6)}`,
      role: '协作子代理',
      typeName: 'subagent',
      source: 'subagent',
      teamworkFolder: '',
      teamworkDir: '',
      initialBrief: '正在处理子任务',
    };

    const meta = {
      parentConversationId,
      transcriptPath: resolvedPath,
      name: ident.name,
      role: ident.role,
      typeName: ident.typeName,
      source: ident.source,
      teamworkFolder: ident.teamworkFolder || '',
      teamworkDir: ident.teamworkDir || '',
    };
    this.knownConvMeta.set(childConversationId, meta);

    if (!(quiet && this._isCoordinatorType(ident.typeName)) && activity.activelyWorking) {
      this._spawnNonSwarmSubagent(meta, childConversationId, {
        progressText: ident.initialBrief,
        progressPercent: 20,
        quiet,
        reaction: {
          expression: 'love',
          motion: 'wave',
          speech: `子代理「${ident.name}」已加入协作。`,
        },
      });
    }

    if (resolvedPath) {
      this.watcher.attach(childConversationId, resolvedPath, { maxInitialBytes: 262144 });
    }
  }

  _reconcileSubagentList(parentConversationId, list, { quiet = false } = {}) {
    if (quiet) return;
    const aliveIds = new Set();
    for (const entry of list) {
      const cid = entry.conversationId;
      if (!cid) continue;
      aliveIds.add(cid);
      if (entry.state === 'waiting_for_dependents' || entry.state === 'idle') {
        const vid = this.convToVisualId.get(cid);
        if (vid) this._finishAndRemove(vid);
        continue;
      }
      if (this.retiredKeys.has(cid)) continue;
      if (this.knownConvMeta.get(cid)?.source === 'swarm') continue;
      const ident = extractSubagentIdentity({
        TypeName: entry.type,
        Role: entry.role,
      });
      if (isMonitorMemberName(ident.name)) continue;
      if (this._isUtilityOnlySubagent(ident.typeName)) {
        this.retiredKeys.add(cid);
        continue;
      }
      const tp = entry.transcriptPath || findTranscriptPath(cid);
      const meta = {
        parentConversationId,
        transcriptPath: tp || '',
        name: ident.name,
        role: ident.role,
        typeName: ident.typeName,
        source: ident.source,
        teamworkFolder: ident.teamworkFolder || '',
        teamworkDir: ident.teamworkDir || '',
      };
      this.knownConvMeta.set(cid, meta);
      if (!this.convToVisualId.has(cid)) {
        this._spawnNonSwarmSubagent(meta, cid, {
          progressText: '协同运行中',
          progressPercent: 35,
          quiet,
        });
      }
      if (tp) {
        this.childConversations.add(cid);
        this.watcher.attach(cid, tp, { maxInitialBytes: 262144 });
      }
    }
    for (const it of Array.from(this.items.values())) {
      if (it.source !== 'swarm' && it.source !== 'test' && it.parentConversationId === parentConversationId && it.childConversationId && !aliveIds.has(it.childConversationId)) {
        this._finishAndRemove(it.id);
      }
    }
  }

  _handleKilledRolesText(parentConversationId, killedRoles) {
    if (!killedRoles) return;
    const roles = killedRoles.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
    for (const it of Array.from(this.items.values())) {
      if (it.parentConversationId === parentConversationId) {
        const itemRole = String(it.role || '').toLowerCase();
        const itemName = String(it.name || '').toLowerCase();
        if (roles.some((r) => itemRole.includes(r) || itemName.includes(r))) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    }
  }

  _handleManageSubagents(parentConversationId, rawArgs = {}) {
    const args = normalizeToolArgs(rawArgs);
    const action = String(args.Action || '').toLowerCase();
    if (action === 'kill_all') {
      for (const it of Array.from(this.items.values())) {
        if (!parentConversationId || it.parentConversationId === parentConversationId || this._isDescendantOf(it.parentConversationId, parentConversationId)) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    } else if (action === 'kill') {
      const ids = Array.isArray(args.ConversationIds) ? args.ConversationIds : [];
      for (const cid of ids) {
        this.retiredKeys.add(cid);
        const vid = this.convToVisualId.get(cid);
        if (vid) {
          this._finishAndRemove(vid, { permanent: true });
        }
        for (const it of Array.from(this.items.values())) {
          if (it.parentConversationId === cid || this._isDescendantOf(it.parentConversationId, cid)) {
            this._finishAndRemove(it.id, { permanent: true });
          }
        }
      }
    }
  }

  _handleSwarmToolCall(coordinatorId, rawArgs = {}, { quiet = false } = {}) {
    const args = normalizeToolArgs(rawArgs);
    const action = String(args.action || '').toLowerCase();
    const baseName = String(args.name || '').trim();
    if (!baseName || quiet) return;

    if (action === 'add') {
      const names = [];
      const nCount = Number(args.n);
      if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        for (let i = 1; i <= args.tasks.length; i++) names.push(`${baseName}-${i}`);
      } else if (Number.isFinite(nCount) && nCount > 1) {
        for (let i = 1; i <= nCount; i++) names.push(`${baseName}-${i}`);
      } else {
        names.push(baseName);
      }

      const validMembers = names.filter((n) => n !== 'coordinator' && !isMonitorMemberName(n));
      if (validMembers.length === 0) return;

      const now = Date.now();
      this.lastSwarmAddAt.set(coordinatorId, now);
      this.closedSwarms.delete(coordinatorId);

      for (const memberName of validMembers) {
        const swarmKey = `swarm:${coordinatorId}:${memberName}`;
        this.retiredKeys.delete(swarmKey);
        this.pendingSwarmSpawns.set(swarmKey, now);
        this._ensureSwarmMember(coordinatorId, memberName, {
          role: args.model ? `Swarm · ${args.model}` : 'Swarm Worker',
          brief: summarizePromptBrief(args.brief || '', '已加入蜂群看板，准备开工…'),
        });
      }
    } else if (action === 'kill') {
      const swarmKey = `swarm:${coordinatorId}:${baseName}`;
      this.retiredKeys.add(swarmKey);
      this.pendingSwarmSpawns.delete(swarmKey);
      for (const it of Array.from(this.items.values())) {
        if (it.swarmKey === swarmKey || (it.source === 'swarm' && it.parentConversationId === coordinatorId && it.name === baseName)) {
          this._finishAndRemove(it.id, { permanent: true });
        }
      }
    }
  }

  _ensureSwarmMember(coordinatorId, memberName, meta = {}) {
    if (!memberName || memberName === 'coordinator' || isMonitorMemberName(memberName)) return null;
    if (this.closedSwarms.has(coordinatorId)) return null;
    const swarmKey = `swarm:${coordinatorId}:${memberName}`;
    if (this.retiredKeys.has(swarmKey)) return null;

    for (const existing of this.items.values()) {
      if (existing.swarmKey === swarmKey) {
        if (meta.conversationId && existing.childConversationId !== meta.conversationId) {
          if (existing.childConversationId) {
            this.convToVisualId.delete(existing.childConversationId);
          }
          existing.childConversationId = meta.conversationId;
          const tp = meta.transcriptPath || findTranscriptPath(meta.conversationId);
          existing.transcriptPath = tp;
          this.convToVisualId.set(meta.conversationId, existing.id);
          this.knownConvMeta.set(meta.conversationId, {
            parentConversationId: coordinatorId,
            transcriptPath: tp,
            name: memberName,
            rawRole: meta.role || 'Swarm Worker',
            source: 'swarm',
            typeName: 'swarm_worker',
          });
          if (tp) {
            this.childConversations.add(meta.conversationId);
            this.watcher.attach(meta.conversationId, tp, { maxInitialBytes: 131072 });
          }
        } else if (meta.transcriptPath && !existing.transcriptPath) {
          existing.transcriptPath = meta.transcriptPath;
        }
        return existing;
      }
    }

    const tp = meta.transcriptPath || (meta.conversationId ? findTranscriptPath(meta.conversationId) : '');
    const id = `whale_swarm_${Date.now()}_${this.seq++}`;
    const style = this._allocateStyle(swarmKey);
    const item = {
      id,
      swarmKey,
      parentConversationId: coordinatorId,
      childConversationId: meta.conversationId || null,
      transcriptPath: tp,
      name: memberName,
      role: meta.role || 'Swarm 成员',
      typeName: 'swarm_worker',
      source: 'swarm',
      slotIndex: this._allocateSlotIndex(),
      packId: style.packId,
      scheme: style.scheme,
      outfit: style.outfit,
      status: 'WORKING',
      progressText: meta.brief || '已接入协作看板',
      progressPercent: 24,
      stepCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.items.set(id, item);
    if (meta.conversationId) {
      this.convToVisualId.set(meta.conversationId, id);
      this.knownConvMeta.set(meta.conversationId, {
        parentConversationId: coordinatorId,
        transcriptPath: tp,
        name: memberName,
        rawRole: meta.role || 'Swarm 成员',
        source: 'swarm',
        typeName: 'swarm_worker',
      });
      if (tp) {
        this.childConversations.add(meta.conversationId);
        this.watcher.attach(meta.conversationId, tp, { maxInitialBytes: 131072 });
      }
    }

    this.onReaction({
      expression: 'excited',
      motion: 'jump',
      speech: `成员「@${memberName}」已就位。`,
    });
    this.onChange();
    return item;
  }

  /**
   * Periodic liveness, Swarm (`members.json` authoritative `wake_mode === 'working'` + `board.jsonl` `[done]`),
   * and Teamwork (`progress.md`, `handoff.md`) sync!
   */
  _pollSwarmAndTeamworkFiles() {
    let dirty = false;
    const now = Date.now();

    // Prune expired pending spawn grace entries (> 60s)
    for (const [k, ts] of this.pendingSwarmSpawns.entries()) {
      if (now - ts >= 60000) {
        this.pendingSwarmSpawns.delete(k);
      }
    }

    // A. Collect candidate root conversation IDs (watched roots, tracked swarm items, pending spawns, and active BRAIN_ROOTS)
    const candidateSwarmIds = new Set(this.getWatchedRootIds?.() || []);
    for (const it of this.items.values()) {
      if (it.source === 'swarm' && it.parentConversationId) {
        candidateSwarmIds.add(it.parentConversationId);
      }
    }
    for (const k of this.pendingSwarmSpawns.keys()) {
      const m = k.match(/^swarm:([^:]+):/);
      if (m && m[1]) candidateSwarmIds.add(m[1]);
    }
    for (const brainRoot of this.brainRoots) {
      try {
        if (!fs.existsSync(brainRoot)) continue;
        for (const ent of fs.readdirSync(brainRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const membersPath = path.join(brainRoot, ent.name, '.system_generated', 'swarm', 'members.json');
          if (fs.existsSync(membersPath)) {
            const st = fs.statSync(membersPath);
            if (now - st.mtimeMs < 30 * 60 * 1000) {
              candidateSwarmIds.add(ent.name);
            }
          }
        }
      } catch { /* ignore */ }
    }

    for (const cid of candidateSwarmIds) {
      if (!cid) continue;
      let foundMembersForCid = false;

      for (const brainRoot of this.brainRoots) {
        const swarmDir = path.join(brainRoot, cid, '.system_generated', 'swarm');
        const membersPath = path.join(swarmDir, 'members.json');
        if (!fs.existsSync(membersPath)) continue;
        foundMembersForCid = true;

        try {
          const stat = fs.statSync(membersPath);
          const hasTrackedFromThisSwarm = Array.from(this.items.values()).some(
            (i) => i.parentConversationId === cid && i.source === 'swarm'
          );
          const cidPrefix = `swarm:${cid}:`;
          let hasPendingAdd = false;
          for (const [k, ts] of this.pendingSwarmSpawns.entries()) {
            if (k.startsWith(cidPrefix) && now - ts < 60000) {
              hasPendingAdd = true;
              break;
            }
          }

          if (!hasTrackedFromThisSwarm && !hasPendingAdd && now - stat.mtimeMs > 30 * 60 * 1000) {
            continue;
          }

          // 1. Read `members.json` FIRST so active/pending members block stale `[done]` from killing new rounds!
          const data = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
          const members = data?.members || {};

          const workingMembers = [];
          const memberStateMap = new Map();
          for (const [memberName, m] of Object.entries(members)) {
            if (memberName === 'coordinator' || isMonitorMemberName(memberName) || !m || typeof m !== 'object') {
              continue;
            }
            const isKilled = Boolean(
              m.killed ||
              String(m.phase || '').toUpperCase() === 'KILLED' ||
              String(m.desired_state || '').toUpperCase() === 'KILLED'
            );
            const tp = this._resolveMemberTranscriptPath(brainRoot, m.conversation_id);
            const isWorkingOnHost = Boolean(
              !isKilled &&
              String(m.phase || '').toUpperCase() === 'RUNNING' &&
              (m.wake_mode === 'working' || this._isSwarmTranscriptBusyWithBgTask(tp))
            );
            memberStateMap.set(memberName, { isKilled, isWorkingOnHost, tp });
            if (isWorkingOnHost) {
              workingMembers.push([memberName, m]);
            }
          }

          if (workingMembers.length > 0 || hasPendingAdd) {
            this.closedSwarms.delete(cid);
          }

          // 2. Check `board.jsonl`: only close when `[done]` is newer than latest `swarm add` AND nobody is working/pending
          const boardPath = path.join(swarmDir, 'board.jsonl');
          const boardInfo = inspectSwarmBoard(boardPath);
          if (
            boardInfo.isDone &&
            workingMembers.length === 0 &&
            !hasPendingAdd &&
            boardInfo.mtimeMs >= (this.lastSwarmAddAt.get(cid) || 0)
          ) {
            this.handleSwarmCompleted(cid);
            continue;
          }

          if (this.closedSwarms.has(cid) && workingMembers.length === 0 && !hasPendingAdd && !hasTrackedFromThisSwarm) {
            continue;
          }

          // 3. Fallback completion check (when coordinator finished without writing literal `[done]`):
          // Only triggers when neither coordinator nor non-monitor workers are working, `!hasPendingAdd`,
          // workers have posted on board, and coordinator's transcript finished >8s after last board post & add.
          const isCoordinatorWorking = Boolean(
            members.coordinator &&
            !members.coordinator.killed &&
            String(members.coordinator.phase || '').toUpperCase() === 'RUNNING' &&
            (
              members.coordinator.wake_mode === 'working' ||
              this._isSwarmTranscriptBusyWithBgTask(
                this._resolveMemberTranscriptPath(brainRoot, members.coordinator.conversation_id || cid)
              )
            )
          );
          if (!isCoordinatorWorking && workingMembers.length === 0 && !hasPendingAdd && boardInfo.hasWorkerPost) {
            const coordTranscript = path.join(brainRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
            const coordAct = inspectTranscriptActivity(coordTranscript);
            if (
              coordAct.exists &&
              coordAct.finished &&
              coordAct.mtimeMs > boardInfo.mtimeMs &&
              coordAct.mtimeMs >= (this.lastSwarmAddAt.get(cid) || 0) &&
              now - coordAct.mtimeMs > 8000
            ) {
              this.handleSwarmCompleted(cid);
              continue;
            }
          }

          // 4. Sync each Swarm member 1:1 with authoritative `members.json` ("working -> show, done -> hide")
          const seenMemberKeys = new Set();
          for (const [memberName, m] of Object.entries(members)) {
            if (memberName === 'coordinator' || !m || typeof m !== 'object') continue;
            const swarmKey = `swarm:${cid}:${memberName}`;
            const existing = Array.from(this.items.values()).find((x) => x.swarmKey === swarmKey);
            const isMonitor = isMonitorMemberName(memberName);
            const cachedState = memberStateMap.get(memberName);
            const isKilled = cachedState ? cachedState.isKilled : Boolean(
              m.killed ||
              String(m.phase || '').toUpperCase() === 'KILLED' ||
              String(m.desired_state || '').toUpperCase() === 'KILLED'
            );

            if (isMonitor || isKilled) {
              this.pendingSwarmSpawns.delete(swarmKey);
              if (isMonitor && m.conversation_id) {
                this.childConversations.add(m.conversation_id);
              }
              if (!isMonitor && isKilled) {
                this.retiredKeys.add(swarmKey);
              }
              if (existing) {
                this._finishAndRemove(existing.id, { permanent: !isMonitor && isKilled, silent: true });
                dirty = true;
              }
              continue;
            }

            seenMemberKeys.add(swarmKey);

            const tp = cachedState?.tp ?? this._resolveMemberTranscriptPath(brainRoot, m.conversation_id);

            const roleLabel = m.role || (m.model ? String(m.model).split('/').pop() : 'Worker');
            if (m.conversation_id && tp && fs.existsSync(tp)) {
              this.knownConvMeta.set(m.conversation_id, {
                parentConversationId: cid,
                transcriptPath: tp,
                name: memberName,
                rawRole: roleLabel,
                source: 'swarm',
                typeName: 'swarm_worker',
              });
              this.childConversations.add(m.conversation_id);
              if (!this.watcher.has(m.conversation_id)) {
                this.watcher.attach(m.conversation_id, tp, { maxInitialBytes: 65536 });
              }
            }

            const isWorkingOnHost = Boolean(
              cachedState
                ? cachedState.isWorkingOnHost
                : (
                  String(m.phase || '').toUpperCase() === 'RUNNING' &&
                  (m.wake_mode === 'working' || this._isSwarmTranscriptBusyWithBgTask(tp))
                )
            );

            const latestPost = boardInfo.latestByAgent.get(memberName);

            if (isWorkingOnHost) {
              this.pendingSwarmSpawns.delete(swarmKey);
              this.retiredKeys.delete(swarmKey);
              if (m.conversation_id) {
                this.retiredKeys.delete(m.conversation_id);
              }

              const item = this._ensureSwarmMember(cid, memberName, {
                conversationId: m.conversation_id,
                transcriptPath: tp,
                role: roleLabel,
              });
              if (!item) continue;

              if (item.status === 'WAITING' || item.status === 'DONE') {
                item.status = 'WORKING';
                item.progressText = latestPost
                  ? `#${latestPost.seq}: ${latestPost.text.slice(0, 34)}`
                  : '已唤醒 · 执行任务中';
                item.updatedAt = now;
                dirty = true;
              }
              if (latestPost && item.lastBoardSeq !== latestPost.seq) {
                item.lastBoardSeq = latestPost.seq;
                item.progressText = `#${latestPost.seq}: ${latestPost.text.slice(0, 34)}`;
                item.progressPercent = Math.min(95, Math.max(item.progressPercent || 30, 88));
                item.updatedAt = now;
                dirty = true;
              }
            } else {
              const refTs = this.pendingSwarmSpawns.get(swarmKey) || existing?.createdAt || 0;
              if (now - refTs > 5000) {
                this.pendingSwarmSpawns.delete(swarmKey);
                if (existing) {
                  this._finishAndRemove(existing.id, { permanent: false, silent: true });
                  dirty = true;
                }
              }
            }
          }

          // 5. Prune stale swarm pets not yet in `members.json`, respecting the 60s spawn grace window (never blacklist!)
          for (const tracked of Array.from(this.items.values())) {
            if (tracked.parentConversationId !== cid || tracked.source !== 'swarm') continue;
            if (!seenMemberKeys.has(tracked.swarmKey)) {
              const pendingAt = this.pendingSwarmSpawns.get(tracked.swarmKey) || 0;
              if (pendingAt > 0 && now - pendingAt < 60000) {
                continue;
              }
              this.pendingSwarmSpawns.delete(tracked.swarmKey);
              this._finishAndRemove(tracked.id, { permanent: false, silent: true });
              dirty = true;
            }
          }
        } catch { /* ignore transient file lock */ }
      }

      if (!foundMembersForCid) {
        for (const tracked of Array.from(this.items.values())) {
          if (tracked.parentConversationId !== cid || tracked.source !== 'swarm') continue;
          const pendingAt = this.pendingSwarmSpawns.get(tracked.swarmKey) || 0;
          if (pendingAt > 0 && now - pendingAt < 60000) continue;
          if (now - tracked.createdAt >= 60000) {
            this.pendingSwarmSpawns.delete(tracked.swarmKey);
            this._finishAndRemove(tracked.id, { permanent: false, silent: true });
            dirty = true;
          }
        }
      }
    }

    // B. Poll non-Swarm Subagents & Teamwork (`progress.md` / `handoff.md`)
    const defaultWs = this.getMainSettings?.()?.defaultWorkspace || '';

    for (const it of Array.from(this.items.values())) {
      if (it.source === 'test' || it.source === 'swarm') continue;

      // 1. Reap unbound hook items that never materialized into a subagent within 45s
      if (!it.childConversationId && now - it.createdAt > 45000) {
        this._finishAndRemove(it.id, { silent: true });
        dirty = true;
        continue;
      }

      // 2. Check transcript completion (NEVER kill mid-generation! Only safety-reap after 20 min of total silence)
      if (it.transcriptPath && fs.existsSync(it.transcriptPath) && now - it.createdAt > 3000) {
        if (!this._hasActiveDescendants(it.childConversationId)) {
          const act = inspectTranscriptActivity(it.transcriptPath, it.teamworkDir);
          if (!act.activelyWorking) {
            this._finishAndRemove(it.id, { silent: true });
            dirty = true;
            continue;
          }
          if (now - Math.max(it.updatedAt, act.mtimeMs) > 20 * 60 * 1000) {
            this._finishAndRemove(it.id, { silent: true });
            dirty = true;
            continue;
          }
        }
      }

      // 3. Teamwork `handoff.md` completion & `progress.md` checklist percentage sync
      if (it.source === 'teamwork' && it.teamworkFolder) {
        const candidateDirs = [];
        if (it.teamworkDir) candidateDirs.push(it.teamworkDir);
        if (defaultWs) {
          candidateDirs.push(path.join(defaultWs, '.agents', 'teamwork', it.teamworkFolder));
          candidateDirs.push(path.join(path.dirname(defaultWs), '.agents', 'teamwork', it.teamworkFolder));
        }

        for (const dir of candidateDirs) {
          if (!dir || !fs.existsSync(dir)) continue;
          const handoffPath = path.join(dir, 'handoff.md');
          if (fs.existsSync(handoffPath) && !this._hasActiveDescendants(it.childConversationId)) {
            this._finishAndRemove(it.id, { permanent: true, silent: true });
            dirty = true;
            break;
          }
          const progressPath = path.join(dir, 'progress.md');
          if (fs.existsSync(progressPath)) {
            try {
              const md = fs.readFileSync(progressPath, 'utf8');
              const checked = md.match(/^\s*-\s*\[x\]\s*(.+)$/gim) || [];
              const unchecked = md.match(/^\s*-\s*\[\s\]\s*(.+)$/gim) || [];
              const total = checked.length + unchecked.length;
              if (total > 0) {
                const pct = Math.max(15, Math.min(95, Math.round((checked.length / total) * 100)));
                if (it.progressPercent !== pct) {
                  it.hasChecklistProgress = true;
                  it.progressPercent = pct;
                  dirty = true;
                }
                if (unchecked.length > 0 && !it.lastToolName) {
                  const currentStep = unchecked[0].replace(/^\s*-\s*\[\s\]\s*/, '').trim();
                  it.progressText = `${currentStep.slice(0, 36)}`;
                  dirty = true;
                }
              }
            } catch { /* ignore */ }
          }
          break;
        }
      }
    }

    if (dirty) {
      this.onChange();
    }
  }

  dispose() {
    clearInterval(this.pollTimer);
    for (const it of this.items.values()) {
      if (it.retireTimer) clearTimeout(it.retireTimer);
    }
    this.items.clear();
  }
}

module.exports = { SubagentTracker, extractSubagentIdentity, inspectTranscriptActivity, inspectSwarmBoard, isMonitorMemberName };
