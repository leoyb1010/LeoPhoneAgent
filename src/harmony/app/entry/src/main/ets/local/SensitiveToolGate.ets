import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { atomicWriteText } from '../store/AtomicFile';
import { allowOpenUrl } from './LocalProtocol';
import { SmartShellApproval } from './SmartShellApproval';

export type ApprovalMode = 'ask' | 'smart' | 'auto';
export class SensitiveDecision { allowed: boolean = false; askFirst: boolean = false; reason: string = ''; }
class ApprovalFile { mode: ApprovalMode = 'ask'; fullAuto: boolean = false; }
class Operation { token: string = ''; name: string = ''; resource: string = ''; arguments: string = ''; digest: string = ''; personalRead: boolean = false; }
class OnceGrant { token: string = ''; scope: string = ''; }

/** Grants belong to the displayed operation, owner and resource. Mode changes commit before becoming visible. */
export class SensitiveToolGate {
  static fullAuto: boolean = false;
  static lastError: string = '';
  private static selectedMode: ApprovalMode = 'ask';
  private static context: common.Context | null = null;
  private static operations: Map<string, Operation> = new Map();
  private static once: Map<string, OnceGrant> = new Map();
  private static sessionGrants: Map<string, Set<string>> = new Map();

  static async load(context: common.Context): Promise<void> { SensitiveToolGate.context = context; SensitiveToolGate.refresh(); }

  private static refresh(): void {
    if (!SensitiveToolGate.context) return;
    try {
      const path = SensitiveToolGate.context.filesDir + '/approval.json';
      const body = fileIo.accessSync(path) ? JSON.parse(fileIo.readTextSync(path)) as Record<string, Object> : null;
      const mode = body ? `${body['mode'] ?? ''}` : '';
      SensitiveToolGate.selectedMode = mode === 'smart' ? 'smart' : (mode === 'auto' || (mode.length === 0 && body?.['fullAuto'] === true) ? 'auto' : 'ask');
      SensitiveToolGate.fullAuto = SensitiveToolGate.selectedMode === 'auto'; SensitiveToolGate.lastError = '';
    } catch (error) {
      SensitiveToolGate.selectedMode = 'ask'; SensitiveToolGate.fullAuto = false; SensitiveToolGate.lastError = `审批设置读取失败，已按逐项确认处理，${error}`;
    }
  }

  static currentMode(): ApprovalMode {
    SensitiveToolGate.refresh(); return SensitiveToolGate.fullAuto ? 'auto' : (SensitiveToolGate.selectedMode === 'smart' ? 'smart' : 'ask');
  }

  static async setMode(context: common.Context, mode: ApprovalMode): Promise<void> {
    if (mode !== 'ask' && mode !== 'smart' && mode !== 'auto') throw new Error('审批模式无效');
    const body = new ApprovalFile(); body.mode = mode; body.fullAuto = mode === 'auto';
    SensitiveToolGate.context = context; const before = SensitiveToolGate.currentMode();
    try { atomicWriteText(context.filesDir + '/approval.json', JSON.stringify(body)); }
    catch (error) {
      SensitiveToolGate.refresh();
      if (SensitiveToolGate.currentMode() !== before) AppStorage.setOrCreate('approvalTick', (AppStorage.get<number>('approvalTick') ?? 0) + 1);
      throw error as Error;
    }
    SensitiveToolGate.context = context; SensitiveToolGate.selectedMode = mode; SensitiveToolGate.fullAuto = body.fullAuto; SensitiveToolGate.lastError = '';
    AppStorage.setOrCreate('approvalTick', (AppStorage.get<number>('approvalTick') ?? 0) + 1);
  }
  static async setFullAuto(context: common.Context, on: boolean): Promise<void> { await SensitiveToolGate.setMode(context, on ? 'auto' : 'ask'); }
  static modeTitle(): string { const mode = SensitiveToolGate.currentMode(); return mode === 'auto' ? '全自动' : (mode === 'smart' ? '智能批准' : '逐项确认'); }
  static modeDetail(): string {
    const mode = SensitiveToolGate.currentMode();
    if (mode === 'auto') return '命令、文件和受控手机操作自动执行；邮件发送沿用邮箱独立确认。';
    return mode === 'smart' ? '严格只读的 Linux 查询自动执行，其他受控操作由你确认。' : '受控操作执行前展示真实命令或参数，由你逐项确认。';
  }

  static beginOperation(owner: string, token: string, name: string, raw: string = ''): void {
    const old = SensitiveToolGate.operations.get(owner);
    if (old?.token === token && old.name === name) return;
    SensitiveToolGate.once.delete(owner);
    const operation = new Operation(); operation.token = token; operation.name = name; operation.arguments = raw;
    if (old && old.name === name && old.arguments === raw) { operation.digest = old.digest; operation.personalRead = old.personalRead; }
    SensitiveToolGate.operations.set(owner, operation);
  }
  static setResource(owner: string, resource: string): void {
    const operation = SensitiveToolGate.operations.get(owner); if (!operation) return;
    if (operation.resource !== resource) SensitiveToolGate.once.delete(owner);
    operation.resource = resource;
  }
  static resource(owner: string): string { return SensitiveToolGate.operations.get(owner)?.resource ?? ''; }
  static revokeOperation(owner: string): void { SensitiveToolGate.operations.delete(owner); SensitiveToolGate.once.delete(owner); }

  static async bindArguments(owner: string, name: string, raw: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const operation = SensitiveToolGate.operations.get(owner);
    if (!operation || operation.name !== name || !isCurrent()) return false;
    const hash = cryptoFramework.createMd('SHA256');
    await hash.update({ data: new util.TextEncoder().encodeInto(raw) });
    if (!isCurrent() || SensitiveToolGate.operations.get(owner) !== operation) return false;
    const bytes = await hash.digest();
    if (!isCurrent() || SensitiveToolGate.operations.get(owner) !== operation) return false;
    let digest = ''; for (const byte of bytes.data) digest += byte.toString(16).padStart(2, '0');
    if (operation.arguments && operation.arguments !== raw) SensitiveToolGate.once.delete(owner);
    operation.arguments = raw; operation.digest = digest; operation.personalRead = SensitiveToolGate.requiresPersonalRead(name, raw);
    return true;
  }
  static requiresPersonalRead(name: string, raw: string): boolean {
    if (['file_list', 'file_read', 'read_image', 'location', 'clipboard_read', 'photos_list', 'photos_get'].indexOf(name) >= 0) return true;
    if (name.startsWith('contacts_') || name.startsWith('calendar_')) return !/_(create|update|delete|complete)$/.test(name) && !name.endsWith('_status');
    if (name === 'weather') {
      try { const args = JSON.parse(raw) as Record<string, Object>; return typeof args['city'] !== 'string' || !(args['city'] as string).trim(); }
      catch (_error) { return true; }
    }
    return false;
  }
  static consumePersonalReadGrant(owner: string, name: string, raw: string): boolean {
    const operation = SensitiveToolGate.operations.get(owner);
    if (!operation || operation.name !== name || operation.arguments !== raw || !operation.digest || !operation.personalRead) return false;
    return SensitiveToolGate.consumeWriteGrant(owner);
  }
  private static scope(owner: string): string {
    const operation = SensitiveToolGate.operations.get(owner); const name = operation?.name ?? 'file_write';
    const category = operation?.personalRead ? 'read' : 'write';
    const target = name === 'browser_use' ? (operation?.resource ?? 'unresolved') : 'sandbox';
    return category + '|' + name + '|' + target + (category === 'write' ? '|' + (operation?.digest || operation?.arguments || 'legacy') : '');
  }
  static hasWriteGrant(owner: string = ''): boolean {
    if (SensitiveToolGate.currentMode() === 'auto') return true;
    const scope = SensitiveToolGate.scope(owner);
    if (SensitiveToolGate.sessionGrants.get(owner)?.has(scope)) return true;
    const grant = SensitiveToolGate.once.get(owner);
    return grant !== undefined && grant.scope === scope && grant.token === (SensitiveToolGate.operations.get(owner)?.token ?? '');
  }
  static grantWriteOnce(owner: string = '', token: string = ''): boolean {
    if (token !== (SensitiveToolGate.operations.get(owner)?.token ?? '')) return false;
    const grant = new OnceGrant(); grant.token = token; grant.scope = SensitiveToolGate.scope(owner); SensitiveToolGate.once.set(owner, grant); return true;
  }
  static grantSession(owner: string, token: string = ''): boolean {
    if (!owner || token !== (SensitiveToolGate.operations.get(owner)?.token ?? '')) return false;
    const grants = SensitiveToolGate.sessionGrants.get(owner) ?? new Set<string>(); grants.add(SensitiveToolGate.scope(owner)); SensitiveToolGate.sessionGrants.set(owner, grants); return true;
  }
  static forgetSession(owner: string): void { SensitiveToolGate.sessionGrants.delete(owner); SensitiveToolGate.revokeOperation(owner); }
  static consumeWriteGrant(owner: string = ''): boolean {
    if (!SensitiveToolGate.hasWriteGrant(owner)) return false;
    if (SensitiveToolGate.currentMode() !== 'auto' && !SensitiveToolGate.sessionGrants.get(owner)?.has(SensitiveToolGate.scope(owner))) SensitiveToolGate.once.delete(owner);
    return true;
  }

  /** Returns the exact approved executed command, including Git's defensive prefix, or null when UI approval is needed. */
  static consumeShellGrant(owner: string, command: string): string | null {
    const prepared = SmartShellApproval.preparedCommand(command);
    if (SensitiveToolGate.currentMode() === 'smart' && SmartShellApproval.isReadOnly(prepared)) return prepared;
    return SensitiveToolGate.consumeWriteGrant(owner) ? command : null;
  }
  static denialMessage(target: string): string { return `用户拒绝了这次操作（${target}），请说明原因并等待新的指令。`; }
  static openUrl(raw: string): SensitiveDecision {
    const result = new SensitiveDecision(); result.reason = allowOpenUrl(raw);
    if (!result.reason) { result.allowed = true; result.reason = '应用内打开'; } return result;
  }
  static readonly UNATTENDED_BLOCKED: string[] = ['open_app_link', 'dial', 'clipboard_write', 'location', 'mcp_call'];
  static unattendedDenial(name: string): string {
    if (SensitiveToolGate.currentMode() === 'auto' || SensitiveToolGate.UNATTENDED_BLOCKED.indexOf(name) < 0) return '';
    return `远程和定时任务当前不能使用 ${name}，请在本机前台操作或调整审批方式。`;
  }
  static fileWrite(): SensitiveDecision {
    const result = new SensitiveDecision(); result.askFirst = SensitiveToolGate.currentMode() !== 'auto'; result.reason = result.askFirst ? '写文件需要确认' : '全自动'; return result;
  }
}
