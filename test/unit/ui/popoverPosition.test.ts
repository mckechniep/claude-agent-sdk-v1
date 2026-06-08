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
