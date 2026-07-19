import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'ut.sidebarWidth';
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 300;

function clampWidth(value: number): number {
  if (Number.isNaN(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
    return clampWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

interface UseResizableSidebarReturn {
  /** Current sidebar width in px (already clamped). */
  width: number;
  /** True while the user is actively dragging the handle. */
  isResizing: boolean;
  /** Pointer-down handler to attach to the resize handle (mouse + touch). */
  startResizing: (event: React.MouseEvent | React.TouchEvent) => void;
}

/**
 * Manages a horizontally-resizable sidebar: live drag (mouse + touch),
 * sensible min/max clamping and width persistence in localStorage.
 */
export function useResizableSidebar(): UseResizableSidebarReturn {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [isResizing, setIsResizing] = useState(false);

  // Drag origin captured on pointer-down so we can compute width from a delta.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Latest width kept in a ref so the mouseup handler can persist it without
  // re-binding listeners on every frame.
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const startResizing = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    event.preventDefault();
    const clientX = 'touches' in event ? event.touches[0]?.clientX ?? 0 : event.clientX;
    dragRef.current = { startX: clientX, startWidth: widthRef.current };
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (clientX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      setWidth(clampWidth(drag.startWidth + (clientX - drag.startX)));
    };

    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) handleMove(e.touches[0].clientX);
    };

    const stop = () => {
      dragRef.current = null;
      setIsResizing(false);
      try {
        localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch {
        /* ignore persistence errors (private mode, quota) */
      }
    };

    // Global feedback + prevent text selection while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', stop);
    window.addEventListener('touchcancel', stop);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', stop);
      window.removeEventListener('touchcancel', stop);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing]);

  return { width, isResizing, startResizing };
}
