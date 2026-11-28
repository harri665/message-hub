import { useRef } from 'react';

const LONG_PRESS_MS = 450;

/**
 * Right-click, or press and hold with a finger or pen, calls `open` with the point and the element under it. iOS fires
 * no contextmenu event for a long press, so the hold is timed here; a finger that moves (scrolling) cancels it, and the
 * tap that ends a long press doesn't also click (open a photo, follow a link, open a chat).
 */
export function useLongPress(open: (x: number, y: number, target: EventTarget | null) => void) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      // Android sends contextmenu for a long press too; the timer has usually opened the menu already.
      if (press.current?.fired) return;
      open(e.clientX, e.clientY, e.target);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      const { clientX: x, clientY: y, target } = e;
      press.current = {
        x, y, fired: false,
        timer: window.setTimeout(() => {
          if (!press.current) return;
          press.current.fired = true;
          navigator.vibrate?.(10);
          open(x, y, target);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
    },
    onPointerUp: () => {
      if (press.current && !press.current.fired) cancel();
    },
    onPointerCancel: () => {
      if (press.current && !press.current.fired) cancel();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (press.current?.fired) {
        e.preventDefault();
        e.stopPropagation();
        press.current = null;
      }
    },
  };
}
