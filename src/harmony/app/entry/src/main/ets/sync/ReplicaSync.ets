import { BackupAccess } from '../backup/BackupAccess';
import { SkillBundle } from './SkillBundle';
import { BoundSecret } from '../store/BoundSecret';
import { ChatRuns } from '../local/ChatRun';
import { taskStatus } from '../store/TaskStatus';
import { ConfigReplica } from './ConfigReplica';
import { FileReplica } from './FileReplica';
import { MiscReplica } from './MiscReplica';
import { ReplicaAssets, ReplicaAsset } from './ReplicaAssets';
import { SessionReplica } from './SessionReplica';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';
import { SecretStore } from '../store/SecretStore';
import { soulStore } from '../store/SoulStore';
import { memoryStore } from '../store/MemoryStore';
import { skillStore, LocalSkill } from '../store/SkillStore';
import { ReplicaPage, ReplicaChange, ReplicaRecord, PortableValue, decodeReplicaPage, normalizeReplicaRoot, recordKey, replicaDate, replicaText, textValue } from './SyncProtocol';

export class ReplicaConfig {
  secretRef: string = '';
  automatic: boolean = false;
  root: string = '';
  deviceId: string = '';
}
class ReplicaCredentials { root: string = ''; deviceId: string = ''; token: string = ''; }
class ReplicaState {
  scope: string = '';
  replicaId: string = '';
  cursor: number = 0;
  records: Record<string, ReplicaChange> = {};
  lastRecords: Record<string, ReplicaRecord> = {};
  pending: ReplicaChange[] = [];
  revision: number = 0;
  applied: Record<string, string> = {};
  materialized: Record<string, boolean> = {};
  localContent: Record<string, string> = {};
  pendingPageRaw: string = '';
  domainErrors: Record<string, string> = {};
  quarantine: Record<string, string> = {};
  cursorReplicaId: string = '';
  lastCursors: Record<string, number> = {};
}
export class ReplicaConflict { key: string = ''; title: string = ''; hasRemote: boolean = false; reason: string = ''; }
export class SyncResult { received: number = 0; sent: number = 0; retained: number = 0; cursor: number = 0; waiting: number = 0; }

/** 对接已有 Mac sync-replica-v1，独立设备 grant，永不回落到中继密钥。 */
export class ReplicaSync {
  private static busy: boolean = false;
  private static foregroundContext: common.Context | null = null;
  private static automaticTimer: number = -1;

  static loadConfig(context: common.Context): ReplicaConfig {
    const path = `${context.filesDir}/sync-config.json`;
    return fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as ReplicaConfig : new ReplicaConfig();
  }

  static async saveConfig(context: common.Context, root: string, deviceId: string, token: string): Promise<void> {
    const lease = BackupAccess.beginExecution(context);
    try {
      if (ReplicaSync.busy) throw new Error('同步中，请稍后修改连接');
      const config = new ReplicaConfig(); config.root = normalizeReplicaRoot(root); config.deviceId = deviceId.trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(config.deviceId) || token.trim().length < 16 || token.trim().length > 8192 || /[\r\n]/.test(token.trim())) throw new Error('请填写已配对设备 ID 和同步授权令牌');
      const secret = new ReplicaCredentials(); secret.root = config.root; secret.deviceId = config.deviceId; secret.token = token.trim();
      let previous: ReplicaConfig | null = null; try { previous = ReplicaSync.loadConfig(context); } catch (_error) {}
      config.automatic = previous?.automatic === true && previous.root === config.root && previous.deviceId === config.deviceId;
      config.secretRef = await BoundSecret.stage(JSON.stringify(['sync', config.root, config.deviceId]), secret.token);
      atomicWriteText(`${context.filesDir}/sync-config.json`, JSON.stringify(config));
      if (previous?.secretRef && previous.secretRef !== config.secretRef) await BoundSecret.retire(previous.secretRef).catch(() => {});
    } finally { lease.release(); }
  }

  static async run(context: common.Context): Promise<SyncResult> {
    if (ReplicaSync.busy) throw new Error('同步已经在进行');
    if (ChatRuns.anyActive() || taskStatus.running || taskStatus.pendingWrite) throw new Error('请先完成运行中和待批准的任务，再同步跨端数据');
    const lease = BackupAccess.beginExecution(context); ReplicaSync.busy = true;
    try {
      const config = ReplicaSync.loadConfig(context); config.root = normalizeReplicaRoot(config.root);
      const secret = await ReplicaSync.credentials(config);
      if (secret.root !== config.root || secret.deviceId !== config.deviceId) throw new Error('同步凭据与目标不匹配，请重新配对');
      const state = ReplicaSync.loadState(context, config);
      const result = new SyncResult();
      const transfers = new ReplicaAssets(context, config.root, config.deviceId, secret.token);
      // 先读入远端胜者，再建立本机变更票据。游标和完整镜像在同一个原子文件提交。
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const raw = state.pendingPageRaw || await ReplicaSync.request(config, secret.token, `/sync/v1/changes?after=${state.cursor}&limit=100`);
        const page = decodeReplicaPage(raw, state.cursor, state.replicaId);
        if (state.cursorReplicaId && state.cursorReplicaId !== page.replicaId) {
          state.lastCursors = {}; state.applied = {}; state.localContent = {};
        }
        state.cursorReplicaId = page.replicaId; state.pendingPageRaw = raw;
        ReplicaSync.saveState(context, state);
        for (let i = 0; i < page.quarantine.length; i++) {
          const skipped = page.quarantine[i]; state.quarantine[page.replicaId + '/' + skipped.cursor] = skipped.id + ' ' + skipped.reason; result.retained += 1;
        }
        for (let i = 0; i < page.changes.length; i++) {
          const incoming = page.changes[i].change;
          const key = recordKey(incoming.id);
          if ((state.lastCursors[key] ?? -1) >= page.changes[i].cursor) continue;
          // 日志只包含副本确认的胜者；后续游标也可能是同发送者时钟回拨后的更高 revision。
          try { await ReplicaSync.apply(context, state, incoming, transfers); }
          catch (error) { state.domainErrors[key] = (error as Error).name === 'SyntaxError' ? 'JSON字段格式无效' : (error as Error).message; }
          if (incoming.record) state.lastRecords[key] = incoming.record;
          state.records[key] = incoming; state.lastCursors[key] = page.changes[i].cursor; result.received += 1;
          if (!ReplicaSync.mapped(incoming.id.type)) result.retained += 1;
        }
        state.cursor = page.nextCursor; state.replicaId = page.replicaId; state.pendingPageRaw = '';
        ReplicaSync.saveState(context, state);
        if (!page.hasMore) break;
        if (pageIndex === 99) throw new Error('已同步 100 页，请继续同步剩余内容');
      }
      // 依赖顺序可能跨页，完整镜像持久化后再收敛尚未应用的业务记录。
      const domainKeys = Object.keys(state.records);
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < domainKeys.length; i++) {
          const change = state.records[domainKeys[i]];
          if (state.applied[domainKeys[i]] !== change.changeId) {
            try { await ReplicaSync.apply(context, state, change, transfers); }
            catch (error) { state.domainErrors[domainKeys[i]] = (error as Error).name === 'SyntaxError' ? 'JSON字段格式无效' : (error as Error).message; }
          }
        }
      }
      await FileReplica.relink(context);
      await ReplicaSync.capture(context, state, transfers, config.deviceId);
      ReplicaSync.saveState(context, state);
      while (state.pending.length > 0) {
        const change = state.pending[0];
        const body = JSON.stringify({ changes: [change] });
        const raw = await ReplicaSync.request(config, secret.token, '/sync/v1/changes', body, change.changeId);
        const response = JSON.parse(raw) as Record<string, Object>;
        const receipts = response['receipts'] as Record<string, Object>[];
        if (!Array.isArray(receipts) || receipts.length !== 1 || receipts[0]['changeId'] !== change.changeId || receipts[0]['revision'] !== change.revision) throw new Error('同步回执与提交票据不一致');
        if (receipts[0]['status'] !== 'stored') throw new Error('远端已有较新修改，本机版本已保留，请核对后重试');
        if (change.record) state.lastRecords[recordKey(change.id)] = change.record;
        state.records[recordKey(change.id)] = change; state.applied[recordKey(change.id)] = change.changeId;
        state.pending.shift(); ReplicaSync.saveState(context, state); result.sent += 1;
      }
      result.cursor = state.cursor;
      const waiting: Set<string> = new Set(state.pending.map((entry: ReplicaChange) => recordKey(entry.id)));
      const recordKeys = Object.keys(state.records);
      for (let i = 0; i < recordKeys.length; i++) if (ReplicaSync.mapped(state.records[recordKeys[i]].id.type) && state.applied[recordKeys[i]] !== state.records[recordKeys[i]].changeId) waiting.add(recordKeys[i]);
      result.waiting = waiting.size;
      await Promise.all([soulStore.load(context), memoryStore.load(context), skillStore.load(context)]);
      return result;
    } finally { ReplicaSync.busy = false; lease.release(); }
  }

  static startForeground(context: common.Context): void {
    ReplicaSync.stopForeground(); ReplicaSync.foregroundContext = context;
    ReplicaSync.automaticTimer = setInterval(() => { ReplicaSync.automaticTick().catch(() => {}); }, 60000);
    ReplicaSync.automaticTick().catch(() => {});
  }
  static stopForeground(): void {
    if (ReplicaSync.automaticTimer >= 0) clearInterval(ReplicaSync.automaticTimer);
    ReplicaSync.automaticTimer = -1; ReplicaSync.foregroundContext = null;
  }
  static async setAutomatic(context: common.Context, enabled: boolean): Promise<void> {
    const lease = BackupAccess.beginExecution(context);
    try {
      if (ReplicaSync.busy && enabled) throw new Error('同步中，请稍后开启自动同步');
      const config = ReplicaSync.loadConfig(context); config.root = normalizeReplicaRoot(config.root);
      if (enabled) {
        const credentials = await ReplicaSync.credentials(config);
        if (credentials.root !== config.root || credentials.deviceId !== config.deviceId) throw new Error('请先保存有效同步连接');
      }
      config.automatic = enabled; atomicWriteText(context.filesDir + '/sync-config.json', JSON.stringify(config));
      if (enabled && ReplicaSync.foregroundContext) ReplicaSync.automaticTick().catch(() => {});
    } finally { lease.release(); }
  }
  static automaticStatus(context: common.Context): string {
    const path = context.filesDir + '/sync-health.json';
    if (!fileIo.accessSync(path)) return '';
    const health = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>; const config = ReplicaSync.loadConfig(context);
    return health['scope'] === config.root + '|' + config.deviceId ? `${health['message'] ?? ''}` : '';
  }
  private static async automaticTick(): Promise<void> {
    const context = ReplicaSync.foregroundContext;
    if (!context || ReplicaSync.busy || ChatRuns.anyActive() || taskStatus.running || taskStatus.pendingWrite) return;
    const config = ReplicaSync.loadConfig(context); if (!config.automatic) return;
    const health: Record<string, Object> = {}; health['scope'] = config.root + '|' + config.deviceId; health['at'] = Date.now();
    try { const result = await ReplicaSync.run(context); health['message'] = result.waiting ? `自动同步有 ${result.waiting} 项待处理` : '前台自动同步已完成'; }
    catch (error) { health['message'] = `自动同步需要处理，${(error as Error).message}`; }
    atomicWriteText(context.filesDir + '/sync-health.json', JSON.stringify(health));
  }
  static issues(context: common.Context): string[] {
    const state = ReplicaSync.loadState(context, ReplicaSync.loadConfig(context)); const output = Object.keys(state.quarantine).map((key: string) => state.quarantine[key]);
    const keys = Object.keys(state.records);
    for (let i = 0; i < keys.length; i++) {
      const change = state.records[keys[i]];
      if (!ReplicaSync.mapped(change.id.type)) output.push(keys[i] + '，扩展类型已保留');
      else if (state.applied[keys[i]] !== change.changeId) output.push(keys[i] + '，' + (state.domainErrors[keys[i]] ?? '等待配置、授权或依赖内容'));
    }
    return output;
  }

  static pending(context: common.Context): ReplicaConflict[] {
    const config = ReplicaSync.loadConfig(context); const state = ReplicaSync.loadState(context, config);
    return state.pending.map((change: ReplicaChange) => {
      const row = new ReplicaConflict(); row.key = recordKey(change.id); row.hasRemote = state.records[row.key] !== undefined;
      row.reason = state.domainErrors[row.key] ?? '本机变更尚未得到同步副本确认';
      row.title = change.record ? (replicaText(change.record, 'title') || replicaText(change.record, 'label') || replicaText(change.record, 'name') || change.id.id) : change.id.id;
      return row;
    });
  }

  static async resolve(context: common.Context, key: string, preferRemote: boolean): Promise<void> {
    if (ReplicaSync.busy || ChatRuns.anyActive() || taskStatus.running || taskStatus.pendingWrite) throw new Error('请等待当前任务完成');
    const lease = BackupAccess.beginExecution(context); ReplicaSync.busy = true;
    try {
      const config = ReplicaSync.loadConfig(context); const state = ReplicaSync.loadState(context, config);
      const pending = state.pending.find((change: ReplicaChange) => recordKey(change.id) === key);
      if (!pending) throw new Error('这条记录已经处理');
      const secret = await ReplicaSync.credentials(config);
      if (secret.root !== config.root || secret.deviceId !== config.deviceId) throw new Error('同步授权已改变');
      const transfers = new ReplicaAssets(context, config.root, config.deviceId, secret.token);
      if (preferRemote) {
        const winner = state.records[key]; if (!winner) throw new Error('尚未收到远端版本');
        state.pending = state.pending.filter((change: ReplicaChange) => recordKey(change.id) !== key);
        const nextApplied: Record<string, string> = {}; const appliedKeys = Object.keys(state.applied);
        for (let i = 0; i < appliedKeys.length; i++) if (appliedKeys[i] !== key) nextApplied[appliedKeys[i]] = state.applied[appliedKeys[i]];
        state.applied = nextApplied;
        await ReplicaSync.apply(context, state, winner, transfers, true);
        if (state.applied[key] !== winner.changeId) throw new Error('远端记录仍缺少依赖，请先重新同步');
      } else {
        const working = JSON.parse(JSON.stringify(state)) as ReplicaState;
        working.pending = working.pending.filter((change: ReplicaChange) => recordKey(change.id) !== key);
        const nextContent: Record<string, string> = {}; const contentKeys = Object.keys(working.localContent);
        for (let i = 0; i < contentKeys.length; i++) if (contentKeys[i] !== key) nextContent[contentKeys[i]] = working.localContent[contentKeys[i]];
        working.localContent = nextContent;
        await ReplicaSync.capture(context, working, transfers, config.deviceId);
        let replacement = working.pending.find((change: ReplicaChange) => recordKey(change.id) === key);
        if (!replacement) { replacement = new ReplicaChange(); replacement.id = pending.id; replacement.operation = 'delete'; }
        replacement.changeId = util.generateRandomUUID(); replacement.revision = ++state.revision; replacement.updatedAt = replicaDate(Date.now());
        if (replacement.record) { replacement.record.updatedAt = replacement.updatedAt; const field = new PortableValue(); field.t = 'date'; field.v = replacement.updatedAt; replacement.record.fields['updatedAt'] = field; }
        state.pending = state.pending.filter((change: ReplicaChange) => recordKey(change.id) !== key).concat([replacement]);
        state.localContent[key] = working.localContent[key] ?? '';
      }
      ReplicaSync.saveState(context, state);
      await Promise.all([soulStore.load(context), memoryStore.load(context), skillStore.load(context)]);
    } finally { ReplicaSync.busy = false; lease.release(); }
  }

  static resetCursor(context: common.Context): void {
    const lease = BackupAccess.beginExecution(context);
    try {
      if (ReplicaSync.busy) throw new Error('同步中无法重置游标');
      const state = ReplicaSync.loadState(context, ReplicaSync.loadConfig(context));
      state.cursor = 0; state.replicaId = ''; state.pendingPageRaw = ''; ReplicaSync.saveState(context, state);
    } finally { lease.release(); }
  }

  private static async credentials(config: ReplicaConfig): Promise<ReplicaCredentials> {
    if (config.secretRef) {
      const token = await BoundSecret.read(config.secretRef, JSON.stringify(['sync', config.root, config.deviceId]));
      if (!token) throw new Error('同步授权不可用，请重新配对');
      const result = new ReplicaCredentials(); result.root = config.root; result.deviceId = config.deviceId; result.token = token; return result;
    }
    const raw = await SecretStore.read(`leo.harmony.sync.${config.deviceId}`); if (!raw) throw new Error('请先保存同步授权');
    return JSON.parse(raw) as ReplicaCredentials;
  }

  private static mapped(type: string): boolean { return type === 'SoulV2' || type === 'MemoryGlobalV2' || type === 'SkillV2' || SessionReplica.supported(type) || ConfigReplica.supported(type) || FileReplica.supported(type) || MiscReplica.supported(type); }

  private static loadState(context: common.Context, config: ReplicaConfig): ReplicaState {
    const scope = `${config.root}|${config.deviceId}`;
    const path = `${context.filesDir}/sync-state.json`;
    if (fileIo.accessSync(path)) {
      const state = JSON.parse(fileIo.readTextSync(path)) as ReplicaState;
      if (state.scope === scope) { state.applied = state.applied ?? {}; state.materialized = state.materialized ?? {}; state.lastRecords = state.lastRecords ?? {}; state.pendingPageRaw = state.pendingPageRaw ?? ''; state.domainErrors = state.domainErrors ?? {}; state.quarantine = state.quarantine ?? {}; state.cursorReplicaId = state.cursorReplicaId ?? state.replicaId; state.lastCursors = state.lastCursors ?? {}; return state; }
    }
    const state = new ReplicaState(); state.scope = scope; return state;
  }

  private static saveState(context: common.Context, state: ReplicaState): void {
    atomicWriteText(`${context.filesDir}/sync-state.json`, JSON.stringify(state));
  }

  private static async apply(context: common.Context, state: ReplicaState, change: ReplicaChange, transfers: ReplicaAssets, force: boolean = false): Promise<void> {
    const type = change.id.type;
    const domainKey = recordKey(change.id);
    if (!force && state.applied[domainKey] === change.changeId) return;
    if (!force && state.pending.some((entry: ReplicaChange) => recordKey(entry.id) === domainKey)) return;
    const previousRecord = state.records[domainKey]?.record ?? state.lastRecords[domainKey];
    if (change.record) {
      const names = Object.keys(change.record.assets);
      for (let i = 0; i < names.length; i++) await transfers.download(change.record.assets[names[i]] as ReplicaAsset);
    }
    if (ConfigReplica.supported(type)) {
      const source = change.record ?? previousRecord;
      const current = source ? await ConfigReplica.localFingerprint(context, source) : '';
      const groupMerge = type === 'ProviderModelGroupV3';
      const localChanged = state.localContent[domainKey] !== undefined && current.length > 0 && current !== state.localContent[domainKey];
      if (!force && !groupMerge && localChanged) return;
      if (!force && !groupMerge && state.localContent[domainKey] === undefined && current && ConfigReplica.localUpdatedAt(context, type) > change.updatedAt) return;
      let configChange = change;
      if (!change.record && previousRecord) {
        configChange = new ReplicaChange(); configChange.id = change.id; configChange.operation = change.operation;
        configChange.changeId = change.changeId; configChange.updatedAt = change.updatedAt; configChange.record = previousRecord;
      }
      if (await ConfigReplica.apply(context, configChange, state.records, !force && localChanged && ConfigReplica.localUpdatedAt(context, type) > change.updatedAt)) {
        state.applied[domainKey] = change.changeId; state.materialized[domainKey] = true;
        if (change.record) state.localContent[domainKey] = ConfigReplica.fingerprint(change.record);
      }
      return;
    }
    if (FileReplica.supported(type)) {
      const applied = await FileReplica.apply(context, change, transfers, force);
      const version = type === 'ArtifactVersionV2' ? await MiscReplica.applyVersion(context, change, transfers) : true;
      if (applied && version) {
        state.applied[domainKey] = change.changeId; state.materialized[domainKey] = true;
        if (change.record) state.localContent[domainKey] = ReplicaSync.fileFingerprint(change.record);
      }
      return;
    }
    if (MiscReplica.supported(type)) {
      let domainChange = change;
      if (!change.record && previousRecord) {
        domainChange = new ReplicaChange(); domainChange.id = change.id; domainChange.operation = change.operation;
        domainChange.changeId = change.changeId; domainChange.updatedAt = change.updatedAt; domainChange.record = previousRecord;
      }
      if (await MiscReplica.apply(context, domainChange)) {
        state.applied[domainKey] = change.changeId; state.materialized[domainKey] = true;
        if (change.record) state.localContent[domainKey] = ReplicaSync.miscFingerprint(change.record);
      }
      return;
    }
    if (SessionReplica.supported(type)) {
      const key = recordKey(change.id);
      if (state.pending.some((entry: ReplicaChange) => recordKey(entry.id) === key)) return;
      const previous = state.records[key];
      const source = change.record ?? previous?.record ?? previousRecord;
      const local = source ? await SessionReplica.localFingerprint(context, source) : '';
      const unchanged = force || (state.localContent[key] !== undefined && local === state.localContent[key]);
      if (!force && state.localContent[key] !== undefined && local && !unchanged) return;
      const applied = type === 'MessageV2' && change.operation === 'delete' && previousRecord ?
        await SessionReplica.deleteMessage(context, change.id.id, previousRecord) : await SessionReplica.apply(context, change, unchanged, state.records);
      if (applied) { state.applied[key] = change.changeId; state.materialized[key] = true; }
      if (applied && change.record) state.localContent[key] = SessionReplica.fingerprint(change.record, context);
      else if (applied) state.localContent[key] = '';
      return;
    }
    if (!ReplicaSync.mapped(type)) return;
    if (change.record && change.record.minimumCompatibleVersion > 1) return;
    const key = recordKey(change.id);
    if (state.pending.some((entry: ReplicaChange) => recordKey(entry.id) === key)) return;
    if (type === 'SkillV2') {
      const path = `${context.filesDir}/skills.json`;
      const skills = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as LocalSkill[] : [];
      const existing = skills.find((skill: LocalSkill) => skill.id === change.id.id);
      if (!force && existing && (state.localContent[key] === undefined || state.localContent[key] !== ReplicaSync.skillContent(existing))) return;
      const next = skills.filter((skill: LocalSkill) => skill.id !== change.id.id);
      if (change.operation !== 'delete' && change.record) {
        const skill = new LocalSkill(); skill.id = change.id.id; skill.name = replicaText(change.record, 'name');
        skill.body = replicaText(change.record, 'bodyText');
        if (!skill.name || !skill.body) return;
        const enabled = change.record.fields['isEnabled']; skill.enabled = !enabled || enabled.v !== 0;
        const bundle = change.record.assets['bundleAsset'] as ReplicaAsset | undefined;
        if (bundle) {
          if (existing?.bundleHash === bundle.sha256 && existing.body === skill.body && existing.bundleDirectory) { skill.bundleDirectory = existing.bundleDirectory; skill.bundleHash = existing.bundleHash; }
          else {
            const source = await transfers.download(bundle); const installed = await SkillBundle.install(context, source, skill.body);
            skill.bundleDirectory = installed.directory; skill.bundleHash = bundle.sha256;
          }
        } else if (existing) { skill.bundleDirectory = existing.bundleDirectory; skill.bundleHash = existing.bundleHash; }
        next.push(skill);
      }
      atomicWriteText(path, JSON.stringify(next));
      const committed = next.find((skill: LocalSkill) => skill.id === change.id.id); state.localContent[key] = committed ? ReplicaSync.skillContent(committed) : ''; state.applied[key] = change.changeId; state.materialized[key] = true; return;
    }
    const relative = type === 'SoulV2' ? 'SOUL.md' : 'memory/GLOBAL.md';
    const path = `${context.filesDir}/${relative}`;
    const local = fileIo.accessSync(path) ? fileIo.readTextSync(path) : '';
    const expected = change.operation === 'delete' ? '' : (change.record ? replicaText(change.record, 'contentMarkdown') : '');
    if (local === expected) { state.localContent[key] = expected; state.applied[key] = change.changeId; state.materialized[key] = true; return; }
    if (!force && state.localContent[key] !== undefined && local !== state.localContent[key]) return;
    // 首次连接也保留本机较新的编辑，交给服务端既有冲突规则决定。
    if (!force && fileIo.accessSync(path) && state.localContent[key] === undefined && replicaDate(fileIo.statSync(path).mtime * 1000) >= change.updatedAt) return;
    if (type === 'MemoryGlobalV2' && !fileIo.accessSync(`${context.filesDir}/memory`)) fileIo.mkdirSync(`${context.filesDir}/memory`);
    const content = change.operation === 'delete' ? '' : (change.record ? replicaText(change.record, 'contentMarkdown') : '');
    atomicWriteText(path, content); state.localContent[key] = content; state.applied[key] = change.changeId; state.materialized[key] = true;
  }

  private static async capture(context: common.Context, state: ReplicaState, transfers: ReplicaAssets, deviceId: string): Promise<void> {
    const types = ['SoulV2', 'MemoryGlobalV2']; const ids = ['soul', 'memory-global']; const paths = ['SOUL.md', 'memory/GLOBAL.md'];
    for (let i = 0; i < types.length; i++) {
      const path = `${context.filesDir}/${paths[i]}`; if (!fileIo.accessSync(path)) continue;
      const content = fileIo.readTextSync(path); if (!content) continue;
      const record = new ReplicaRecord(); record.id.type = types[i]; record.id.id = ids[i];
      record.fields['contentMarkdown'] = textValue(content); record.updatedAt = replicaDate(fileIo.statSync(path).mtime * 1000);
      ReplicaSync.stage(state, record, content);
    }
    await skillStore.load(context);
    if (skillStore.jsonLoadFailed) throw new Error('技能档案读取失败，本次保留远端数据');
    for (let i = 0; i < skillStore.skills.length; i++) {
      const skill = skillStore.skills[i]; const record = new ReplicaRecord(); record.id.type = 'SkillV2'; record.id.id = skill.id;
      record.fields['skillId'] = textValue(skill.id); record.fields['name'] = textValue(skill.name); record.fields['bodyText'] = textValue(skill.body);
      record.fields['description'] = textValue(''); record.fields['version'] = textValue('1'); record.fields['importSource'] = textValue('harmony');
      const enabled = new PortableValue(); enabled.t = 'int'; enabled.v = skill.enabled ? 1 : 0; record.fields['isEnabled'] = enabled;
      if (skill.bundleDirectory) {
        const archive = SkillBundle.archive(context, skill.bundleDirectory);
        if (archive) record.assets['bundleAsset'] = await transfers.upload(archive, 'bundleAsset', 'application/zip');
      }
      record.updatedAt = replicaDate(Date.now()); ReplicaSync.stage(state, record, ReplicaSync.skillContent(skill));
    }
    await MiscReplica.ensureCollectionSession(context);
    const configs = await ConfigReplica.capture(context, state.records);
    for (let i = 0; i < configs.length; i++) ReplicaSync.stage(state, configs[i], ConfigReplica.fingerprint(configs[i]));
    const files = await FileReplica.capture(context, transfers, state.records);
    for (let i = 0; i < files.length; i++) ReplicaSync.stage(state, files[i], ReplicaSync.fileFingerprint(files[i]));
    const sessions = await SessionReplica.capture(context, state.records);
    for (let i = 0; i < sessions.length; i++) ReplicaSync.stage(state, sessions[i], SessionReplica.fingerprint(sessions[i], context));
    const misc = await MiscReplica.capture(context, deviceId, transfers, state.records);
    for (let i = 0; i < misc.length; i++) ReplicaSync.stage(state, misc[i], ReplicaSync.miscFingerprint(misc[i]));
    const owned = configs.concat(files).concat(sessions).concat(misc);
    const sessionKeys = owned.map((record: ReplicaRecord) => recordKey(record.id));
    const keys = Object.keys(state.localContent);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if ((key.startsWith('MemoryGlobalV2:') || key.startsWith('SoulV2:') || key.startsWith('MemoryDailyV2:') || key.startsWith('SyncDeviceV2:') || key.startsWith('ProviderConfigV2:') || key.startsWith('MCPServersV2:') || key.startsWith('EnvVarV2:')) || !state.materialized[key] || !state.localContent[key] || state.pending.some((entry: ReplicaChange) => recordKey(entry.id) === key)) continue;
      const separator = key.indexOf(':'); const type = key.substring(0, separator); const id = key.substring(separator + 1);
      if (type === 'SkillV2' && skillStore.skills.some((skill: LocalSkill) => skill.id === id)) continue;
      if (type !== 'SkillV2' && sessionKeys.indexOf(key) >= 0) continue;
      const change = new ReplicaChange(); change.id.type = type; change.id.id = id;
      change.changeId = util.generateRandomUUID(); change.revision = ++state.revision;
      change.operation = 'delete'; change.updatedAt = replicaDate(Date.now());
      state.pending.push(change); state.localContent[key] = '';
    }
  }

  private static fileFingerprint(record: ReplicaRecord): string {
    const keys = Object.keys(record.fields).filter((key: string) => key !== 'updatedAt').sort();
    const assets = Object.keys(record.assets).sort().map((key: string) => {
      const asset = record.assets[key] as ReplicaAsset; return [key, asset.sha256, asset.size, asset.mimeType ?? ''];
    });
    return JSON.stringify([keys.map((key: string) => [key, record.fields[key]]), assets]);
  }
  private static miscFingerprint(record: ReplicaRecord): string {
    let keys = Object.keys(record.fields).filter((key: string) => key !== 'updatedAt' && key !== 'lastSeen').sort();
    if (record.id.type === 'ArtifactV2') keys = ['title', 'currentVersionId', 'mimeType', 'trashedAt'];
    if (record.id.type === 'CompactMarkerV2') keys = ['summary', 'firstKeptMessageId', 'compactedCount'];
    return JSON.stringify(keys.map((key: string) => [key, record.fields[key] ?? null]));
  }

  private static skillContent(skill: LocalSkill): string { return JSON.stringify(skill.bundleHash ? [skill.name, skill.body, skill.enabled, skill.bundleHash] : [skill.name, skill.body, skill.enabled]); }

  private static stage(state: ReplicaState, record: ReplicaRecord, content: string): void {
    const key = recordKey(record.id); if (state.localContent[key] === content || state.pending.some((entry: ReplicaChange) => recordKey(entry.id) === key)) return;
    const date = new PortableValue(); date.t = 'date'; date.v = record.updatedAt; record.fields['updatedAt'] = date;
    const change = new ReplicaChange(); change.changeId = util.generateRandomUUID(); change.revision = ++state.revision;
    change.id = record.id; change.record = record; change.updatedAt = record.updatedAt;
    const previous = state.records[key];
    if (previous?.record && (previous.record.minimumCompatibleVersion ?? 1) > (record.id.type === 'SessionV2' ? 2 : 1)) return;
    if (previous && previous.record) {
      const unknown = Object.keys(previous.record.unknownFields);
      for (let i = 0; i < unknown.length; i++) if (!record.unknownFields[unknown[i]]) record.unknownFields[unknown[i]] = previous.record.unknownFields[unknown[i]];
      const assets = Object.keys(previous.record.assets);
      for (const name of assets) if (!record.assets[name]) record.assets[name] = previous.record.assets[name];
      const keys = Object.keys(previous.record.fields);
      for (let i = 0; i < keys.length; i++) if (!record.fields[keys[i]]) record.fields[keys[i]] = previous.record.fields[keys[i]];
    }
    state.pending.push(change); state.localContent[key] = content; state.materialized[key] = true;
  }

  private static async request(config: ReplicaConfig, token: string, path: string, body: string = '', requestId: string = ''): Promise<string> {
    if (!/^\/sync\/v1\/changes(?:\?after=[0-9]+&limit=100)?$/.test(path)) throw new Error('同步请求路径无效');
    const request = http.createHttp();
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'X-Leo-Device-ID': config.deviceId, 'Content-Type': 'application/json' };
      if (requestId) { headers['X-Request-ID'] = requestId; headers['X-Leo-Request-Id'] = requestId; }
      const response = await request.request(config.root + path, { method: body ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: headers, extraData: body || undefined, connectTimeout: 10000, readTimeout: 20000, maxLimit: 5 * 1024 * 1024, maxRedirects: 0 });
      if (response.responseCode !== 200) throw new Error(`同步请求失败 HTTP ${response.responseCode}`);
      return typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    } finally { request.destroy(); }
  }
}
