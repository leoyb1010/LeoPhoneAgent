import { useEffect } from 'react';

/**
 * Disable Tab-key focus cycling globally.
 * Electron desktop app uses mouse-first interaction — Tab traversal is not needed.
 */
export function useDisableTab(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Tab') {
        e.preventDefault();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
