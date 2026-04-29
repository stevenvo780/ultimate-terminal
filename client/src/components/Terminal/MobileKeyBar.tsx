import { useState, useCallback, useRef, useEffect } from 'react';
import './MobileKeyBar.css';

interface MobileKeyBarProps {
  onKey: (data: string) => void;
  visible: boolean;
}

type Modifier = 'ctrl' | 'alt' | 'shift';

// Escape sequences
const KEYS: Record<string, { label: string; data: string; wide?: boolean; toggle?: Modifier }> = {
  esc: { label: 'Esc', data: '\x1b' },
  ctrl: { label: 'Ctrl', data: '', toggle: 'ctrl' },
  alt: { label: 'Alt', data: '', toggle: 'alt' },
  tab: { label: 'Tab', data: '\t' },
  up: { label: '↑', data: '\x1b[A' },
  down: { label: '↓', data: '\x1b[B' },
  left: { label: '←', data: '\x1b[C' },
  right: { label: '→', data: '\x1b[D' },
  home: { label: 'Home', data: '\x1b[H' },
  end: { label: 'End', data: '\x1b[F' },
  pgup: { label: 'PgUp', data: '\x1b[5~' },
  pgdn: { label: 'PgDn', data: '\x1b[6~' },
  pipe: { label: '|', data: '|' },
  tilde: { label: '~', data: '~' },
  dash: { label: '-', data: '-' },
  slash: { label: '/', data: '/' },
  backslash: { label: '\\', data: '\\' },
  underscore: { label: '_', data: '_' },
};

// Ctrl+key produces char code 1-26 for a-z
const ctrlChar = (ch: string): string => {
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return String.fromCharCode(code - 96);
  }
  return ch;
};

const ROW_1 = ['esc', 'ctrl', 'alt', 'tab', 'up', 'down', 'left', 'right'];
const ROW_2 = ['home', 'end', 'pipe', 'tilde', 'slash', 'backslash', 'dash', 'underscore'];

// Quick-access Ctrl combos
const CTRL_COMBOS: { label: string; data: string }[] = [
  { label: 'C', data: '\x03' },
  { label: 'D', data: '\x04' },
  { label: 'Z', data: '\x1a' },
  { label: 'L', data: '\x0c' },
  { label: 'A', data: '\x01' },
  { label: 'E', data: '\x05' },
  { label: 'R', data: '\x12' },
  { label: 'U', data: '\x15' },
  { label: 'W', data: '\x17' },
  { label: 'K', data: '\x0b' },
];

export function MobileKeyBar({ onKey, visible }: MobileKeyBarProps) {
  const [activeModifiers, setActiveModifiers] = useState<Set<Modifier>>(new Set());
  const [showCtrlPanel, setShowCtrlPanel] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Keep the bar above the on-screen keyboard by tracking visualViewport.
  // position: fixed is anchored to the layout viewport, so we offset `bottom`
  // by the difference between layout and visual viewports.
  useEffect(() => {
    if (!visible) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const el = barRef.current;
      if (!el) return;
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.bottom = `${offset}px`;
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };

    update();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      const el = barRef.current;
      if (el) el.style.bottom = '';
    };
  }, [visible]);

  const handleModifier = useCallback((mod: Modifier) => {
    setActiveModifiers((prev) => {
      const next = new Set(prev);
      if (next.has(mod)) {
        next.delete(mod);
      } else {
        next.add(mod);
      }
      return next;
    });
    // If toggling Ctrl ON, show quick combos
    if (mod === 'ctrl') {
      setShowCtrlPanel((prev) => !prev);
    } else {
      setShowCtrlPanel(false);
    }
  }, []);

  const handleKey = useCallback((keyId: string) => {
    const keyDef = KEYS[keyId];
    if (!keyDef) return;

    if (keyDef.toggle) {
      handleModifier(keyDef.toggle);
      return;
    }

    let data = keyDef.data;
    if (activeModifiers.has('ctrl') && data.length === 1) {
      data = ctrlChar(data);
    }
    if (activeModifiers.has('alt')) {
      data = '\x1b' + data;
    }

    onKey(data);
    // Clear modifiers after key press
    setActiveModifiers(new Set());
    setShowCtrlPanel(false);
  }, [onKey, activeModifiers, handleModifier]);

  const handleCtrlCombo = useCallback((data: string) => {
    onKey(data);
    setActiveModifiers(new Set());
    setShowCtrlPanel(false);
  }, [onKey]);

  const handleTouchStart = useCallback((keyId: string) => {
    // Long press on Ctrl shows the combo panel
    if (keyId === 'ctrl') {
      longPressTimer.current = setTimeout(() => {
        setShowCtrlPanel(true);
        setActiveModifiers((prev) => {
          const next = new Set(prev);
          next.add('ctrl');
          return next;
        });
      }, 400);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="mobile-keybar" ref={barRef}>
      {showCtrlPanel && (
        <div className="keybar-ctrl-panel">
          <span className="ctrl-panel-label">Ctrl +</span>
          {CTRL_COMBOS.map((combo) => (
            <button
              key={combo.label}
              className="keybar-ctrl-combo"
              onClick={() => handleCtrlCombo(combo.data)}
              type="button"
            >
              {combo.label}
            </button>
          ))}
        </div>
      )}
      <div className="keybar-row">
        {ROW_1.map((keyId) => {
          const keyDef = KEYS[keyId];
          if (!keyDef) return null;
          const isToggle = !!keyDef.toggle;
          const isActive = isToggle && activeModifiers.has(keyDef.toggle!);
          return (
            <button
              key={keyId}
              className={`keybar-key ${isToggle ? 'toggle' : ''} ${isActive ? 'active' : ''}`}
              onClick={() => handleKey(keyId)}
              onTouchStart={() => handleTouchStart(keyId)}
              onTouchEnd={handleTouchEnd}
              type="button"
            >
              {keyDef.label}
            </button>
          );
        })}
      </div>
      <div className="keybar-row">
        {ROW_2.map((keyId) => {
          const keyDef = KEYS[keyId];
          if (!keyDef) return null;
          return (
            <button
              key={keyId}
              className="keybar-key"
              onClick={() => handleKey(keyId)}
              type="button"
            >
              {keyDef.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
