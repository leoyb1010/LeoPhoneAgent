# Leo welcome entry layout

## Observed issue

The actual built UI's first-use subscription button contains several provider
names. On the 1365px hosted browser screenshot the fixed-height, nowrap button
clips its text inside the existing narrow welcome card. The description below
is not a substitute for a fully readable action label.

## Rule and ownership

`WelcomeScreen` owns presentation only. Keep the existing Button component,
`text-ui-base` token, product colors, card width and the two existing callbacks.
Allow both first-use entry labels to wrap and grow from the normal 40px minimum
height. Do not alter account state, credentials, provider readiness or routing.

## Verification

The full renderer journey captures the actual welcome card before selecting the
API-provider entry. Check the subscription action's scroll width against its
client width at normal desktop and narrow widths, and preserve keyboard access.
No real credential is entered and no model execution is requested.

The journey serves the already-built Web bundle. The previous development
server invalidated `@pierre/diffs/worker/worker.js` dependencies after the first
click and reloaded the page, resetting the in-memory first-use transition. That
harness reload is not evidence that the shipping callback itself is broken.
