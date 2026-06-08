import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computePopoverPosition, type Placement } from "./ui/popoverPosition";

/**
 * Inline "?" badge that reveals a short explanation on hover or keyboard focus.
 *
 * The popover is rendered in a portal on document.body and positioned with
 * fixed coordinates, so it is never clipped by an ancestor's overflow (the bug
 * that hid tooltips inside scrollable/resizable panels). Visibility is JS-driven
 * because a portaled node is outside the badge's :hover subtree.
 *
 * Accessibility:
 *   - The badge is a real <button> so it lands in the tab order.
 *   - aria-describedby ties the popover to the badge while it's open.
 */
export function InfoBadge({
  label = "More info",
  placement = "top",
  children,
}: {
  label?: string;
  // Preferred side; the calculator flips it when there's no room.
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
