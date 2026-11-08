import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import { ApprovalMode, SensitiveToolGate } from '../local/SensitiveToolGate';
import { ActionButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

class ApprovalChoice { mode: ApprovalMode = 'ask'; title: string = ''; detail: string = ''; }
function choices(): ApprovalChoice[] {
  const ask = new ApprovalChoice(); ask.title = '逐项确认'; ask.detail = '执行前展示完整命令或实际参数，由你批准这一次或本会话同一操作。';
  const smart = new ApprovalChoice(); smart.mode = 'smart'; smart.title = '智能批准'; smart.detail = '严格只读的 Linux 查询与非个人资料查询自动执行。联系人、日历、位置、文件等个人资料读取仍需确认，写操作按完整参数授权。';
  const auto = new ApprovalChoice(); auto.mode = 'auto'; auto.title = '全自动'; auto.detail = '按各项设备权限与前台条件自动执行，远控和定时任务使用同一权限规则。邮件发送由独立确认控制。';
  return [ask, smart, auto];
}

@Component
export struct ApprovalPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State mode: ApprovalMode = 'ask';
  @State saving: string = '';
  @State message: string = '';
  @State loadProblem: boolean = false;

  aboutToAppear(): void {
    SensitiveToolGate.load(getContext(this) as common.UIAbilityContext).then(() => {
      this.mode = SensitiveToolGate.currentMode(); this.message = SensitiveToolGate.lastError; this.loadProblem = this.message.length > 0;
    });
  }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '审批方式' })
      Scroll() {
        Column({ space: 14 }) {
          Text('选择适合当前任务的执行方式').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
          Text('授权绑定当前操作、会话和目标。浏览器会话授权按站点隔离。').fontSize(14).lineHeight(21).fontColor(Tokens.secondary).width('100%')
          ForEach(choices(), (row: ApprovalChoice) => {
            Column({ space: 12 }) {
              Text(row.detail).fontSize(14).lineHeight(22).fontColor(Tokens.secondary).width('100%')
              ActionButton({ label: row.title + (this.mode === row.mode ? ' · 当前使用' : ''),
                variant: this.mode === row.mode ? 'primary' : 'secondary', busy: this.saving === row.mode,
                isEnabled: !this.saving && (this.mode !== row.mode || this.loadProblem), onTap: () => this.save(row.mode) })
            }.padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(18)
              .border({ width: this.mode === row.mode ? 1.5 : Tokens.hairline, color: this.mode === row.mode ? Tokens.accent : Tokens.separator })
          }, (row: ApprovalChoice) => row.mode)
          if (this.message) Text(this.message).fontSize(14).fontColor(this.loadProblem ? Tokens.danger : Tokens.secondary).width('100%')
        }.width('100%').constraintSize({ maxWidth: 680 }).padding(Tokens.pagePad)
      }.layoutWeight(1).width('100%').align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  private async save(mode: ApprovalMode): Promise<void> {
    if (this.saving) return; this.saving = mode;
    try {
      await SensitiveToolGate.setMode(getContext(this) as common.UIAbilityContext, mode);
      this.mode = mode; this.loadProblem = false; this.message = '已保存，' + SensitiveToolGate.modeTitle();
    } catch (error) { this.mode = SensitiveToolGate.currentMode(); this.loadProblem = true; this.message = `保存失败，${error}`; }
    finally { this.saving = ''; }
  }
}
