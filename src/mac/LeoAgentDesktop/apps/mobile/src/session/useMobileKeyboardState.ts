import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';
import type { LoginKeyboardRect } from '@/auth/loginKeyboardAvoidance';

/**
 * 跟踪软键盘的可见性与高度。
 *
 * iOS 用 will 事件在动画开始前拿到目标高度，Android 只有 did 事件。
 * 从会话页提取的共享 hook，供需要按键盘高度计算可用空间的页面复用。
 */
export function useMobileKeyboardState(): { height: number; visible: boolean } {
  const [state, setState] = useState({ height: 0, visible: false });

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setState({
        height: event.endCoordinates?.height ?? 0,
        visible: true,
      });
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setState({ height: 0, visible: false });
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return state;
}

/** 登录键盘契约的完整矩形状态(visible + endCoordinates 矩形)。 */
export interface LoginKeyboardRectState {
  visible: boolean;
  rect: LoginKeyboardRect | null;
}

/**
 * 登录键盘避让 hook(PR4b Step 5b.1):在可见性之外暴露完整 endCoordinates
 * 矩形(x/y/width/height),供 computeLoginKeyboardShift 做停靠/悬浮二维判定。
 *
 * iOS 订阅升级(v6.7):在 keyboardWillShow/Hide 基础上增订 keyboardWillChangeFrame
 * ——悬浮键盘拖动/分离/重停靠等「已显示后改 frame」事件仅经此通道派发,
 * 不订阅则浮动键盘仅首开正确、移动后判定失效;Android 只有 did 事件。
 * 组件卸载时全部移除监听。
 */
export function useLoginKeyboardRect(): LoginKeyboardRectState {
  const [state, setState] = useState<LoginKeyboardRectState>({
    visible: false,
    rect: null,
  });

  useEffect(() => {
    const toRect = (event: KeyboardEvent): LoginKeyboardRect | null => {
      const end = event.endCoordinates;
      if (!end) return null;
      return { x: end.screenX, y: end.screenY, width: end.width, height: end.height };
    };
    const subscriptions = [
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
        (event) => setState({ visible: true, rect: toRect(event) }),
      ),
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
        () => setState({ visible: false, rect: null }),
      ),
    ];
    if (Platform.OS === 'ios') {
      subscriptions.push(
        Keyboard.addListener('keyboardWillChangeFrame', (event) => {
          // 仅在已显示后更新 frame(show/hide 自身也会派发本事件,避免抢先置位)
          setState((prev) =>
            prev.visible ? { visible: true, rect: toRect(event) } : prev,
          );
        }),
      );
    }
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return state;
}
