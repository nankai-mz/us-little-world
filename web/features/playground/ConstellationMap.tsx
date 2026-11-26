import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { UsService } from "../../../src/core/service";
import type { Entry } from "../../../src/core/types";
import type { StarPosition, Stars } from "../../../src/features/play-core/media-games";

export function authorizedConstellation(game: Stars, entries: Entry[]): Stars {
  const records = new Map(entries.filter((entry) => entry.visibility === "shared" && !entry.deletedAt).map((entry) => [entry.id, entry]));
  const stars = game.stars.filter(({ photo }) => records.get(photo.recordId)?.data.photos?.some(({ fileId }) => fileId === photo.fileId));
  const ids = new Set(stars.map(({ photo }) => photo.fileId));
  return { ...game, stars, lines: game.lines.filter(([from, to]) => ids.has(from) && ids.has(to)) };
}

const limit = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
type Drag = { id: string; pointer: number; clientX: number; clientY: number; from: StarPosition; point?: StarPosition };

export function StarMap({ service, game, selected, choose, move }: {
  service: UsService; game: Stars; selected?: string; choose?: (id: string) => void;
  move?: (id: string, point: StarPosition, from: StarPosition) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState<{ id: string; point: StarPosition }>();
  const viewport = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const dragging = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const active = service.active;
  const visible = useMemo(() => authorizedConstellation(game, active), [game, active]);
  const points = new Map(visible.stars.map(({ photo, x, y }) => [photo.fileId, preview?.id === photo.fileId ? preview.point : { x, y }]));

  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId || !field.current) return;
    const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
    if (!drag.point && Math.hypot(dx, dy) < 5) return;
    const { width, height } = field.current.getBoundingClientRect();
    drag.point = { x: limit(drag.from.x + dx * 100 / width), y: limit(drag.from.y + dy * 100 / height) };
    setPreview({ id: drag.id, point: drag.point });
  }

  function finish(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragging.current = null;
    setPreview(undefined);
    if (drag.point && commit && points.has(drag.id)) {
      swallowClick.current = true;
      choose?.(drag.id);
      if (drag.point.x !== drag.from.x || drag.point.y !== drag.from.y) move?.(drag.id, drag.point, drag.from);
    }
  }

  return <>
    <div className="play-star-map" ref={viewport} role="group" aria-label={game.name || "共创星图"}>
      <div className="play-star-plane" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
        <div className="play-star-field" ref={field}>
          {visible.lines.map(([first, second]) => {
            const a = points.get(first)!, b = points.get(second)!;
            return <i aria-hidden="true" key={first + second} style={{ left: a.x + "%", top: a.y + "%",
              width: Math.hypot(b.x - a.x, b.y - a.y) + "%", transform: `rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)` }} />;
          })}
          {visible.stars.map(({ photo }, index) => {
            const id = photo.fileId;
            const point = points.get(id)!;
            const style = { left: point.x + "%", top: point.y + "%" };
            return choose ? <button key={id} type="button" className="play-star-point" style={style} aria-label={`选择星点 ${index + 1}`}
              aria-pressed={selected === id} data-draggable={!!move || undefined}
              onPointerDown={(event) => {
                swallowClick.current = false;
                if (!move || !event.isPrimary || event.button !== 0) return;
                dragging.current = { id, pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, from: point };
                event.currentTarget.setPointerCapture(event.pointerId);
              }} onPointerMove={updateDrag} onPointerUp={(event) => finish(event, true)}
              onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)}
              onClick={(event) => { if (!swallowClick.current || event.detail === 0) choose(id); swallowClick.current = false; }}>✦</button>
              : <span key={id} style={style} aria-hidden="true">✦</span>;
          })}
        </div>
      </div>
    </div>
    {visible.stars.length > 0 && <div className="play-actions play-star-controls">
      <button type="button" disabled={zoom === 1} onClick={() => setZoom(zoom - 0.25)}>缩小星图</button>
      <span aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button type="button" disabled={zoom === 2} onClick={() => setZoom(zoom + 0.25)}>放大星图</button>
      {zoom > 1 && <button type="button" onClick={() => { setZoom(1); viewport.current?.scrollTo(0, 0); }}>复位星图</button>}
    </div>}
    {game.stars.length > visible.stars.length && <p>{game.stars.length - visible.stars.length} 颗星的照片已移除或暂不可用。</p>}
  </>;
}
