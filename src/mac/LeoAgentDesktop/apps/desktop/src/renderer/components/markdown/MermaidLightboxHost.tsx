/**
 * MermaidLightboxHost
 *
 * Bridges the vanilla-DOM CodeMirror mermaid widget (see
 * `markdownMermaidLivePreview.ts`) to the React `MermaidLightbox` modal.
 *
 * The widget can't import React directly without dragging a renderer into
 * each block, so it dispatches a CustomEvent on `window` whenever the user
 * clicks/keys-into a rendered diagram. This component listens for that event
 * and mounts the modal. Mount this once anywhere above the editor — currently
 * `FileBodyView` is the natural place since that's where the widgets live.
 */

import { useEffect, useState } from 'react';

import { MermaidLightbox } from '@/components/chat/MermaidLightbox';

import {
  MERMAID_LIGHTBOX_EVENT,
  type MermaidLightboxOpenDetail,
} from './markdownMermaidLivePreview';

export function MermaidLightboxHost() {
  const [detail, setDetail] = useState<MermaidLightboxOpenDetail | null>(null);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const next = (ev as CustomEvent<MermaidLightboxOpenDetail>).detail;
      if (next?.svg) setDetail(next);
    };
    window.addEventListener(MERMAID_LIGHTBOX_EVENT, onOpen);
    return () => window.removeEventListener(MERMAID_LIGHTBOX_EVENT, onOpen);
  }, []);

  if (detail == null) return null;
  return (
    <MermaidLightbox
      svg={detail.svg}
      source={detail.source}
      onClose={() => setDetail(null)}
    />
  );
}
