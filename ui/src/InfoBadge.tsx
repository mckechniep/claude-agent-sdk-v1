import { useId, useState, type ReactNode } from "react";

/**
 * Inline "?" badge that reveals a short explanation on hover or keyboard focus.
 *
 * Why a custom component instead of `title=`:
 *   - `title` attributes truncate, lack styling, and have inconsistent
 *     dismissal behavior across browsers and mobile.
 *   - This implementation is a CSS-positioned popover so we can wrap text,
 *     render rich content, and control timing.
 *
 * Accessibility:
 *   - The badge is a real `<button>` so it lands in the tab order and
 *     screen readers announce it.
 *   - `aria-describedby` ties the popover to the badge so AT reads the
 *     description on focus.
 *   - Visibility is purely CSS-driven via :hover/:focus-within, so the
 *     popover works without JavaScript even when state updates lag.
 */
export function InfoBadge({
  label = "More info",
  placement = "top",
  children,
}: {
  // Visible-only-to-screen-readers description of what the badge is for.
  // Renders something like "Info about thoroughness" — adjust per usage.
  label?: string;
  // Where the popover renders relative to the badge.
  //   "top"    — default. Best when the badge has clear space above.
  //   "bottom" — best when the badge is near the top of the viewport,
  //              e.g. in a banner at the page top, where "top" placement
  //              would clip against the viewport edge.
  placement?: "top" | "bottom";
  children: ReactNode;
}) {
  const id = useId();
  // The popover toggles on hover (CSS) and on click (JS, for touch users
  // who can't hover). State is kept here so clicking re-toggles cleanly.
  const [pinned, setPinned] = useState(false);
  return (
    <span
      className={`info-badge-wrap info-badge-placement-${placement} ${pinned ? "info-badge-pinned" : ""}`}
    >
      <button
        type="button"
        className="info-badge"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={(e) => {
          e.preventDefault();
          setPinned((v) => !v);
        }}
        onBlur={() => setPinned(false)}
      >
        ?
      </button>
      <span role="tooltip" id={id} className="info-badge-popover">
        {children}
      </span>
    </span>
  );
}
