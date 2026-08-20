import { allowOpenUrl } from './LocalProtocol';

export class SensitiveDecision {
  allowed: boolean = false;
  askFirst: boolean = false;
  reason: string = '';
}

export class SensitiveToolGate {
  private static writeGrant: boolean = false;
  // 授权归谁：本机聊天页会传自己的会话 id。
  // 之前这把开关是全进程共享的一个 boolean —— 用户在本机聊天里点了「允许写这次」还没落地时，
  // 如果正好有 iPhone 指挥的回合或定时任务在跑 file_write，那一路会先把授权吃掉并真的写盘，
  // 而它本该是被直接拒绝的。现在按 owner 配对，谁申请的谁才能消费。
  private static writeOwner: string = '';

  static hasWriteGrant(owner: string = ''): boolean {
    return SensitiveToolGate.writeGrant && SensitiveToolGate.writeOwner === owner;
  }

  static grantWriteOnce(owner: string = ''): void {
    SensitiveToolGate.writeGrant = true;
    SensitiveToolGate.writeOwner = owner;
  }

  static consumeWriteGrant(owner: string = ''): boolean {
    if (!SensitiveToolGate.writeGrant || SensitiveToolGate.writeOwner !== owner) {
      return false;
    }
    SensitiveToolGate.writeGrant = false;
    SensitiveToolGate.writeOwner = '';
    return true;
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
    decision.askFirst = true;
    decision.reason = '写文件默认询问';
    return decision;
  }

  static runCommand(): SensitiveDecision {
    const decision = new SensitiveDecision();
    decision.askFirst = true;
    decision.reason = '本机命令默认询问，且只允许看沙箱';
    return decision;
  }
}
