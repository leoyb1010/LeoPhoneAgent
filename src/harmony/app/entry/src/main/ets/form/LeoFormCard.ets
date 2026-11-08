const formValues: Record<string, Object> = { 'runningCount': 0, 'approvalCount': 0, 'sessionId': '', 'updatedAt': 0 };
const formStorage: LocalStorage = new LocalStorage(formValues);

@Entry(formStorage)
@Component
struct LeoFormCard {
  @LocalStorageProp('runningCount') runningCount: number = 0;
  @LocalStorageProp('approvalCount') approvalCount: number = 0;
  @LocalStorageProp('sessionId') sessionId: string = '';
  @LocalStorageProp('updatedAt') updatedAt: number = 0;

  private headline(): string {
    if (this.approvalCount > 0) return this.approvalCount + ' 项待确认';
    if (this.runningCount > 0) return this.runningCount + ' 项进行中';
    return '随时开始';
  }

  private timestamp(): string {
    if (!this.updatedAt) return '打开查看任务';
    const date = new Date(this.updatedAt);
    return '最近状态 · ' + String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 9 }) {
        Image($r('app.media.app_icon')).width(30).height(30).borderRadius(9)
        Text('LeoBot').fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary')).layoutWeight(1)
      }.width('100%')
      Text(this.headline()).fontSize(22).fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%').layoutWeight(1)
      Text(this.timestamp()).fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary')).width('100%')
    }
    .padding(16).width('100%').height('100%').borderRadius(20)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .accessibilityText('LeoBot，' + this.headline() + '，' + this.timestamp())
    .onClick(() => {
      postCardAction(this, { action: 'router', abilityName: 'EntryAbility',
        params: { openSession: this.sessionId } });
    })
  }
}
