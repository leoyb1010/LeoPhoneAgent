# leocodebox Design Guidelines

This document is the source of truth for new UI work. Prefer semantic tokens over
Tailwind literals so light/dark themes, accent colors, and compact density stay
consistent.

## Tokens

- **Color:** `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`,
  `border-border`, `text-primary`, and `text-destructive`.
- **Elevation:** use `shadow-elevation-1/2/3` or the matching
  `var(--elevation-1/2/3)` custom property. Do not add hand-written box shadows.
- **Radius:** controls use `rounded-md`, cards use `rounded-lg`, and dialogs/sheets
  use `rounded-xl`. Avoid arbitrary radii.
- **Motion:** use `var(--motion-fast)` for micro-interactions,
  `var(--motion-base)` for panels, and `var(--motion-slow)` for route-level motion.
  Every animation must work with `prefers-reduced-motion: reduce`.

## Interaction rules

1. State changes should use opacity/transform rather than layout-jumping display swaps.
2. Dialogs and sheets must animate both entering and leaving; delay unmount until the
   close animation completes when the component owns its lifecycle.
3. Use `document.startViewTransition` for route-level changes when available and fall
   back to the normal update otherwise.
4. A compact-density layout must remain usable without relying on hover-only controls.
5. New polling must pause while `document.visibilityState !== 'visible'` and refresh
   immediately when the window becomes visible again.

## Component checklist

- Use semantic color/elevation/radius tokens.
- Add keyboard focus styles and an accessible label.
- Avoid `dangerouslySetInnerHTML`; if unavoidable, sanitize at the boundary.
- Prefer `memo`, stable callbacks, and virtualization for unbounded lists.
