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
    savePanelSize(
      storageKey,
      { width: el.offsetWidth, height: el.offsetHeight },
      window.localStorage,
    );
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
