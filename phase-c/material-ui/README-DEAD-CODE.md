# DEAD CODE — Phase C standalone prototype (do not use)

`phase-c/material-ui/` (materials.html, materials.js, materials.css) is the
original Phase C isolated prototype: a demo UI driven by an in-memory repo
with clearly-labeled DEMO data, not connected to any account or backend.

It is NOT used by the live application:

- The live Materials page is `materials.html` (project root), rendered by
  `materials()` / `renderMaterials()` / `renderMaterialDetail()` in `js/app.js`.
- No shipped HTML page references `phase-c/material-ui/`.
- No test in `phase-c/tests/` references it.

Kept for historical reference only. Do not let it influence the live
implementation. Safe to delete in a future cleanup pass.
