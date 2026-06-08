# UI Foundations (Tooltip Portal · Resizable Panels · Model Defaults) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three foundational pieces the IA consolidation depends on — a non-clipping tooltip (portal), reusable resizable/maximizable panels, and a persisted model/effort *defaults* core — with zero change to the current information architecture.

**Architecture:** Each piece is built around a **pure core** (a position calculator, two `localStorage` helper pairs) tested directly in vitest's node environment; the React wiring is a thin wrapper verified by eye in the running app. No new dependencies. This is Plan 1 of 2 for the spec at `docs/superpowers/specs/2026-06-07-ui-ia-consolidation-design.md`; Plan 2 (IA consolidation + branch picker) builds on these.

**Tech Stack:** React 18 + TypeScript (Vite), `react-dom/client` `createPortal`, vitest 2.x (node env — logic-only tests, no jsdom/RTL), CSS custom properties in `ui/src/styles.css`.

**Conventions for every task:**
- Run the full suite with `pnpm test` (the `test:unit` script is broken — see `docs/BACKLOG.md` §D; do not use it). Run a single file with `pnpm exec vitest run <path>`.
- Tests are **logic-only**: there is no jsdom/RTL. Never write a test that renders a component or calls a hook. Test the exported pure functions; verify React behavior manually.
- Manual-verify steps require the dev server: `pnpm dev:ui` (Vite + tsx server via `concurrently`), then open the Vite URL.

---

## Task 1: Tooltip position calculator (pure core for #1)

**Files:**
- Create: `ui/src/ui/popoverPosition.ts`
- Test: `test/unit/ui/popoverPosition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/ui/popoverPosition.test.ts
import { describe, expect, it } from "vitest";
import { computePopoverPosition, type Rect } from "../../../ui/src/ui/popoverPosition";

const popover = { width: 240, height: 80 };
const viewport = { width: 1000, height: 800 };

describe("computePopoverPosition", () => {
  it("centers horizontally on the badge when there is room", () => {
    const badge: Rect = { top: 300, left: 500, width: 16, height: 16 };
    const pos = computePopoverPosition(badge, popover, viewport, "top");
    // badge center = 508; left = 508 - 120 = 388
    expect(pos.left).toBe(388);
    expect(pos.placement).toBe("top");
    expect(pos.top).toBe(300 - 80 - 8); // 212
  });

  it("clamps to the left viewport edge", () => {
    const badge: Rect = { top: 300, left: 10, width: 16, height: 16 };
    const pos = computePopoverPosition(badge, popover, viewport, "top");
    expect(pos.left).toBe(8);
  });

  it("clamps to the right viewport edge", () => {
    const badge: Rect = { top: 300, left: 990, width: 16, height: 16 };
    const pos = computePopoverPosition(badge, popover, viewport, "top");
    expect(pos.left).toBe(1000 - 240 - 8); // 752
  });

  it("flips to bottom when there is no room above", () => {
    const badge: Rect = { top: 20, left: 500, width: 16, height: 16 };
    const pos = computePopoverPosition(badge, popover, viewport, "top");
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(20 + 16 + 8); // 44
  });

  it("flips to top when preferred bottom has no room below", () => {
    const badge: Rect = { top: 750, left: 500, width: 16, height: 16 };
    const pos = computePopoverPosition(badge, popover, viewport, "bottom");
    expect(pos.placement).toBe("top");
    expect(pos.top).toBe(750 - 80 - 8); // 662
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/unit/ui/popoverPosition.test.ts`
Expected: FAIL — `Failed to resolve import ".../popoverPosition"` / `computePopoverPosition is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/ui/popoverPosition.ts
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export type Placement = "top" | "bottom";
export interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement;
}

const GAP = 8; // space between badge and popover
const EDGE = 8; // min distance from any viewport edge

/**
 * Compute viewport-relative (position: fixed) coordinates for a popover anchored
 * to a badge. Centers horizontally on the badge, clamps into the viewport, and
 * flips top<->bottom when the preferred side has no room. Pure — no DOM access.
 */
export function computePopoverPosition(
  badge: Rect,
  popover: Size,
  viewport: Viewport,
  preferred: Placement = "top",
): PopoverPosition {
  const badgeCenterX = badge.left + badge.width / 2;
  let left = badgeCenterX - popover.width / 2;
  const maxLeft = viewport.width - popover.width - EDGE;
  if (left > maxLeft) left = maxLeft;
  if (left < EDGE) left = EDGE;

  const fitsTop = badge.top - popover.height - GAP >= EDGE;
  const fitsBottom =
    badge.top + badge.height + popover.height + GAP <= viewport.height - EDGE;

  let placement: Placement = preferred;
  if (preferred === "top" && !fitsTop && fitsBottom) placement = "bottom";
  if (preferred === "bottom" && !fitsBottom && fitsTop) placement = "top";

  const top =
    placement === "top"
      ? badge.top - popover.height - GAP
      : badge.top + badge.height + GAP;

  return { top, left, placement };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/unit/ui/popoverPosition.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/ui/popoverPosition.ts test/unit/ui/popoverPosition.test.ts
git commit -m "feat(ui): pure popover position calculator for tooltip portal"
```

---

## Task 2: InfoBadge renders via portal (wiring for #1)

**Files:**
- Modify: `ui/src/InfoBadge.tsx` (render popover through `createPortal` to `document.body`, positioned with the Task 1 calculator)
- Modify: `ui/src/styles.css:1470-1521` (popover becomes `position: fixed`; remove the CSS placement/transform rules and the `::after` arrow; visibility is now JS-controlled)

> No unit test — this is DOM/React behavior with no jsdom env. The calculator it depends on is already tested. Verify manually in Step 4.

- [ ] **Step 1: Rewrite `InfoBadge.tsx` to portal the popover**

Replace the whole file with:

```tsx
// ui/src/InfoBadge.tsx
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computePopoverPosition, type Placement } from "./ui/popoverPosition";

/**
 * Inline "?" badge that reveals a short explanation on hover or keyboard focus.
 * The popover is rendered in a portal on document.body and positioned with
 * fixed coordinates, so it is never clipped by an ancestor's overflow (the bug
 * that hid tooltips inside scrollable/resizable panels). Visibility is JS-driven
 * because a portaled node is outside the badge's :hover subtree.
 */
export function InfoBadge({
  label = "More info",
  placement = "top",
  children,
}: {
  label?: string;
  placement?: Placement;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  const reposition = useCallback(() => {
    const badge = badgeRef.current;
    const pop = popRef.current;
    if (!badge || !pop) return;
    const b = badge.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const next = computePopoverPosition(
      { top: b.top, left: b.left, width: b.width, height: b.height },
      { width: p.width, height: p.height },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
    );
    setPos({ top: next.top, left: next.left });
  }, [placement]);

  // Measure + position after the popover mounts, and on scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  return (
    <span
      className="info-badge-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={badgeRef}
        type="button"
        className="info-badge"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <span
            ref={popRef}
            role="tooltip"
            id={id}
            className="info-badge-popover info-badge-popover-open"
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
```

> Note: `useCallback` is imported from `react` (it is a named export); keep the import list as written.

- [ ] **Step 2: Update the popover CSS**

In `ui/src/styles.css`, replace the popover positioning block (`.info-badge-popover` through the `.info-badge-placement-bottom .info-badge-popover::after` rule, lines ~1470-1521) with:

```css
.info-badge-popover {
  min-width: 240px;
  max-width: 340px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--ink);
  color: var(--bg-elev);
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  filter: drop-shadow(0 2px 6px oklch(0% 0 0 / 0.12));
}

.info-badge-popover-open {
  opacity: 1;
  pointer-events: auto;
}
```

Also delete the now-dead visibility rule that targets `.info-badge-wrap:hover .info-badge-popover, .info-badge-wrap:focus-within .info-badge-popover, .info-badge-pinned .info-badge-popover` (lines ~1523-1528) — visibility is now the `-open` class. Leave `.info-badge-wrap`, `.info-badge`, and the `.info-badge-popover code/strong/ul/li` rules untouched.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors). If `useCallback` reports unused on any path, confirm it is referenced in `useLayoutEffect`'s dependency array as written.

- [ ] **Step 4: Manual verification**

Run `pnpm dev:ui`, open the app, go to the start-run form's thoroughness/model controls (where an `InfoBadge` sits inside a scrollable card). Hover/focus the `?`:
- The tooltip is fully visible (not clipped at the card edge).
- It flips below the badge when near the top of the viewport.
- It tracks the badge when you scroll the card.
- Tab to the badge → it appears on focus; blur → it hides.

- [ ] **Step 5: Commit**

```bash
git add ui/src/InfoBadge.tsx ui/src/styles.css
git commit -m "fix(ui): portal InfoBadge tooltip so panel overflow no longer clips it"
```

---

## Task 3: Panel-size persistence helpers (pure core for #3)

**Files:**
- Create: `ui/src/ui/panelSize.ts`
- Test: `test/unit/ui/panelSize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/ui/panelSize.test.ts
import { describe, expect, it } from "vitest";
import { loadPanelSize, savePanelSize, type StorageLike } from "../../../ui/src/ui/panelSize";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("panelSize", () => {
  it("round-trips a saved size", () => {
    const s = fakeStorage();
    savePanelSize("proposal", { width: 500, height: 320 }, s);
    expect(loadPanelSize("proposal", s)).toEqual({ width: 500, height: 320 });
  });

  it("returns null for a missing key", () => {
    expect(loadPanelSize("nope", fakeStorage())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(loadPanelSize("x", fakeStorage({ "agent-orch:panel:x": "{not json" }))).toBeNull();
  });

  it("keeps only positive numeric dimensions", () => {
    const s = fakeStorage({ "agent-orch:panel:p": JSON.stringify({ width: 0, height: 200 }) });
    expect(loadPanelSize("p", s)).toEqual({ height: 200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/unit/ui/panelSize.test.ts`
Expected: FAIL — cannot resolve import.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/ui/panelSize.ts
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface PanelSize {
  width?: number;
  height?: number;
}

const PREFIX = "agent-orch:panel:";

export function loadPanelSize(key: string, storage: StorageLike): PanelSize | null {
  const raw = storage.getItem(PREFIX + key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { width, height } = parsed as Record<string, unknown>;
    const size: PanelSize = {};
    if (typeof width === "number" && width > 0) size.width = width;
    if (typeof height === "number" && height > 0) size.height = height;
    return Object.keys(size).length > 0 ? size : null;
  } catch {
    return null;
  }
}

export function savePanelSize(key: string, size: PanelSize, storage: StorageLike): void {
  storage.setItem(PREFIX + key, JSON.stringify(size));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/unit/ui/panelSize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/ui/panelSize.ts test/unit/ui/panelSize.test.ts
git commit -m "feat(ui): panel-size persistence helpers"
```

---

## Task 4: ResizablePanel component (wiring for #3)

**Files:**
- Create: `ui/src/ui/ResizablePanel.tsx`
- Modify: `ui/src/styles.css` (append `.resizable-panel*` rules)

> No unit test — native `resize` and the maximize overlay are DOM behavior (no jsdom). The persistence core is already tested in Task 3. Verify manually in Step 3.

- [ ] **Step 1: Create the component**

```tsx
// ui/src/ui/ResizablePanel.tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { loadPanelSize, savePanelSize } from "./panelSize";

/**
 * A content panel that is generous by default, drag-resizable on both axes
 * (native CSS resize), and can be maximized to a full-viewport overlay for
 * reading/editing long content. Sizes persist per `storageKey` via localStorage.
 */
export function ResizablePanel({
  storageKey,
  title,
  minHeight = 220,
  children,
}: {
  storageKey: string;
  title?: string;
  minHeight?: number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);

  // Restore persisted size on mount.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const saved = loadPanelSize(storageKey, window.localStorage);
    if (saved?.width) el.style.width = `${saved.width}px`;
    if (saved?.height) el.style.height = `${saved.height}px`;
  }, [storageKey]);

  // Persist after a drag-resize ends.
  const persist = () => {
    const el = bodyRef.current;
    if (!el) return;
    savePanelSize(storageKey, { width: el.offsetWidth, height: el.offsetHeight }, window.localStorage);
  };

  // Escape closes the maximize overlay.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const header = (
    <div className="resizable-panel-head">
      {title ? <span className="resizable-panel-title">{title}</span> : <span />}
      <button
        type="button"
        className="resizable-panel-max"
        aria-label={maximized ? "Restore panel" : "Maximize panel"}
        onClick={() => setMaximized((v) => !v)}
      >
        {maximized ? "⤡ Restore" : "⤢ Maximize"}
      </button>
    </div>
  );

  if (maximized) {
    return createPortal(
      <div className="resizable-panel-overlay" role="dialog" aria-modal="true">
        <div className="resizable-panel resizable-panel-maximized">
          {header}
          <div className="resizable-panel-body">{children}</div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="resizable-panel">
      {header}
      <div
        ref={bodyRef}
        className="resizable-panel-body resizable-panel-body-resizable"
        style={{ minHeight }}
        onMouseUp={persist}
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS**

Add to the end of `ui/src/styles.css`:

```css
/* ---------- resizable panel ---------- */
.resizable-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.resizable-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.resizable-panel-title {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}
.resizable-panel-max {
  font-size: 11px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--ink-mute);
}
.resizable-panel-max:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.resizable-panel-body-resizable {
  resize: both;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  width: 100%;
}
.resizable-panel-overlay {
  position: fixed;
  inset: 0;
  background: oklch(0% 0 0 / 0.45);
  z-index: 900;
  display: flex;
  padding: 24px;
}
.resizable-panel-maximized {
  flex: 1;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 18px 20px;
  overflow: hidden;
}
.resizable-panel-maximized .resizable-panel-body {
  height: calc(100% - 32px);
  overflow: auto;
}
```

- [ ] **Step 3: Manual verification**

Temporarily render `<ResizablePanel storageKey="demo" title="demo"><p>long content…</p></ResizablePanel>` somewhere visible (e.g. top of `StartRunForm`), run `pnpm dev:ui`, and confirm:
- The body drags to resize on both axes; reload preserves the size.
- "⤢ Maximize" opens a full-viewport overlay; "⤡ Restore" and `Escape` both close it.
Then remove the temporary render.

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (298 prior + the 9 new from Tasks 1 & 3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/ui/ResizablePanel.tsx ui/src/styles.css
git commit -m "feat(ui): ResizablePanel primitive (native resize + maximize overlay)"
```

---

## Task 5: Model/effort defaults core (pure core for #5)

**Files:**
- Create: `ui/src/modelDefaults.ts`
- Test: `test/unit/ui/modelDefaults.test.ts`

> This is the persisted-defaults logic only. The `DefaultsPanel` UI and wiring the preflight analyze/plan calls to send these defaults are in **Plan 2** (they belong with the landing reorg). This task makes the core testable and reusable now.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/ui/modelDefaults.test.ts
import { describe, expect, it } from "vitest";
import { loadDefaults, saveDefaults, defaultsOrFallback, type StorageLike } from "../../../ui/src/modelDefaults";
import { recommendedSelections } from "../../../ui/src/modelConfig";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("modelDefaults", () => {
  it("returns recommended selections when storage is empty", () => {
    expect(loadDefaults(fakeStorage())).toEqual(recommendedSelections());
  });

  it("round-trips valid selections", () => {
    const s = fakeStorage();
    const sel = recommendedSelections();
    sel.analyze = { model: "claude-opus-4-8", effort: "high" };
    saveDefaults(sel, s);
    expect(loadDefaults(s)).toEqual(sel);
  });

  it("falls back per-phase for an unknown model id", () => {
    const out = defaultsOrFallback({
      analyze: { model: "made-up-model", effort: "high" },
      plan: { model: "claude-sonnet-4-6", effort: "default" },
      execute: { model: "claude-haiku-4-5-20251001", effort: "default" },
    });
    expect(out.analyze.model).toBe(recommendedSelections().analyze.model);
  });

  it("clamps an effort the model does not support", () => {
    // xhigh is Opus-only; on Sonnet it must clamp to "default".
    const out = defaultsOrFallback({
      analyze: { model: "claude-sonnet-4-6", effort: "xhigh" },
      plan: { model: "claude-sonnet-4-6", effort: "default" },
      execute: { model: "claude-haiku-4-5-20251001", effort: "default" },
    });
    expect(out.analyze.effort).toBe("default");
  });

  it("returns recommended selections on malformed JSON", () => {
    expect(loadDefaults(fakeStorage({ "agent-orch:model-defaults": "{oops" }))).toEqual(
      recommendedSelections(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/unit/ui/modelDefaults.test.ts`
Expected: FAIL — cannot resolve import.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/modelDefaults.ts
import {
  AGENT_PHASES,
  clampEffort,
  MODEL_OPTIONS,
  recommendedSelections,
  type PhaseSelection,
  type PhaseSelections,
} from "./modelConfig";
import type { ModelId } from "./runTypes";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "agent-orch:model-defaults";

function isValidModel(id: unknown): id is ModelId {
  return typeof id === "string" && MODEL_OPTIONS.some((o) => o.id === id);
}

/** Validate/repair a raw value into PhaseSelections, falling back per-phase. */
export function defaultsOrFallback(raw: unknown): PhaseSelections {
  const fallback = recommendedSelections();
  if (typeof raw !== "object" || raw === null) return fallback;
  const obj = raw as Record<string, unknown>;
  const out = {} as PhaseSelections;
  for (const phase of AGENT_PHASES) {
    const entry = obj[phase];
    if (typeof entry !== "object" || entry === null) {
      out[phase] = fallback[phase];
      continue;
    }
    const { model, effort } = entry as Record<string, unknown>;
    const validModel: ModelId = isValidModel(model) ? model : fallback[phase].model;
    const sel: PhaseSelection = {
      model: validModel,
      effort: clampEffort(
        validModel,
        typeof effort === "string" ? (effort as PhaseSelection["effort"]) : "default",
      ),
    };
    out[phase] = sel;
  }
  return out;
}

export function loadDefaults(storage: StorageLike): PhaseSelections {
  const raw = storage.getItem(KEY);
  if (!raw) return recommendedSelections();
  try {
    return defaultsOrFallback(JSON.parse(raw));
  } catch {
    return recommendedSelections();
  }
}

export function saveDefaults(sel: PhaseSelections, storage: StorageLike): void {
  storage.setItem(KEY, JSON.stringify(sel));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/unit/ui/modelDefaults.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Final suite + commit**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (298 prior + 14 new across Tasks 1, 3, 5).

```bash
git add ui/src/modelDefaults.ts test/unit/ui/modelDefaults.test.ts
git commit -m "feat(ui): persisted model/effort defaults core"
```

---

## Self-Review

**Spec coverage (Plan 1 portion):**
- #1 tooltip portal → Tasks 1 (calculator) + 2 (wiring). ✓
- #3 resizable panels → Tasks 3 (persistence core) + 4 (component). ✓
- #5 defaults (logic) → Task 5; `DefaultsPanel` UI + preflight wiring deferred to Plan 2 (noted in Task 5). ✓
- #2, #4, #6 → out of scope for Plan 1 by design (Plan 2).

**Placeholder scan:** none — every code/test step contains full source; manual-verify steps name the exact surface and expected behavior.

**Type consistency:** `StorageLike` is defined independently in `panelSize.ts` and `modelDefaults.ts` (both `{getItem, setItem}`) — intentional, no shared import needed. `PhaseSelections`/`PhaseSelection`/`clampEffort`/`MODEL_OPTIONS`/`AGENT_PHASES`/`recommendedSelections` are imported from the real `ui/src/modelConfig.ts` signatures. `ModelId` from `ui/src/runTypes.ts`. `Placement` is shared from `popoverPosition.ts` into `InfoBadge.tsx`. The `InfoBadge` prop change drops the unused `pinned` concept; its ~6 call sites pass only `label`/`placement`/children, which remain valid.

**Risk note:** Task 2 changes a component used in ~6 places but keeps the public props, so call sites are unaffected; the only behavioral change is portal rendering + JS-driven visibility, verified manually.
