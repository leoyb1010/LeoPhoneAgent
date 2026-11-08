import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { DocumentScanner, DocType, SaveOption } from '@kit.VisionKit';
import { DocumentScanFlow } from '../local/DocumentScanFlow';
import { IconButton } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct DocumentScanPage {
  @State active: boolean = false;
  @State saving: boolean = false;
  private scanId: string = '';
  private closed: boolean = false;
  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object>;
    this.scanId = `${params['scanId'] ?? ''}`;
    this.active = DocumentScanFlow.active(this.scanId);
  }
  aboutToDisappear(): void { this.closed = true; DocumentScanFlow.cancel(this.scanId); }
  build() {
    Column() {
      Row() {
        IconButton({ icon: 'xmark', label: '取消扫描', onTap: () => { DocumentScanFlow.cancel(this.scanId); router.back(); } })
        Text('文档扫描').fontColor(Tokens.text).fontSize(20).layoutWeight(1)
      }.width('100%').padding(12)
      if (this.saving) {
        LoadingProgress().width(28).height(28).color(Tokens.accent)
        Text('正在保存扫描文件…').fontColor(Tokens.secondary)
      }
      if (this.active && !this.saving) {
        DocumentScanner({ scannerConfig: { supportType: [DocType.DOC], maxShotCount: 12,
          isGallerySupported: true, isShareable: false, saveOptions: [SaveOption.JPG, SaveOption.PDF] },
          onResult: (code: number, saveType: SaveOption, uris: string[]) => {
            if (this.closed || this.saving) return;
            if (code === 200) {
              this.saving = true;
              DocumentScanFlow.finish(getContext(this) as common.UIAbilityContext, this.scanId, uris,
                saveType === SaveOption.PDF ? '.pdf' : '.jpg').finally(() => { if (!this.closed) router.back(); });
            } else {
              DocumentScanFlow.cancel(this.scanId, '扫描未完成（' + code + '）');
              router.back();
            }
          }
        }).width('100%').layoutWeight(1)
      } else if (!this.saving) {
        Text('扫描请求已结束，请返回对话重新发起').fontColor(Tokens.secondary)
      }
    }.width('100%').height('100%').backgroundColor(Tokens.bg)
  }
}
