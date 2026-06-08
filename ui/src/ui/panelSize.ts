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
