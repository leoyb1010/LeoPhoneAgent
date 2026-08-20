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

  static isWide(width: number, height: number = 0): boolean {
    if (width < Tokens.wideBreak) {
      return false;
    }
    if (height > 0 && width < height) {
      return false;
    }
    if (height > 0 && height < Tokens.tallBreak) {
      return false;
    }
    return true;
  }
}
