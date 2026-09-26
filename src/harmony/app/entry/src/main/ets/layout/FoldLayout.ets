import display from '@ohos.display';
import { Tokens } from '../theme/Tokens';

export class FoldLayout {
  static isExpanded(): boolean {
    try {
      if (!display.isFoldable()) {
        return false;
      }
      return display.getFoldStatus() === display.FoldStatus.FOLD_STATUS_EXPANDED;
    } catch (_err) {
      return false;
    }
  }

  /**
   * 够宽就左右分栏(列表 + 对话),不看横竖:展开的折叠屏近似正方形、略高,平板竖着拿也够宽。
   * 原来还要求横着拿,展开的折叠屏一直是被拉宽的手机版。横着的手机(高不到 480)仍是单栏。
   */
  static isWide(width: number, height: number = 0): boolean {
    if (width < Tokens.wideBreak) {
      return false;
    }
    if (height > 0 && height < Tokens.tallBreak) {
      return false;
    }
    return true;
  }
}
