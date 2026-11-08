import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { IconButton } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

/** Native local-image preview. Swiping and zooming never open a remote provider URL. */
@Component
export struct MediaGallery {
  @Prop paths: string[] = [];
  @Prop thumbnailSize: number = 120;
  @State opened: boolean = false;
  @State selected: number = 0;
  @State zoomScale: number = 1;
  @State safeTop: number = 0;
  @State safeBottom: number = 0;
  private previewWindow: window.Window | null = null;
  private alive: boolean = false;
  private pinchStart: number = 1;

  aboutToAppear(): void {
    this.alive = true;
    window.getLastWindow(getContext(this) as common.UIAbilityContext).then((main: window.Window) => {
      if (!this.alive) return; this.previewWindow = main; this.updateInsets();
    }).catch(() => {});
  }
  aboutToDisappear(): void { this.alive = false; this.previewWindow = null; }
  private updateInsets(): void {
    if (!this.previewWindow) return;
    try {
      const system = this.previewWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const navigation = this.previewWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      this.safeTop = this.getUIContext().px2vp(system.topRect.height);
      this.safeBottom = this.getUIContext().px2vp(navigation.bottomRect.height);
    } catch (_error) { /* Retain the last insets while a native window is being replaced. */ }
  }

  build() {
    Scroll() {
      Row({ space: 8 }) {
        ForEach(this.paths, (path: string, index: number) => {
          Image('file://' + path).width(this.thumbnailSize).height(this.thumbnailSize).objectFit(ImageFit.Cover).borderRadius(12)
            .accessibilityText('图片 ' + (index + 1) + '，轻点预览')
            .onClick(() => { this.selected = index; this.zoomScale = 1; this.opened = true; })
        }, (path: string) => path)
      }
    }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).height(this.thumbnailSize)
      .bindContentCover($$this.opened, this.preview)
  }

  @Builder
  preview() {
    Column() {
      Row() {
        Text(`${this.selected + 1} / ${this.paths.length}`).fontSize(15).fontColor(Tokens.text).layoutWeight(1)
        IconButton({ icon: 'xmark', label: '关闭图片预览', onTap: () => { this.opened = false; } })
      }.height(56).flexShrink(0).width('100%').padding({ left: 20, right: 12 })
      Swiper() {
        ForEach(this.paths, (path: string) => {
          Image('file://' + path).width('100%').height('100%').objectFit(ImageFit.Contain)
            .scale({ x: this.zoomScale, y: this.zoomScale })
            .gesture(PinchGesture().onActionStart(() => { this.pinchStart = this.zoomScale; })
              .onActionUpdate((event: GestureEvent) => { this.zoomScale = Math.max(1, Math.min(5, this.pinchStart * event.scale)); }))
            .onClick(() => { this.zoomScale = 1; })
        }, (path: string) => path)
      }.index(this.selected).loop(false).indicator(false).height(0).layoutWeight(1).width('100%')
        .onChange((index: number) => { this.selected = index; this.zoomScale = 1; })
      Text('左右滑动切换 · 双指缩放 · 轻点复原').fontSize(12).fontColor(Tokens.secondary).padding(20).flexShrink(0)
    }.width('100%').height('100%').padding({ top: this.safeTop, bottom: this.safeBottom }).backgroundColor(Tokens.bg)
      .onAppear(() => this.updateInsets()).onAreaChange(() => this.updateInsets())
  }
}
