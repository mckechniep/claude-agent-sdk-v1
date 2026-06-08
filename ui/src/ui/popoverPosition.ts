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
