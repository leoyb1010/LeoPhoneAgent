import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { allowOpenUrl } from './LocalProtocol';

export class SensitiveDecision {
  allowed: boolean = false;
  askFirst: boolean = false;
  reason: string = '';
}

class ApprovalFile {
  fullAuto: boolean = false;
}

/**
 * 审批方式,和 iOS 1.44 同名:「逐项确认」写文件前先问;「全自动」都不问。
 * iOS 的「智能批准」是放行只读命令,鸿蒙没有命令行、读文件本来就不问,所以没有这一档。
 * 按设备存在 approval.json,只有本机用户能开关(设置页、聊天输入框上方、/auto)。
 */
export class SensitiveToolGate {
  static fullAuto: boolean = false;
  private static loaded: boolean = false;
  private static writeGrant: boolean = false;
  // 授权归谁：本机聊天页会传自己的会话 id。
  // 之前这把开关是全进程共享的一个 boolean —— 用户在本机聊天里点了「允许写这次」还没落地时，
  // 如果正好有 iPhone 指挥的回合或定时任务在跑 file_write，那一路会先把授权吃掉并真的写盘，
  // 而它本该是被直接拒绝的。现在按 owner 配对，谁申请的谁才能消费。
  private static writeOwner: string = '';
  /** 「本次会话允许」:这些会话里写文件不再问。 */
  private static sessionGrants: Set<string> = new Set();

  static async load(context: common.Context): Promise<void> {
    if (SensitiveToolGate.loaded) {
      return;
    }
    SensitiveToolGate.loaded = true;
    const path = context.filesDir + '/approval.json';
    try {
      if (!fileIo.accessSync(path)) {
        return;
      }
      const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
      SensitiveToolGate.fullAuto = obj['fullAuto'] === true;
    } catch (_err) {
      SensitiveToolGate.fullAuto = false;
    }
  }

  static async setFullAuto(context: common.Context, on: boolean): Promise<void> {
    SensitiveToolGate.fullAuto = on;
    SensitiveToolGate.loaded = true;
    const body = new ApprovalFile();
    body.fullAuto = on;
    try {
      const file = fileIo.openSync(context.filesDir + '/approval.json',
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(body));
      } finally {
        fileIo.closeSync(file);
      }
    } catch (_err) {
      // 存不下来也照样切换,只是重启后回到原来的方式
    }
    AppStorage.setOrCreate('approvalTick', Date.now());
  }

  static modeTitle(): string {
    return SensitiveToolGate.fullAuto ? '全自动' : '逐项确认';
  }

  static modeDetail(): string {
    return SensitiveToolGate.fullAuto ?
      '不再逐项确认:写文件直接执行,远程和定时任务也能写。' :
      '写文件前先问你;选「本次会话允许」后,这个对话里不再问。';
  }

  static hasWriteGrant(owner: string = ''): boolean {
    return SensitiveToolGate.fullAuto || SensitiveToolGate.sessionGrants.has(owner) ||
      (SensitiveToolGate.writeGrant && SensitiveToolGate.writeOwner === owner);
  }

  static grantWriteOnce(owner: string = ''): void {
    SensitiveToolGate.writeGrant = true;
    SensitiveToolGate.writeOwner = owner;
  }

  static grantSession(owner: string): void {
    if (owner.length > 0) {
      SensitiveToolGate.sessionGrants.add(owner);
    }
  }

  static forgetSession(owner: string): void {
    SensitiveToolGate.sessionGrants.delete(owner);
    if (SensitiveToolGate.writeOwner === owner) {
      SensitiveToolGate.writeGrant = false;
      SensitiveToolGate.writeOwner = '';
    }
  }

  /** 这次写能不能直接做。一次性授权用掉就没了;全自动和本次会话允许不消耗。 */
  static consumeWriteGrant(owner: string = ''): boolean {
    if (SensitiveToolGate.fullAuto || SensitiveToolGate.sessionGrants.has(owner)) {
      return true;
    }
    if (!SensitiveToolGate.writeGrant || SensitiveToolGate.writeOwner !== owner) {
      return false;
    }
    SensitiveToolGate.writeGrant = false;
    SensitiveToolGate.writeOwner = '';
    return true;
  }

  /** 给模型的拒绝回执,和 iOS 同一句话。 */
  static denialMessage(target: string): string {
    return `用户拒绝了「写文件」(${target})。不要重试同一动作,改用人话说明需要许可。`;
  }

  static openUrl(raw: string): SensitiveDecision {
    const decision = new SensitiveDecision();
    const reason = allowOpenUrl(raw);
    if (reason.length > 0) {
      decision.reason = reason;
      return decision;
    }
    decision.allowed = true;
    decision.reason = '应用内打开';
    return decision;
  }

  static fileWrite(): SensitiveDecision {
    const decision = new SensitiveDecision();
    decision.askFirst = !SensitiveToolGate.fullAuto;
    decision.reason = SensitiveToolGate.fullAuto ? '全自动' : '写文件默认询问';
    return decision;
  }
}
