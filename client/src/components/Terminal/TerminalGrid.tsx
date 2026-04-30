import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import type { DragEvent, RefObject, TouchEvent as ReactTouchEvent } from 'react';
import ReactGridLayout, { WidthProvider, type Layout } from 'react-grid-layout/legacy';
import { ArrowDownToLine, GripHorizontal, Hexagon, Plus, X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  setActiveSession,
  assignGridSlot,
  swapGridSlots,
  setShowDropOverlay,
  setDraggingSessionId,
  setGridSessionIds,
} from '../../store';
import type { TerminalInstance } from '../../App';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './TerminalGrid.css';

const GridLayout = WidthProvider(ReactGridLayout);

interface TerminalGridProps {
  instancesRef: RefObject<Map<string, TerminalInstance>>;
  containerRef?: RefObject<HTMLDivElement | null>;
  instancesVersion: number;
}

// Component helper to reparent the terminal DOM element
function TerminalSlot({
  instance,
  className,
  isActive,
  onDrop,
  onRelease,
}: {
  instance: TerminalInstance;
  className?: string;
  isActive?: boolean;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
  onRelease?: (container: HTMLDivElement) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fitTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      instance.fitAddon.fit();
    });
  }, [instance]);

  useEffect(() => {
    if (instance && wrapperRef.current) {
      const container = instance.containerRef;
      const wrapper = wrapperRef.current;
      // Move the terminal container into this slot
      wrapper.appendChild(container);
      const attached = wrapper.firstElementChild as HTMLDivElement | null;
      if (attached) {
        attached.style.display = 'flex';
        attached.style.width = '100%';
        attached.style.height = '100%';
        // Reset any manual styles that might interfere
        attached.style.order = '';
      }

      fitTerminal();

      const resizeObserver = new ResizeObserver(() => {
        fitTerminal();
      });
      resizeObserver.observe(wrapper);

      // Cleanup: when instance changes or component unmounts, release the container
      return () => {
        resizeObserver.disconnect();
        if (onRelease) {
          onRelease(container);
        }
      };
    }
  }, [fitTerminal, instance, onRelease]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const attached = wrapper?.firstElementChild as HTMLDivElement | null;
    if (!attached) return;
    attached.classList.toggle('active-slot', Boolean(isActive));
  }, [instance, isActive]);

  return (
    <div
      ref={wrapperRef}
      className={`terminal-slot-wrapper ${className || ''}`}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      style={{ width: '100%', height: '100%', overflow: 'hidden', flex: 1, minHeight: 0 }}
    />
  );
}

export function TerminalGrid({ instancesRef, containerRef, instancesVersion }: TerminalGridProps) {
  const dispatch = useAppDispatch();
  const sessions = useAppSelector((state) => state.sessions.sessions);
  const gridSessionIds = useAppSelector((state) => state.sessions.gridSessionIds);
  const activeSessionId = useAppSelector((state) => state.sessions.activeSessionId);
  const draggingSessionId = useAppSelector((state) => state.sessions.draggingSessionId);
  const showDropOverlay = useAppSelector((state) => state.ui.showDropOverlay);
  const token = useAppSelector((state) => state.auth.token);
  const gridAreaRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(0);
  const [instancesSnapshot, setInstancesSnapshot] = useState<Map<string, TerminalInstance>>(new Map());

  // Mobile detection & swipe
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 1100);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeThreshold = 60;

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 1100);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (gridSessionIds.filter(Boolean).length === 0) return;
    const node = gridAreaRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setGridHeight(entry.contentRect.height);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [gridSessionIds]);

  useEffect(() => {
    setInstancesSnapshot(new Map(instancesRef.current));
  }, [instancesRef, sessions, gridSessionIds, activeSessionId, instancesVersion]);

  const buildNextGridSlots = useCallback(() => {
    return [...gridSessionIds];
  }, [gridSessionIds]);

  const seedGridWithActiveSession = useCallback((nextSlots: string[]) => {
    if (!activeSessionId) return nextSlots;
    if (nextSlots.some(Boolean)) return nextSlots;
    nextSlots[0] = activeSessionId;
    return nextSlots;
  }, [activeSessionId]);

  const handleDropOnSlot = (slotIndex: number) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const sessionId = event.dataTransfer.getData('text/plain');
    if (sessionId) {
      // If the target slot already has a session, swap; otherwise assign
      const targetSessionId = gridSessionIds[slotIndex];
      if (targetSessionId && targetSessionId !== sessionId) {
        dispatch(swapGridSlots({ slotIndex, sessionId }));
      } else {
        dispatch(assignGridSlot({ slotIndex, sessionId }));
      }
    }
    dispatch(setDraggingSessionId(null));
    dispatch(setShowDropOverlay(false));
  };

  const handleDropOnHotspot = (hotspotIndex: number) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sessionId = event.dataTransfer.getData('text/plain');
    if (sessionId) {
      const nextSlots = seedGridWithActiveSession(buildNextGridSlots());
      const preferredSlot = hotspotIndex === 0 ? 1 : hotspotIndex;
      dispatch(setGridSessionIds(nextSlots));
      dispatch(assignGridSlot({ slotIndex: Math.min(nextSlots.length, preferredSlot), sessionId }));
    }
    dispatch(setDraggingSessionId(null));
    dispatch(setShowDropOverlay(false));
  };

  const handleDragOverHotspot = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleDragEnd = () => {
    dispatch(setDraggingSessionId(null));
    dispatch(setShowDropOverlay(false));
  };

  const handleClearSlot = (slotIndex: number) => {
    const nextSlots = gridSessionIds.filter((_, index) => index !== slotIndex);
    dispatch(setGridSessionIds(nextSlots));
  };

  // Callback to return the container to the hidden pool when it is removed from a slot
  const handleSlotRelease = useCallback((container: HTMLDivElement) => {
    if (containerRef?.current) {
      containerRef.current.appendChild(container);
      container.style.display = 'none';
    }
  }, [containerRef]);

  // ---- Mobile swipe to switch sessions ----
  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    if (!isMobile) return;
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  }, [isMobile]);

  const handleTouchEnd = useCallback((e: ReactTouchEvent) => {
    if (!isMobile || !touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const dt = Date.now() - touchStartRef.current.t;
    touchStartRef.current = null;

    // Only horizontal swipes, fast enough, not too vertical
    if (dt > 500 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    if (Math.abs(dx) < swipeThreshold) return;

    const currentIdx = sessions.findIndex((s) => s.id === activeSessionId);
    if (currentIdx < 0) return;

    if (dx < 0 && currentIdx < sessions.length - 1) {
      // Swipe left → next
      dispatch(setActiveSession(sessions[currentIdx + 1].id));
    } else if (dx > 0 && currentIdx > 0) {
      // Swipe right → prev
      dispatch(setActiveSession(sessions[currentIdx - 1].id));
    }
  }, [isMobile, sessions, activeSessionId, dispatch]);

  const filledGridCount = useMemo(() => gridSessionIds.filter(Boolean).length, [gridSessionIds]);
  const gridSlots = useMemo(() => gridSessionIds.map((_, index) => index), [gridSessionIds]);
  const filledGridSlots = useMemo(() => gridSlots, [gridSlots]);
  const visibleGridSlots = useMemo(() => {
    if (draggingSessionId) return [...gridSlots, gridSlots.length];
    if (filledGridSlots.length > 0) return filledGridSlots;
    return [];
  }, [draggingSessionId, filledGridSlots, gridSlots]);
  const gridColumns = useMemo(() => {
    if (visibleGridSlots.length <= 1) return 1;
    if (visibleGridSlots.length <= 4) return 2;
    if (visibleGridSlots.length <= 9) return 3;
    return Math.min(4, Math.ceil(Math.sqrt(visibleGridSlots.length)));
  }, [visibleGridSlots.length]);
  const gridRows = Math.max(1, Math.ceil(Math.max(visibleGridSlots.length, 1) / gridColumns));
  const gridMargin: [number, number] = [8, 8];
  const rowHeight = gridHeight > 0
    ? Math.max(1, Math.floor((gridHeight - gridMargin[1] * (gridRows - 1)) / gridRows))
    : 200;

  const layout = useMemo(() => {
    return visibleGridSlots.map((slotIndex, positionIndex) => ({
      i: slotIndex.toString(),
      x: positionIndex % gridColumns,
      y: Math.floor(positionIndex / gridColumns),
      w: 1,
      h: 1,
    }));
  }, [gridColumns, visibleGridSlots]);

  // Handle grid layout change when user drags cells to reorder
  const handleGridLayoutChange = useCallback((newLayout: Layout) => {
    // Sort by position (top-left to bottom-right) and rebuild gridSessionIds
    const sorted = [...newLayout].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    const reorderedIds = sorted.map((item) => {
      const slotIdx = parseInt(item.i, 10);
      return gridSessionIds[slotIdx] || '';
    });
    // Only dispatch if actually changed
    const changed = reorderedIds.some((id, idx) => id !== (gridSessionIds[idx] || ''));
    if (changed) {
      dispatch(setGridSessionIds(reorderedIds));
    }
  }, [gridSessionIds, dispatch]);

  // Render logic
  const renderContent = () => {
    if (filledGridCount === 0) {
      const activeInstance = activeSessionId ? instancesSnapshot.get(activeSessionId) : undefined;

      if (!activeInstance && sessions.length > 0 && token) {
        // Should act as empty state or select last active?
        // For now let's show empty state if no active session selected but sessions exist
      }

      if (sessions.length === 0 && token) {
        return (
          <div className="empty-state">
            <div className="empty-icon">
              <Hexagon />
            </div>
            <h2>No hay sesiones activas</h2>
            <p>Crea una nueva sesión desde el selector superior o el sidebar</p>
          </div>
        );
      }

      return activeInstance ? (
        <TerminalSlot
          instance={activeInstance}
          isActive
          onRelease={handleSlotRelease}
        />
      ) : null;
    }

    // Grid Modes
    return (
      <div className="terminal-grid-area" ref={gridAreaRef}>
        <GridLayout
          className="terminal-grid-layout"
          layout={layout}
          cols={gridColumns}
          rowHeight={rowHeight}
          margin={gridMargin}
          containerPadding={[0, 0]}
          isResizable={false}
          isDraggable={true}
          autoSize={false}
          compactType="horizontal"
          onLayoutChange={handleGridLayoutChange}
          draggableHandle=".grid-drag-handle"
        >
          {visibleGridSlots.map((slotIndex) => {
            const sessionId = gridSessionIds[slotIndex];
            const instance = sessionId ? instancesSnapshot.get(sessionId) : undefined;

            if (instance) {
              const sessionName = sessions.find(s => s.id === sessionId)?.displayName || '';
              return (
                <div key={slotIndex.toString()} className="grid-cell">
                  <div className="grid-drag-handle" title="Arrastrar para reordenar">
                    <GripHorizontal />
                    <span className="grid-drag-label">{sessionName}</span>
                  </div>
                  <TerminalSlot
                    instance={instance}
                    isActive={sessionId === activeSessionId}
                    onDrop={handleDropOnSlot(slotIndex)}
                    onRelease={handleSlotRelease}
                  />
                  <button
                    className="grid-slot-remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleClearSlot(slotIndex);
                    }}
                    title="Quitar del grid"
                    type="button"
                  >
                    <X />
                  </button>
                  {draggingSessionId && (
                    <div
                      className="grid-drop-overlay"
                      onDrop={handleDropOnSlot(slotIndex)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                      }}
                    >
                      <ArrowDownToLine />
                      <span>Reemplazar</span>
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div
                key={slotIndex.toString()}
                className={`empty-slot-target ${draggingSessionId ? 'droppable' : ''}`}
                onDrop={handleDropOnSlot(slotIndex)}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              >
                <div className="slot-icon">
                  {draggingSessionId ? <ArrowDownToLine /> : <Plus />}
                </div>
                <span>{draggingSessionId ? 'Soltar aquí' : 'Vacío'}</span>
              </div>
            );
          })}
        </GridLayout>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`terminal-container ${filledGridCount > 0 ? 'grid-layout' : ''} ${isMobile ? 'is-mobile' : ''}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {renderContent()}

      {/* Drop overlay for single layout (desktop only) */}
      {!isMobile && showDropOverlay && filledGridCount === 0 && (
        <div className="drop-overlay" onDragOver={handleDragOverHotspot} onDrop={handleDragEnd}>
          {['Izquierda', 'Derecha', 'Abajo', 'Arriba'].map((label, idx) => (
            <div
              key={`hotspot-${idx}`}
              className={`drop-zone drop-${idx}`}
              onDrop={handleDropOnHotspot(idx)}
              onDragOver={handleDragOverHotspot}
            >
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
