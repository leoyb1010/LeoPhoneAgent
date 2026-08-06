import {
  forwardRef,
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { VoiceInputState } from '@cindy/voice-input-core';

import { VoiceInputPointerHint } from './VoiceInputPointerHint';

interface VoiceInputPointerHintLayerProps {
  // Whether pointer movement over the wrapped area should track and show the
  // hint. When false, the layer behaves as a plain div and hides any visible
  // hint so the floating icon never lingers across state transitions.
  active: boolean;
  state: VoiceInputState;
  className?: string;
  children: ReactNode;
}

// Owns the high-frequency pointer-position state locally so that mousemove
// over the tracked area only re-renders this small wrapper instead of the
// parent (ChatInput / VoiceInputOverlay are large enough that 60Hz setState
// on them was visible in profiling on lower-end Windows machines).
//
// Ref is forwarded to the outer div so callers that need to attach a scroll
// ref (e.g. VoiceInputOverlay's transcript) can keep observing the same
// scrollable node they had before this wrapper was introduced.
export const VoiceInputPointerHintLayer = forwardRef<
  HTMLDivElement,
  VoiceInputPointerHintLayerProps
>(function VoiceInputPointerHintLayer(
  { active, state, className, children },
  ref,
) {
  const [hint, setHint] = useState<{ visible: boolean; x: number; y: number }>(
    { visible: false, x: 0, y: 0 },
  );

  const update = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active) return;
      setHint({ visible: true, x: event.clientX, y: event.clientY });
    },
    [active],
  );

  const hide = useCallback(() => {
    setHint((current) => (current.visible ? { ...current, visible: false } : current));
  }, []);

  useEffect(() => {
    if (!active) hide();
  }, [active, hide]);

  return (
    <div
      ref={ref}
      className={className}
      onPointerEnter={update}
      onPointerMove={update}
      onPointerLeave={hide}
    >
      {children}
      <VoiceInputPointerHint
        visible={hint.visible && active}
        x={hint.x}
        y={hint.y}
        state={state}
      />
    </div>
  );
});
