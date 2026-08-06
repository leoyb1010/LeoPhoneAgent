import { useEffect, useState } from 'react';

export function isWindowVisiblyFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

export function useWindowVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isWindowVisiblyFocused();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    const update = () => {
      setVisible(isWindowVisiblyFocused());
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, [enabled]);

  return visible;
}

export function useDocumentVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(() => {
    if (!enabled) return false;
    if (typeof document === 'undefined') return true;
    return isDocumentVisible();
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return undefined;
    }
    const update = () => {
      setVisible(isDocumentVisible());
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled]);

  return visible;
}
