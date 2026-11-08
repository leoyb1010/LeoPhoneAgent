import { common } from '@kit.AbilityKit';
import { ModelGroup, ProviderInstance, providerStore } from '../store/ProviderStore';
import { ActionButton, IconButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

class ModelChoice { id: string = ''; model: string = ''; provider: string = ''; ready: boolean = false; }

@Entry
@Component
struct ModelGroupsPage {
  @StorageProp('themeTick') tick: number = 0;
  @State name: string = '';
  @State editingId: string = '';
  @State picked: string[] = [];
  @State groups: ModelGroup[] = [];
  @State models: ModelChoice[] = [];
  @State strategy: string = 'fallback';
  @State fallback: string = 'limited';
  @State thinking: string = '';
  @State message: string = '';
  @State busy: string = '';
  @State ready: boolean = false;
  @State problem: boolean = false;
  @State confirmDelete: string = '';

  aboutToAppear(): void { this.load(); }

  build() {
    Column() {
      NavBar({ title: '模型组' })
      Scroll() {
        Column({ space: 20 }) {
          Text('为每个对话选好候补').fontSize(26).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
          Text('同一轮固定模型与连接信息。新一轮按所选策略路由，可为不同对话绑定不同模型组。')
            .fontSize(14).lineHeight(22).fontColor(Tokens.secondary).width('100%')
          if (!this.ready) {
            if (!this.problem) LoadingProgress().width(32).height(32).color(Tokens.accent)
            else ActionButton({ label: '重新加载', onTap: () => this.load() })
          } else {
            if (this.groups.length > 0) {
              Column({ space: 12 }) {
                Text('已保存').fontSize(16).fontWeight(FontWeight.Medium).fontColor(Tokens.secondary).width('100%')
                ForEach(this.groups, (row: ModelGroup) => {
                  Column({ space: 12 }) {
                    Row({ space: 12 }) {
                      Column({ space: 4 }) {
                        Text(row.name).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
                        Text(this.groupSummary(row)).fontSize(12).lineHeight(18).fontColor(Tokens.secondary).width('100%')
                      }.layoutWeight(1)
                      IconButton({ icon: 'square_and_pencil', label: '编辑' + row.name,
                        isEnabled: !this.busy, onTap: () => this.edit(row) })
                    }.width('100%')
                    ForEach(row.modelIds, (id: string, index: number) => {
                      Text(`${index + 1}  ${this.modelLabel(id)}`).fontSize(13).lineHeight(20).fontColor(Tokens.secondary).width('100%')
                    }, (id: string) => id)
                    Row({ space: 8 }) {
                      ActionButton({ label: providerStore.activeGroupId === row.id ? '默认模型组' : '设为默认', variant: 'secondary',
                        busy: this.busy === row.id, isEnabled: !this.busy && providerStore.activeGroupId !== row.id,
                        onTap: () => this.makeDefault(row.id) }).layoutWeight(1)
                      IconButton({ icon: 'trash', label: '删除' + row.name, isEnabled: !this.busy,
                        onTap: () => { this.confirmDelete = this.confirmDelete === row.id ? '' : row.id; } })
                    }.width('100%')
                    if (this.confirmDelete === row.id) {
                      Text('删除后，已绑定的对话会要求重新选择模型。').fontSize(13).fontColor(Tokens.secondary).width('100%')
                      ActionButton({ label: '确认删除模型组', variant: 'danger', busy: this.busy === row.id,
                        isEnabled: !this.busy, fullWidth: true, onTap: () => this.remove(row.id) })
                    }
                  }.padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(18)
                    .border({ width: Tokens.hairline, color: Tokens.separator })
                }, (row: ModelGroup) => JSON.stringify(row) + providerStore.activeGroupId)
              }.width('100%')
            }
            Column({ space: 16 }) {
              Row() {
                Text(this.editingId ? '编辑模型组' : '新建模型组').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text).layoutWeight(1)
                if (this.editingId) ActionButton({ label: '取消编辑', variant: 'quiet', fullWidth: false, isEnabled: !this.busy, onTap: () => this.reset() })
              }.width('100%')
              TextInput({ text: this.name, placeholder: '组名，例如 日常工作' }).height(48).fontColor(Tokens.text)
                .backgroundColor(Tokens.surface).borderRadius(12).enabled(!this.busy).onChange((value: string) => { this.name = value; })
              Text('路由方式').fontSize(14).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
              Row({ space: 8 }) {
                ActionButton({ label: '按顺序候补', variant: this.strategy === 'fallback' ? 'primary' : 'secondary', isEnabled: !this.busy, onTap: () => { this.strategy = 'fallback'; } }).layoutWeight(1)
                ActionButton({ label: '按会话均衡', variant: this.strategy === 'loadBalance' ? 'primary' : 'secondary', isEnabled: !this.busy, onTap: () => { this.strategy = 'loadBalance'; } }).layoutWeight(1)
              }.width('100%')
              Text(this.strategy === 'loadBalance' ? '同一对话稳定落到同一首选模型，其他成员继续作为候补。' : '从列表第一项开始，按所选故障范围尝试后续成员。')
                .fontSize(12).lineHeight(18).fontColor(Tokens.secondary).width('100%')
              Column({ space: 8 }) {
                ActionButton({ label: '连接或限流时切换', variant: this.fallback === 'limited' ? 'primary' : 'secondary', isEnabled: !this.busy, onTap: () => { this.fallback = 'limited'; } })
                ActionButton({ label: '全部错误均切换', variant: this.fallback === 'always' ? 'primary' : 'secondary', isEnabled: !this.busy, onTap: () => { this.fallback = 'always'; } })
              }.width('100%')
              Row({ space: 12 }) {
                Text('默认思考强度').fontSize(14).fontColor(Tokens.text).layoutWeight(1)
                Select([{ value: '跟随对话' }, { value: '关闭' }, { value: '低' }, { value: '中' }, { value: '高' }])
                  .selected(this.thinkingIndex()).value(this.thinkingTitle()).height(44).enabled(!this.busy)
                  .onSelect((index: number) => { this.thinking = ['', 'off', 'low', 'medium', 'high'][index]; })
              }.width('100%')
              Text('模型成员 · 选择顺序即候补顺序').fontSize(14).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%')
              if (!this.models.length) Text('先在 AI 服务商中保存模型，再来组合。').fontSize(14).fontColor(Tokens.secondary).width('100%')
              ForEach(this.models, (row: ModelChoice) => {
                Row({ space: 12 }) {
                  Text(this.picked.indexOf(row.id) >= 0 ? `${this.picked.indexOf(row.id) + 1}` : '+')
                    .fontSize(15).fontWeight(FontWeight.Bold).fontColor(this.picked.indexOf(row.id) >= 0 ? '#FFFFFF' : Tokens.secondary)
                    .width(32).height(32).textAlign(TextAlign.Center).backgroundColor(this.picked.indexOf(row.id) >= 0 ? Tokens.accent : Tokens.surface).borderRadius(16)
                  Column({ space: 4 }) {
                    Text(row.model).fontSize(14).fontColor(Tokens.text).width('100%')
                    Text(row.provider + (row.ready ? '' : ' · 尚未登录')).fontSize(12).fontColor(Tokens.secondary).width('100%')
                  }.layoutWeight(1)
                }.width('100%').constraintSize({ minHeight: 60 }).padding({ top: 8, bottom: 8 })
                  .opacity(this.busy ? 0.6 : 1).accessibilityText(row.model + '，' + row.provider + (this.picked.indexOf(row.id) >= 0 ? '，已选择' : '，加入模型组'))
                  .onClick(() => { if (!this.busy) this.toggle(row.id); })
              }, (row: ModelChoice) => row.id)
              ActionButton({ label: this.editingId ? '保存修改' : '保存模型组', fullWidth: true, busy: this.busy === 'save',
                isEnabled: !this.busy && this.picked.length > 0, onTap: () => this.save() })
            }.padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(18)
          }
          if (this.message) Text(this.message).fontSize(14).lineHeight(21).fontColor(this.problem ? Tokens.danger : Tokens.secondary).width('100%')
        }.width('100%').constraintSize({ maxWidth: 720 }).padding(Tokens.pagePad)
      }.layoutWeight(1).width('100%').align(Alignment.Top).scrollBar(BarState.Auto)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)
  }

  private async load(): Promise<void> {
    this.problem = false;
    try { await providerStore.ensureLoaded(getContext(this) as common.UIAbilityContext); this.refresh(); this.ready = true; }
    catch (error) { this.message = `加载失败，${error}`; this.problem = true; }
  }
  private refresh(): void {
    this.groups = providerStore.groups.slice(); const out: ModelChoice[] = [];
    for (let i = 0; i < providerStore.instances.length; i++) {
      const row: ProviderInstance = providerStore.instances[i]; if (!row.enabled) continue;
      const ids = row.models.length ? row.models : [row.model];
      for (let j = 0; j < ids.length; j++) {
        if (!ids[j] || row.deletedModels.indexOf(ids[j]) >= 0 || row.hiddenModels.indexOf(ids[j]) >= 0) continue;
        const choice = new ModelChoice(); choice.id = row.id + '/' + ids[j]; choice.model = ids[j]; choice.provider = row.label || row.type;
        choice.ready = providerStore.keyFor(row.id).length > 0; out.push(choice);
      }
    }
    this.models = out;
  }
  private modelLabel(id: string): string { const row = this.models.find((item: ModelChoice) => item.id === id); return row ? row.model + ' · ' + row.provider : id + ' · 当前不可用'; }
  private groupSummary(row: ModelGroup): string { return (row.strategy === 'loadBalance' ? '按会话均衡' : '按顺序候补') + ' · ' + (row.fallbackStrategy === 'always' ? '全部错误切换' : '连接或限流切换') + ' · ' + row.modelIds.length + ' 个模型'; }
  private thinkingIndex(): number { return Math.max(0, ['', 'off', 'low', 'medium', 'high'].indexOf(this.thinking)); }
  private thinkingTitle(): string { return ['跟随对话', '关闭', '低', '中', '高'][this.thinkingIndex()]; }
  private toggle(id: string): void { this.picked = this.picked.indexOf(id) >= 0 ? this.picked.filter((row: string) => row !== id) : this.picked.concat([id]); }
  private edit(row: ModelGroup): void { this.editingId = row.id; this.name = row.name; this.picked = row.modelIds.slice(); this.strategy = row.strategy; this.fallback = row.fallbackStrategy; this.thinking = row.defaultThinkingLevel; this.message = '正在编辑 ' + row.name; this.problem = false; }
  private reset(): void { this.editingId = ''; this.name = ''; this.picked = []; this.strategy = 'fallback'; this.fallback = 'limited'; this.thinking = ''; }
  private async save(): Promise<void> {
    if (this.busy) return; this.busy = 'save'; this.problem = false;
    try { await providerStore.addGroup(getContext(this) as common.UIAbilityContext, this.name, this.picked.slice(), this.strategy, this.fallback, this.thinking, this.editingId); this.refresh(); this.reset(); this.message = '模型组已保存'; }
    catch (error) { this.problem = true; this.message = `保存失败，${error}`; }
    finally { this.busy = ''; }
  }
  private async makeDefault(id: string): Promise<void> {
    if (this.busy) return; this.busy = id; this.problem = false;
    try { await providerStore.setActiveGroup(getContext(this) as common.UIAbilityContext, id); this.refresh(); this.message = '已设为新对话的默认模型组'; }
    catch (error) { this.problem = true; this.message = `设置失败，${error}`; }
    finally { this.busy = ''; }
  }
  private async remove(id: string): Promise<void> {
    if (this.busy) return; this.busy = id; this.problem = false;
    try { await providerStore.removeGroup(getContext(this) as common.UIAbilityContext, id); this.refresh(); this.confirmDelete = ''; if (this.editingId === id) this.reset(); this.message = '模型组已删除'; }
    catch (error) { this.problem = true; this.message = `删除失败，${error}`; }
    finally { this.busy = ''; }
  }
}
