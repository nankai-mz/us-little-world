import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import type { Coord } from "../../../src/features/scene-core/levels";

const stepInterval = 180;
const steps: Coord[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export function FlightJoystick({ disabled, move }: { disabled: boolean; move: (delta: Coord) => void }) {
  const [point, setPoint] = useState<Coord>([0, 0]);
  const pointer = useRef<number | undefined>(undefined);
  const lastStep = useRef(-stepInterval);
  const [x, y] = point;
  const direction = Math.hypot(x, y) < 0.24 ? -1 : Math.abs(x) >= Math.abs(y) ? (x < 0 ? 0 : 1) : (y < 0 ? 2 : 3);
  const tick = useEffectEvent(() => {
    if (disabled || direction < 0 || performance.now() - lastStep.current < stepInterval) return;
    lastStep.current = performance.now();
    move(steps[direction]);
  });

  useEffect(() => {
    if (direction < 0 || disabled) return;
    tick();
    const timer = window.setInterval(() => tick(), stepInterval);
    return () => window.clearInterval(timer);
  }, [direction, disabled]);

  function aim(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) { release(event); return; }
    const x = 2 * (event.clientX - bounds.left) / bounds.width - 1;
    const y = 2 * (event.clientY - bounds.top) / bounds.height - 1;
    const radius = Math.max(1, Math.hypot(x, y));
    setPoint([x / radius, y / radius]);
  }

  function release(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = undefined;
    setPoint([0, 0]);
  }

  return <div className="play-flight-joystick" role="group" aria-label="移动摇杆" aria-disabled={disabled}
    onPointerDown={(event) => {
      if (disabled || !event.isPrimary || event.button !== 0 || pointer.current !== undefined) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = event.pointerId;
      aim(event);
    }} onPointerMove={aim} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>
    <span aria-hidden="true" style={{ transform: `translate(${x * 29}px, ${y * 29}px)` }} />
  </div>;
}
