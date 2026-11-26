import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { buildGalaxy, drawGalaxyStar, type GalaxyStar } from "../src/core/galaxy";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";

export type GalaxyView = { view?: "map" | "list"; selected?: string; zoom: number; year: string; page: number };
const initialPageSize = 30;
const maxMapStars = 300;

export function MemoryGalaxy({ entries, allEntries, service, state, setState, scrollPosition, reduceMotion, openMemory }: {
  entries: Entry[];
  allEntries: Entry[];
  service: UsService;
  state: GalaxyView;
  setState: Dispatch<SetStateAction<GalaxyView>>;
  scrollPosition: { left: number; top: number };
  reduceMotion: boolean;
  openMemory: (entry: Entry) => void;
}) {
  const stars = useMemo(() => buildGalaxy(entries), [entries]);
  const years = useMemo(() => [...new Set(allEntries.flatMap((entry) =>
    entry.visibility === "shared" && !entry.deletedAt && entry.data.kind === "memory" &&
      entry.data.photos?.some((photo) => photo.fileId || photo.sample) ? [entry.data.date.slice(0, 4)] : [],
  ))].filter(Boolean).sort().reverse(), [allEntries]);
  const visible = useMemo(() => stars.filter(({ year }) => !state.year || year === state.year), [stars, state.year]);
  const selected = visible.find((star) => star.id === state.selected);
  const canMap = visible.length <= maxMapStars;
  const mode = canMap && (state.view === "map" || (!state.view && !reduceMotion)) ? "map" : "list";
  const pages = Math.max(1, Math.ceil(visible.length / initialPageSize));
  const page = Math.min(state.page, pages - 1);
  const panel = useRef<HTMLElement>(null);
  const map = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; scrollX: number; scrollY: number; moved: boolean }>(null);
  const suppressClick = useRef(false);
  const lastTrigger = useRef<HTMLElement>(null);
  const focusPanel = useRef(false);
  useEffect(() => {
    if (state.selected && !selected) setState((previous) => ({ ...previous, selected: undefined }));
  }, [selected, setState, state.selected]);
  useEffect(() => {
    if (map.current && mode === "map") map.current.scrollTo(scrollPosition.left, scrollPosition.top);
  }, [mode, scrollPosition]);
  useEffect(() => {
    if (selected && focusPanel.current) {
      panel.current?.focus({ preventScroll: true });
      focusPanel.current = false;
    }
  }, [selected]);
  const change = (patch: Partial<GalaxyView>) => setState((previous) => ({ ...previous, ...patch }));
  function select(star: GalaxyStar, trigger?: HTMLElement) {
    if (trigger) lastTrigger.current = trigger;
    if (selected?.id === star.id) panel.current?.focus({ preventScroll: true });
    else focusPanel.current = true;
    change({ selected: star.id });
  }
  function movePhoto(offset: number) {
    if (!selected || visible.length < 2) return;
    const next = (visible.indexOf(selected) + offset + visible.length) % visible.length;
    select(visible[next]);
  }
  return (
    <section className="galaxy" aria-label="回忆银河">
      <div className="galaxy-header">
        <h2>回忆银河</h2>
        <label>年份 <select value={state.year} onChange={(event) => change({ year: event.target.value, page: 0, selected: undefined })}>
          <option value="">全部年份</option>
          {years.map((year) => <option key={year}>{year}</option>)}
        </select></label>
        <div className="galaxy-buttons">
          <button type="button" className="secondary" disabled={!canMap} aria-pressed={mode === "map"}
            onClick={() => change({ view: "map" })}>星图</button>
          <button type="button" className="secondary" aria-pressed={mode === "list"}
            onClick={() => change({ view: "list" })}>照片列表</button>
          <button type="button" className="secondary" disabled={!visible.length} onClick={(event) => {
            const word = new Uint32Array(1);
            const star = drawGalaxyStar(visible, () => crypto.getRandomValues(word)[0]);
            if (star) select(star, event.currentTarget);
          }}>随机流星</button>
        </div>
        {!canMap && <p>照片较多，已切换到分页列表。</p>}
      </div>
      {!visible.length && <p>当前筛选范围内没有可查看的共同照片。</p>}
      {visible.length > 0 && mode === "map" && (
        <>
          <div className="galaxy-buttons">
            <button type="button" className="secondary" disabled={state.zoom <= 1} onClick={() => change({ zoom: state.zoom - 0.25 })}>缩小</button>
            <button type="button" className="secondary" disabled={state.zoom >= 2} onClick={() => change({ zoom: state.zoom + 0.25 })}>放大</button>
          </div>
          <div className="galaxy-months" aria-label="星点按月份从左至右分布">
            <span>1–3 月</span><span>4–6 月</span><span>7–9 月</span><span>10–12 月</span>
          </div>
          <div className={`galaxy-viewport${state.zoom > 1 ? " galaxy-pannable" : ""}`} ref={map}
            onScroll={(event) => {
              scrollPosition.left = event.currentTarget.scrollLeft;
              scrollPosition.top = event.currentTarget.scrollTop;
            }}
            onPointerDown={(event) => {
              if (!event.isPrimary) return;
              drag.current = null;
              suppressClick.current = false;
              if (event.pointerType !== "mouse" || event.button !== 0 || state.zoom <= 1) return;
              drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
                scrollX: event.currentTarget.scrollLeft, scrollY: event.currentTarget.scrollTop, moved: false };
            }}
            onPointerMove={(event) => {
              const pan = drag.current;
              if (!pan || pan.pointer !== event.pointerId || event.buttons !== 1) return;
              const x = event.clientX - pan.x;
              const y = event.clientY - pan.y;
              if (!pan.moved && Math.abs(x) + Math.abs(y) < 8) return;
              if (!pan.moved) event.currentTarget.setPointerCapture(event.pointerId);
              pan.moved = true;
              event.currentTarget.scrollTo(pan.scrollX - x, pan.scrollY - y);
            }}
            onPointerUp={(event) => {
              if (drag.current?.pointer !== event.pointerId) return;
              suppressClick.current = drag.current.moved;
              drag.current = null;
            }}
            onPointerCancel={() => { drag.current = null; }}
            onLostPointerCapture={() => { drag.current = null; }}
            onClickCapture={(event) => {
              if (event.detail > 0 && suppressClick.current) {
                event.preventDefault();
                event.stopPropagation();
                suppressClick.current = false;
              }
            }}>
            <div className="galaxy-map" style={{ width: `${state.zoom * 100}%`, height: `${state.zoom * 100}%` }}>
              {visible.map((star) => (
                <button key={star.id} type="button" className={`galaxy-star galaxy-color-${star.color}`}
                  style={{ left: `${star.x}%`, top: `${star.y}%` }} aria-label={`打开 ${star.memory.data.title} · ${star.memory.data.date} · ${star.photo.name || "照片"}`}
                  title={`${star.memory.data.date} · ${star.memory.data.title}`}
                  aria-pressed={selected?.id === star.id} onClick={(event) => select(star, event.currentTarget)} />
              ))}
            </div>
          </div>
        </>
      )}
      {visible.length > 0 && mode === "list" && (
        <>
          <ul className="galaxy-list">
            {visible.slice(page * initialPageSize, (page + 1) * initialPageSize).map((star) => (
              <li key={star.id}><button type="button" className="secondary" aria-pressed={selected?.id === star.id}
                onClick={(event) => select(star, event.currentTarget)}>
                {star.memory.data.date} · {star.memory.data.title} · {star.photo.name || "照片"}
              </button></li>
            ))}
          </ul>
          {pages > 1 && <div className="galaxy-buttons">
            <button type="button" className="secondary" disabled={!page} onClick={() => change({ page: page - 1 })}>上一页</button>
            <span>{page + 1} / {pages}</span>
            <button type="button" className="secondary" disabled={page + 1 >= pages} onClick={() => change({ page: page + 1 })}>下一页</button>
          </div>}
        </>
      )}
      {selected && <section ref={panel} tabIndex={-1} className="galaxy-photo" aria-label="选中的回忆照片">
        <h3>{selected.memory.data.title}</h3>
        <p>{selected.memory.data.date}{selected.memory.data.tags?.length ? ` · ${selected.memory.data.tags.join("、")}` : ""}</p>
        <SharedMemoryPhoto key={selected.id} photo={selected.photo} service={service} title={selected.memory.data.title} />
        <div className="galaxy-buttons">
          <button type="button" className="secondary" disabled={visible.length < 2} onClick={() => movePhoto(-1)}>上一张</button>
          <button type="button" className="secondary" disabled={visible.length < 2} onClick={() => movePhoto(1)}>下一张</button>
          <button type="button" className="primary" onClick={() => openMemory(selected.memory)}>打开原日记</button>
          <button type="button" className="secondary" onClick={() => {
            change({ selected: undefined });
            lastTrigger.current?.focus();
          }}>关闭照片</button>
        </div>
      </section>}
    </section>
  );
}
