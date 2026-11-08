import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { AppNavigation } from '../navigation/AppNavigation';
import { ShareSegment, SharePage, SharePageLayout, shareSegments, groupShareSegments } from '../chat/TurnShare';
import { ActionButton, NavHeader } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Component
export struct TurnSharePage {
  @StorageProp('themeTick') tick: number = 0;
  @State segments: SharePage[] = [];
  private parts: ShareSegment[] = [];
  @State paths: string[] = [];
  @State busy: boolean = false;
  @State error: string = '';
  private alive: boolean = false;
  aboutToAppear(): void {
    this.alive = true;
    // Only this feature's stale temporary images are eligible; never touch user attachments.
    try {
      const context = getContext(this) as common.UIAbilityContext;
      for (const name of fileIo.listFileSync(context.cacheDir)) {
        const match = /^leobot-turn-(\d+)-\d+\.png$/.exec(name);
        if (match && Date.now() - Number(match[1]) > 24 * 60 * 60 * 1000) {
          try { fileIo.unlinkSync(context.cacheDir + '/' + name); } catch (_error) {}
        }
      }
    } catch (_error) { /* Optional cache cleanup must not block the preview. */ }
    try {
      const params = AppNavigation.getParams();
      this.parts = shareSegments(params.messages ?? []);
      this.segments = this.groupPages();
    } catch (error) { this.error = error instanceof Error ? error.message : '无法读取分享内容，请返回后重新选择这一轮'; }
  }
  aboutToDisappear(): void { this.alive = false; }
  private groupPages(): SharePage[] {
    const ui = this.getUIContext();
    return groupShareSegments(this.parts, SharePageLayout.pageHeight(ui.vp2px(1)), (text: string): number => {
      // API12 MeasureUtils returns px. Match the native Text's exact width, fixed-vp font and line-break options.
      const size = ui.getMeasureUtils().measureTextSize({ textContent: text,
        fontSize: '16vp', lineHeight: '26vp', constraintWidth: '360vp', wordBreak: WordBreak.BREAK_WORD });
      return ui.px2vp(Number(size.height));
    });
  }
  @Builder
  snapshotPage(page: SharePage, index: number) {
    Column({ space: SharePageLayout.gap }) {
      Text(`LeoBot · 对话分享 ${index + 1}/${this.segments.length}`).fontSize('13vp').lineHeight('20vp')
        .fontColor(Tokens.secondary).width('100%')
      ForEach(page.parts, (part: ShareSegment) => {
        Column({ space: SharePageLayout.partGap }) {
          Text(part.label).fontSize('18vp').lineHeight('26vp').fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
          if (part.text) Text(part.text).fontSize('16vp').lineHeight('26vp').wordBreak(WordBreak.BREAK_WORD)
            .fontColor(Tokens.text).width('100%')
          ForEach(part.images, (path: string, imageIndex: number) => {
            Image(path).width(SharePageLayout.imageSize).height(SharePageLayout.imageSize).objectFit(ImageFit.Contain)
          }, (path: string, imageIndex: number) => `${imageIndex}|${path}`)
        }.width('100%')
      }, (part: ShareSegment, partIndex: number) => `${partIndex}|${part.label}|${part.text}|${part.images.join('|')}`)
    }.padding(SharePageLayout.padding).width(SharePageLayout.width).backgroundColor(Tokens.card)
  }
  private async generate(): Promise<void> {
    if (this.busy || !this.segments.length) return;
    this.busy = true; this.error = '';
    const context = getContext(this) as common.UIAbilityContext;
    const created: string[] = [];
    try {
      // Re-measure at generation time if the window density changed while the preview page was open.
      this.segments = this.groupPages();
      for (let index = 0; index < this.segments.length; index++) {
        if (!this.alive) throw new Error('页面已关闭');
        const segment = this.segments[index];
        // Native offscreen rendering vertically composes the complete bounded segment, including images.
        const map = await this.getUIContext().getComponentSnapshot().createFromBuilder(() => {
          this.snapshotPage(segment, index)
        }, 100, true, { scale: 1 });
        try {
          if (!this.alive) throw new Error('页面已关闭');
          const info = await map.getImageInfo();
          const width = info.size.width; const height = info.size.height;
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
            width > SharePageLayout.maxSidePixels || height > SharePageLayout.maxSidePixels || width * height > SharePageLayout.maxPixels) {
            throw new Error('实际长图超出安全像素尺寸');
          }
          const packer = image.createImagePacker();
          try {
            const bytes = await packer.packing(map, { format: 'image/png', quality: 100 });
            if (!this.alive) throw new Error('页面已关闭');
            const path = `${context.cacheDir}/leobot-turn-${Date.now()}-${index}.png`;
            const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
            created.push(path);
            try {
              if (fileIo.writeSync(file.fd, bytes) !== bytes.byteLength) throw new Error('图片写入不完整');
            } finally { fileIo.closeSync(file); }
          } finally { await packer.release(); }
        } finally { await map.release(); }
      }
      if (!this.alive) throw new Error('页面已关闭');
      this.paths = created;
    } catch (_error) {
      for (const path of created) { try { fileIo.unlinkSync(path); } catch (_ignored) {} }
      if (this.alive) this.error = '长图生成失败，未分享任何内容。请重试或使用导出对话。';
    } finally { if (this.alive) this.busy = false; }
  }
  private async share(): Promise<void> {
    if (!this.paths.length || this.busy) return;
    this.busy = true; this.error = '';
    try {
      const data = new systemShare.SharedData({ utd: utd.UniformDataType.IMAGE, uri: fileUri.getUriFromPath(this.paths[0]), title: 'LeoBot 对话长图 1' });
      for (let index = 1; index < this.paths.length; index++) data.addRecord({ utd: utd.UniformDataType.IMAGE, uri: fileUri.getUriFromPath(this.paths[index]), title: `LeoBot 对话长图 ${index + 1}` });
      const controller = new systemShare.ShareController(data);
      await controller.show(getContext(this) as common.UIAbilityContext, { anchor: 'turnShareButton' });
      // show() only opens the OS panel. It is not a delivery receipt and files remain in app cache for the receiver.
    } catch (_error) { this.error = '系统分享面板未打开，请重试'; }
    finally { this.busy = false; }
  }
  build() {
    NavDestination() {
      Column({ space: 12 }) {
        NavHeader({ title: '分享为长图', onBack: () => AppNavigation.back() })
        Text('仅分享所选轮次的问答、图片和附件名称，不包含工具参数或审批内容。请检查预览中的私人信息后再分享。长内容自动分段，不截断。')
          .fontSize(14).fontColor(Tokens.secondary).padding(16)
        Scroll() {
          Column({ space: 14 }) {
            ForEach(this.paths, (path: string) => { Image(path).width('100%').objectFit(ImageFit.Contain) }, (path: string) => path)
          }.width('100%').constraintSize({ maxWidth: 480 }).padding(16)
        }.layoutWeight(1).width('100%')
        if (this.error) Text(this.error).fontSize(14).fontColor(Tokens.danger).padding(12)
        if (!this.paths.length) ActionButton({ label: '生成长图预览', busy: this.busy, isEnabled: this.segments.length > 0, onTap: () => this.generate() }).margin(16)
        else ActionButton({ label: `分享 ${this.paths.length} 张长图`, busy: this.busy, onTap: () => this.share() }).id('turnShareButton').margin(16)
      }.height('100%').width('100%').backgroundColor(Tokens.bg)
    }.hideTitleBar(true).onShown(() => AppNavigation.changed())
  }
}
