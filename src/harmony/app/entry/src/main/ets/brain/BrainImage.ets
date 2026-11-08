import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { BrainCache } from './BrainCache';
import { BrainAPI } from './BrainAPI';
import { ActionButton } from '../theme/Controls';
import { MotionPolicy } from '../theme/MotionPolicy';
import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

@Component
export struct BrainImage {
  @Prop fileId: string = '';
  @Prop label: string = '家庭影像';
  @Prop preview: boolean = false;
  @Prop selected: boolean = false;
  @State pixels: image.PixelMap | undefined = undefined;
  @State failed: boolean = false;
  @State ratio: number = 4 / 3;
  @State imageOpacity: number = 0;
  private ticket: number = 0;

  aboutToAppear(): void { this.load(); }
  aboutToDisappear(): void {
    this.ticket += 1;
    this.pixels?.release();
    this.pixels = undefined;
  }
  private async load(): Promise<void> {
    const ticket = ++this.ticket;
    const generation = BrainAPI.generation();
    this.failed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bytes = await BrainCache.image(getContext(this) as common.UIAbilityContext, this.fileId, this.preview);
        const source = image.createImageSource(bytes);
        let pixels: image.PixelMap;
        let ratio = 4 / 3;
        try {
          const info = await source.getImageInfo();
          ratio = info.size.width / Math.max(1, info.size.height);
          const scale = Math.min(1, (this.preview ? 1600 : 400) / Math.max(info.size.width, info.size.height));
          pixels = await source.createPixelMap({ desiredSize: {
            width: Math.max(1, Math.round(info.size.width * scale)),
            height: Math.max(1, Math.round(info.size.height * scale))
          } });
        } finally { source.release(); }
        if (ticket !== this.ticket || !BrainAPI.active(generation) || Date.now() >= BrainAPI.unlockedUntil) {
          pixels.release();
          return;
        }
        this.ratio = ratio;
        this.pixels = pixels;
        this.getUIContext().animateTo({ duration: MotionPolicy.duration(180), curve: Curve.EaseOut }, () => {
          this.imageOpacity = 1;
        });
        return;
      } catch (error) {
        if (ticket !== this.ticket) return;
        if (attempt < 2 && /429|503|网络|超时/.test(`${error}`)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
        } else {
          this.failed = true;
          return;
        }
      }
    }
  }
  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      if (this.pixels) {
        Image(this.pixels)
          .width('100%').height('100%')
          .objectFit(ImageFit.Contain)
          .opacity(this.imageOpacity)
          .accessibilityText(this.label)
      } else if (this.failed) {
        Column({ space: 10 }) {
          Sym({ name: 'photo', dim: 26, color: Tokens.muted })
          Text('图片暂未加载').fontSize(13).fontColor(Tokens.secondary)
          ActionButton({ label: '重新加载', variant: 'quiet', fullWidth: false, onTap: () => this.load() })
        }.width('100%').height('100%').justifyContent(FlexAlign.Center)
      } else {
        Column({ space: 10 }) {
          LoadingProgress().width(24).height(24).color(Tokens.accent)
          Text('正在读取影像').fontSize(12).fontColor(Tokens.muted)
        }.width('100%').height('100%').justifyContent(FlexAlign.Center)
      }
      if (this.selected) {
        Row({ space: 5 }) {
          Sym({ name: 'checkmark_circle_fill', dim: 16, color: Tokens.sendGlyph })
          Text('已选择').fontSize(12).fontWeight(FontWeight.Medium).fontColor(Tokens.sendGlyph)
        }.padding({ left: 10, right: 10, top: 7, bottom: 7 })
          .backgroundColor(Tokens.accent).borderRadius(20).margin(10)
      }
    }
    .width('100%')
    .aspectRatio(this.ratio)
    .constraintSize({ minHeight: 120, maxHeight: this.preview ? 600 : 420 })
    .backgroundColor(Tokens.surface)
    .borderRadius(16)
    .border({ width: this.selected ? 2 : 0.5, color: this.selected ? Tokens.accent : Tokens.separator })
    .clip(true)
  }
}
