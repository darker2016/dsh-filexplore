# Layout patch: native right panel column

`dsh-filexplore` needs a real fourth grid column so the conversation reflows
instead of being covered by a floating overlay. The shipped layout plugin has
no general right-panel column (its `details` column is a single-kind slot owned
by the session-detail panel), so we patch the compiled bundle of
**`@deepseek-ai/dsh-client-ui-layout`**.

## Where to apply

```
~/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js
```

This repository keeps the patched bundle as `patches/dsh-client-ui-layout.client.js`.
After a `dsh` upgrade re-extracts node_modules, re-apply by copying that file over
the fresh one (or redo the edits below against the new bundle).

> Note: this is a **compiled** bundle; the edits are mechanical. If the underlying
> layout source changes after an upgrade, the exact anchors below may shift.

## What changed

1. **`computeColumns(viewport, sidebar, right, details)`** — reserve a fourth
   `right` column width between the center and details, keeping center ≥ 640px
   (the same priority-chain style as the existing details handling).

2. **CSS** — added `.pI_x6G_rightCol` (and `[data-right-collapsed]` variant)
   plus `[data-side=right]` drag-handle hover rules, mirroring `details`.

3. **CSS module map** — added `"rightCol"` key.

4. **`RightColumn`** component — like `DetailsColumn`, renders the
   `renderSlot("layout.right", {})`.

5. **`AppFrame`** — grid becomes
   `${sidebar}px minmax(0, 1fr) ${right}px ${details}px`; renders `RightColumn`
   between center and details; `data-right-collapsed`; a `DragHandle` for the
   right column (`setRight(rightBase - dx)`).

6. **Layout store** — `right: 0` initial + actions `setRight`(clamp 320–760),
   `openRight`(→380), `closeRight`(→0).

7. **`ctx.layout` service** — added `openRight()`, `closeRight()`, `setRight(px)`.

8. **Root slot declarations** — added `"layout.right": { kind: "single", scope: "root" }`.

## Client usage

`dsh-filexplore` injects `"layout"` and registers its browser/viewer into the
`layout.right` slot, then calls `ctx.layout.openRight()` / `closeRight()`.
