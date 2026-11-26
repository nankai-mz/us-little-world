import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { UsService } from "../../../src/core/service";
import { comicBackgrounds, paperColors, sortedItems, type CanvasItem, type Drawing, type Point, type StrokePreview } from "../../../src/features/canvas-core/canvas";
import type { WorkContent } from "../../../src/features/play-core/works";
import { download } from "../../platform";
import { acquirePhotoUrl } from "../../photoUrls";

type Pose = { x: number; y: number; zoom: number };
type Images = ReadonlyMap<string, HTMLImageElement>;
type Bounds = [left: number, top: number, right: number, bottom: number];
type SelectionBox = { start: Point; end: Point };
const center: Pose = { x: 0, y: 0, zoom: 1 };

function lines(ctx: CanvasRenderingContext2D, value: string, width: number) {
  return value.split("\n").flatMap((paragraph) => {
    const rows = [""];
    for (const character of paragraph) {
      const last = rows.length - 1;
      if (rows[last] && ctx.measureText(rows[last] + character).width > width) rows.push(character);
      else rows[last] += character;
    }
    return rows;
  });
}

export function drawLine(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ctx.fillStyle = color;
  for (let i = 0; i < points.length; i++) {
    const [x, y, pressure] = points[i];
    ctx.lineWidth = width * (0.55 + pressure * 0.9);
    ctx.beginPath();
    if (i) {
      const [fromX, fromY] = points[i - 1];
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else {
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function grouped(objects: CanvasItem[]) {
  const mapping = new Map(objects.map((object) => [object.id, object]));
  for (const group of objects) {
    if (group.kind !== "group") continue;
    const angle = group.angle * Math.PI / 180;
    for (const id of group.children) {
      const item = mapping.get(id);
      if (!item) continue;
      mapping.set(id, { ...item, angle: item.angle + group.angle,
        x: item.x * Math.cos(angle) - item.y * Math.sin(angle) + group.x,
        y: item.x * Math.sin(angle) + item.y * Math.cos(angle) + group.y });
    }
  }
  return mapping;
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function itemBounds(ctx: CanvasRenderingContext2D, item: CanvasItem, wishes: ReadonlyMap<string, string>): Bounds | undefined {
  let bounds: Bounds;
  if (item.kind === "stroke") {
    const [firstX, firstY] = item.points[0];
    bounds = [firstX, firstY, firstX, firstY];
    for (const [x, y] of item.points) bounds = mergeBounds(bounds, [x, y, x, y]);
    const margin = item.width;
    bounds = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
  } else if (item.kind === "shape") bounds = [-38, -28, 38, 28];
  else if (item.kind === "character") bounds = [-35, -55, 35, 37];
  else if (item.kind === "photo") bounds = [-78, -55, 78, 55];
  else if (item.kind === "sticker") bounds = [-17, -22, 20, 15];
  else if (item.kind === "group" || item.kind === "link") return undefined;
  else {
    ctx.font = "15px sans-serif";
    const value = item.kind === "wish" ? wishes.get(item.reference.recordId) ?? "愿望已移除" : item.text;
    const height = Math.max(42, lines(ctx, value, 136).length * 20 + 14);
    bounds = [-77, -height / 2, 77, height / 2 + (item.kind === "bubble" ? 10 : 0)];
  }
  const [left, top, right, bottom] = bounds;
  const angle = item.angle * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let result: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [[left, top], [left, bottom], [right, top], [right, bottom]]) {
    const worldX = item.x + cos * x - sin * y, worldY = item.y + sin * x + cos * y;
    result = mergeBounds(result, [worldX, worldY, worldX, worldY]);
  }
  return result;
}

function selectionBounds(ctx: CanvasRenderingContext2D, objects: CanvasItem[], wishes: ReadonlyMap<string, string>) {
  const mapping = grouped(objects);
  const groupByChild = new Map<string, string>();
  for (const item of objects) if (item.kind === "group") {
    for (const child of item.children) groupByChild.set(child, item.id);
  }
  const boxes = new Map<string, Bounds>();
  for (const item of objects) {
    const box = itemBounds(ctx, mapping.get(item.id)!, wishes);
    if (!box) continue;
    const id = groupByChild.get(item.id) ?? item.id;
    const previous = boxes.get(id);
    if (previous) boxes.delete(id);
    boxes.set(id, previous ? mergeBounds(previous, box) : box);
  }
  return boxes;
}

function paintCharacter(ctx: CanvasRenderingContext2D, item: Extract<CanvasItem, { kind: "character" }>) {
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#453746";
  ctx.fillStyle = item.color;
  ctx.beginPath();
  if (item.avatar === 1) {
    ctx.moveTo(-26, 0); ctx.lineTo(-31, -37); ctx.lineTo(-6, -20);
    ctx.lineTo(8, -20); ctx.lineTo(29, -37); ctx.lineTo(28, 0); ctx.quadraticCurveTo(26, 32, 0, 34);
    ctx.quadraticCurveTo(-26, 31, -26, 0); ctx.closePath();
  } else ctx.ellipse(0, 3, item.avatar === 2 ? 24 : 34, 32, 0, 0, 2 * Math.PI);
  ctx.fill(); ctx.stroke();
  if (item.avatar === 2) {
    ctx.beginPath(); ctx.roundRect(-29, -35, 58, 13, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-15, -53, 30, 24, 6); ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = "#30262e";
  for (const x of [-10, 10]) {
    const closed = item.expression === 4 || (item.expression === 8 && x < 0);
    ctx.beginPath();
    if (closed) { ctx.moveTo(x - 3, 0); ctx.lineTo(x + 3, 0); ctx.stroke(); }
    else { ctx.ellipse(x, item.expression === 7 ? -3 : 1, 2.5, item.expression === 2 ? 5 : 3, 0, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.beginPath();
  if (item.expression === 1 || item.expression === 2) {
    ctx.ellipse(0, 13, item.expression === 1 ? 8 : 4, item.expression === 1 ? 4 : 6, 0, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    ctx.moveTo(-6, 13);
    ctx.quadraticCurveTo(0, [5, 9].includes(item.expression) ? 6 : [3, 4].includes(item.expression) ? 13 : 18, 6, 13);
    ctx.stroke();
  }
  if (item.expression === 6 || item.expression === 9) {
    ctx.fillStyle = item.expression === 6 ? "#e99a95" : "#92b9d3";
    ctx.beginPath(); ctx.ellipse(-17, 9, 4, 2.5, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.ellipse(17, 9, 4, 2.5, 0, 0, 2 * Math.PI); ctx.fill();
  }
}

function fillFrame(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
  paper: Drawing["paper"], background?: string) {
  const scene = background && background !== "paper" && Object.hasOwn(comicBackgrounds, background)
    ? comicBackgrounds[background as keyof typeof comicBackgrounds] : undefined;
  ctx.fillStyle = scene?.sky ?? paperColors[paper];
  ctx.fillRect(x, y, width, height);
  if (!scene) return;
  ctx.fillStyle = scene.floor;
  ctx.fillRect(x, y + height * 0.72, width, height * 0.28);
  ctx.fillStyle = "#ffffff62";
  ctx.beginPath(); ctx.roundRect(x + width * 0.06, y + height * 0.09, width * 0.22, height * 0.19, 7); ctx.fill();
}

export function paintBoard(ctx: CanvasRenderingContext2D, objects: CanvasItem[], images: Images, wishes: ReadonlyMap<string, string>) {
  const mapping = grouped(objects);
  for (const object of objects) {
    const item = mapping.get(object.id)!;
    if (item.kind === "group") continue;
    ctx.save();
    if (item.kind === "link") {
      const from = mapping.get(item.from), to = mapping.get(item.to);
      if (from && to) drawLine(ctx, [[from.x, from.y, 0.4], [to.x, to.y, 0.4]], item.color, 2);
      ctx.restore();
      continue;
    }
    ctx.translate(item.x, item.y);
    ctx.rotate(item.angle * Math.PI / 180);
    switch (item.kind) {
      case "stroke":
        drawLine(ctx, item.points, item.color, item.width);
        break;
      case "shape":
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        if (item.shape === "rect") ctx.rect(-36, -23, 72, 46);
        if (item.shape === "ellipse") ctx.ellipse(0, 0, 36, 25, 0, 0, Math.PI * 2);
        if (item.shape === "line") { ctx.moveTo(-35, 12); ctx.lineTo(35, -12); }
        ctx.stroke();
        break;
      case "character":
        paintCharacter(ctx, item);
        break;
      case "photo": {
        const image = images.get(item.reference.fileId ?? "");
        ctx.fillStyle = "#f6eadc";
        ctx.fillRect(-78, -55, 156, 110);
        if (image) {
          const scale = Math.min(148 / image.width, 100 / image.height);
          const width = image.width * scale, height = image.height * scale;
          ctx.drawImage(image, -width / 2, -height / 2, width, height);
        } else {
          ctx.font = "14px sans-serif"; ctx.fillStyle = "#66584c"; ctx.fillText("照片暂不可用", -46, 0);
        }
        break;
      }
      case "text":
      case "bubble":
      case "sticky":
      case "sticker":
      case "wish": {
        const text = item.kind === "wish" ? wishes.get(item.reference.recordId) ?? "愿望已移除" : item.text;
        if (item.kind === "sticker") { ctx.font = "32px sans-serif"; ctx.fillText(text, -16, 12); break; }
        ctx.font = "15px sans-serif";
        const rows = lines(ctx, text, 136);
        const cardHeight = Math.max(42, rows.length * 20 + 14);
        if (item.kind !== "text") {
          ctx.fillStyle = item.kind === "bubble" ? "#ffffff" : item.kind === "wish" ? "#e5ecde" : "#f9edc9";
          ctx.strokeStyle = "#b7a58e";
          ctx.beginPath();
          ctx.roundRect(-77, -cardHeight / 2, 154, cardHeight, item.kind === "bubble" ? 14 : 4);
          ctx.fill();
          ctx.stroke();
          if (item.kind === "bubble") {
            ctx.beginPath();
            ctx.moveTo(-34, cardHeight / 2); ctx.lineTo(-46, cardHeight / 2 + 10); ctx.lineTo(-20, cardHeight / 2);
            ctx.fill(); ctx.stroke();
          }
        }
        ctx.fillStyle = item.kind === "wish" ? "#384635" : item.color;
        rows.forEach((row, index) => ctx.fillText(row, -68, -cardHeight / 2 + 20 + index * 20));
        break;
      }
    }
    ctx.restore();
  }
}

function assets(service: UsService, objects: CanvasItem[]) {
  const wanted = new Map(objects.flatMap((object) => object.kind === "photo" && object.reference.fileId
    ? [[object.reference.fileId, object.reference.recordId] as const] : []));
  const shared = new Map(service.active.filter((entry) => entry.visibility === "shared").map((entry) => [entry.id, entry]));
  const files = [...wanted].flatMap(([fileId, id]) => {
    const file = shared.get(id)?.data.photos?.find((photo) => photo.fileId === fileId);
    return file ? [[fileId, file] as const] : [];
  });
  const wishes = new Map(objects.flatMap((object) => {
    if (object.kind !== "wish") return [];
    const entry = shared.get(object.reference.recordId);
    if (entry?.data.kind !== "wish") return [];
    const { title, completedAt, wishTargetDate } = entry.data;
    const target = wishTargetDate ? `\n目标 ${wishTargetDate}` : "";
    return [[entry.id, `${completedAt ? "✓ " : "○ "}${title}${target}`] as const];
  }));
  return { files, wishes };
}

async function loadImages(service: UsService, files: ReturnType<typeof assets>["files"], disposals: (() => void)[]) {
  const images: Map<string, HTMLImageElement> = new Map();
  await Promise.all(files.map(async ([fileId, file]) => {
    try {
      const token = acquirePhotoUrl(service, file, "shared");
      disposals.push(token.release);
      const image = new Image();
      image.src = await token.loaded;
      await image.decode();
      images.set(fileId, image);
    } catch { /* Deleted, unauthorized or offline photos leave a visible placeholder. */ }
  }));
  return images;
}

const eraserRadius = 8;

export function CanvasBoard({ service, objects, paper, camera = center, label, enabled, onStroke, onErase, onDrawActivity, canStartStroke, onPan,
  remote, showPartnerCursor, onPreview, onPreviewEnd, onSelect, selected, lowResolution, background, color = "#392f2c", width = 3 }: {
  service: UsService; objects: CanvasItem[]; paper: Drawing["paper"]; camera?: Pose; label: string;
  enabled?: boolean; onStroke?: (points: Point[], x: number, y: number) => void;
  onErase?: (path: Point[], radius: number) => void;
  onDrawActivity?: (active: boolean) => void;
  canStartStroke?: () => boolean;
  onPan?: (dx: number, dy: number) => void; color?: string; width?: number;
  remote?: StrokePreview | null; showPartnerCursor?: boolean;
  onPreview?: (points: Point[], x: number, y: number) => void;
  onPreviewEnd?: () => void;
  onSelect?: (ids: string[]) => void;
  selected?: string[];
  lowResolution?: boolean;
  background?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const backing = useRef<HTMLCanvasElement | null>(null);
  const gesture = useRef<{ mode: "draw" | "erase" | "pan" | "select"; pointer: number; start: Point; points: Point[]; box?: SelectionBox } | null>(null);
  const animation = useRef<number | undefined>(undefined);
  const latestPaint = useRef<() => void>(() => {});
  const boxes = useRef(new Map<string, Bounds>());
  const [extent, setExtent] = useState([500, 360]);
  const [images, setImages] = useState<Images>(new Map());
  const available = useMemo(() => assets(service, objects), [service, service.entries, objects]);
  const filesKey = available.files.map(([id]) => id).sort().join(":");

  useEffect(() => {
    const element = canvas.current!;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      setExtent([Math.max(1, Math.round(contentRect.width)), Math.max(1, Math.round(contentRect.height))]);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    const releases: (() => void)[] = [];
    setImages(new Map());
    void loadImages(service, available.files, releases).then((images) => { if (live) setImages(images); });
    return () => { live = false; for (const release of releases) release(); };
  }, [service, filesKey]);

  const [w, h] = extent;
  const scale = lowResolution ? 1 : Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
  const selecting = !!onSelect || !!selected?.length;
  const { x: cameraX, y: cameraY, zoom } = camera;
  const transform = (ctx: CanvasRenderingContext2D) => {
    ctx.setTransform(scale * zoom, 0, 0, scale * zoom, (w / 2 - cameraX * zoom) * scale, (h / 2 - cameraY * zoom) * scale);
  };

  useLayoutEffect(() => {
    const base = backing.current ??= document.createElement("canvas");
    if (base.width !== Math.round(w * scale) || base.height !== Math.round(h * scale)) {
      base.width = Math.round(w * scale);
      base.height = Math.round(h * scale);
    }
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    fillFrame(ctx, 0, 0, w, h, paper, background);
    if (paper === "grid") {
      const grid = 24 * zoom;
      ctx.fillStyle = "#dcd2c28f";
      for (let x = ((w / 2 - cameraX * zoom) % grid + grid) % grid; x < w; x += grid)
        for (let y = ((h / 2 - cameraY * zoom) % grid + grid) % grid; y < h; y += grid) ctx.fillRect(x, y, 1, 1);
    }
    transform(ctx);
    paintBoard(ctx, objects, images, available.wishes);
    boxes.current = selecting ? selectionBounds(ctx, objects, available.wishes) : new Map();
  }, [objects, images, available, paper, background, w, h, scale, cameraX, cameraY, zoom, selecting]);

  function paint() {
    const element = canvas.current;
    const base = backing.current;
    const ctx = element?.getContext("2d");
    if (!element || !base || !ctx) return;
    if (element.width !== base.width || element.height !== base.height) {
      element.width = base.width;
      element.height = base.height;
    }
    ctx.resetTransform();
    ctx.drawImage(base, 0, 0);
    transform(ctx);
    if (remote) {
      ctx.save();
      ctx.translate(remote.x, remote.y);
      drawLine(ctx, remote.points, remote.color, remote.width);
      const tip = remote.points.at(-1);
      if (showPartnerCursor && tip) {
        ctx.beginPath();
        ctx.arc(tip[0], tip[1], 9 / zoom, 0, Math.PI * 2);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 5 / zoom;
        ctx.stroke();
        ctx.strokeStyle = "#176a77";
        ctx.lineWidth = 2.5 / zoom;
        ctx.stroke();
      }
      ctx.restore();
    }
    const active = gesture.current;
    if (active?.mode === "draw") {
      ctx.save();
      ctx.translate(active.start[0], active.start[1]);
      drawLine(ctx, active.points, color, width);
      ctx.restore();
    }
    if (active?.mode === "erase") {
      ctx.save();
      ctx.translate(active.start[0], active.start[1]);
      ctx.globalAlpha = .32;
      drawLine(ctx, active.points, "#963b5a", eraserRadius * 2 / zoom);
      ctx.restore();
    }
    if (selected?.length || active?.box) {
      ctx.strokeStyle = "#466b87";
      ctx.lineWidth = 1.5 / zoom;
      ctx.setLineDash([5 / zoom, 3 / zoom]);
      for (const id of selected ?? []) {
        const box = boxes.current.get(id);
        if (box) ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      }
      if (active?.box) {
        const { start, end } = active.box;
        ctx.fillStyle = "#466b8726";
        ctx.fillRect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
        ctx.strokeRect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
      }
      ctx.setLineDash([]);
    }
  }
  function schedulePaint() {
    if (animation.current !== undefined) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = undefined;
      latestPaint.current();
    });
  }
  useLayoutEffect(() => {
    latestPaint.current = paint;
    schedulePaint();
  });
  useLayoutEffect(() => () => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
    if (backing.current) backing.current.width = backing.current.height = 0;
    backing.current = null;
  }, []);

  function world(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.round(((event.clientX - rect.left - rect.width / 2) / camera.zoom + camera.x) * 10) / 10,
      Math.round(((event.clientY - rect.top - rect.height / 2) / camera.zoom + camera.y) * 10) / 10,
      event.pointerType === "pen" ? Math.round(event.pressure * 100) / 100 : 0.5];
  }

  function finishGesture(pointer: number) {
    const active = gesture.current;
    if (!active || active.pointer !== pointer) return;
    gesture.current = null;
    if (active.mode === "draw") onPreviewEnd?.();
    if (active.mode === "draw" || active.mode === "erase") onDrawActivity?.(false);
    schedulePaint();
    return active;
  }

  return <canvas className="play-canvas" aria-label={label} data-input={onErase ? "eraser" : enabled || !!onPan || !!onSelect ? "drawing" : undefined} ref={canvas}
    onPointerDown={(event) => {
      const mode = onErase ? "erase" : onSelect ? "select" : onPan ? "pan" : enabled ? "draw" : undefined;
      if (!mode || gesture.current || (event.button !== 0 && event.pointerType === "mouse")) return;
      if ((mode === "draw" || mode === "erase") && canStartStroke?.() === false) return;
      const start = world(event);
      gesture.current = { mode, pointer: event.pointerId, start, points: [[0, 0, mode === "erase" ? .5 : start[2]]] };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (mode === "draw" || mode === "erase") onDrawActivity?.(true);
      if (mode === "draw") onPreview?.(gesture.current.points, start[0], start[1]);
      schedulePaint();
    }}
    onPointerMove={(event) => {
      const stroke = gesture.current;
      if (!stroke || stroke.pointer !== event.pointerId || stroke.mode === "pan") return;
      const point = world(event);
      if (stroke.mode === "select") {
        stroke.box = { start: stroke.start, end: point };
        schedulePaint();
        return;
      }
      if (stroke.points.length >= 700) stroke.points = stroke.points.filter((_, index) => index % 2 === 0);
      stroke.points.push([Math.round((point[0] - stroke.start[0]) * 10) / 10,
        Math.round((point[1] - stroke.start[1]) * 10) / 10, stroke.mode === "erase" ? .5 : point[2]]);
      if (stroke.mode === "draw" && enabled && onPreview) {
        const stride = Math.max(1, Math.ceil(stroke.points.length / 124));
        const points = stroke.points.filter((_, i) => i % stride === 0);
        if (points.at(-1) !== stroke.points.at(-1)) points.push(stroke.points.at(-1)!);
        onPreview(points, stroke.start[0], stroke.start[1]);
      }
      schedulePaint();
    }}
    onPointerUp={(event) => {
      const stroke = finishGesture(event.pointerId);
      if (!stroke) return;
      const [x, y] = world(event);
      const [fromX, fromY] = stroke.start;
      if (stroke.mode === "pan") onPan?.(fromX - x, fromY - y);
      else if (stroke.mode === "erase" && onErase) {
        const trace: Point[] = stroke.points.map(([dx, dy]) => [fromX + dx, fromY + dy, .5]);
        trace.push([x, y, .5]);
        onErase(trace, eraserRadius / zoom);
      }
      else if (stroke.mode === "select" && onSelect) {
        const point = Math.hypot(x - fromX, y - fromY) * zoom < 5;
        const tolerance = point ? 7 / zoom : 0;
        const [left, right] = [Math.min(x, fromX) - tolerance, Math.max(x, fromX) + tolerance];
        const [top, bottom] = [Math.min(y, fromY) - tolerance, Math.max(y, fromY) + tolerance];
        const ids = [...boxes.current].filter(([, box]) => left <= box[2] && right >= box[0] &&
          top <= box[3] && bottom >= box[1]).map(([id]) => id);
        onSelect(point ? ids.slice(-1) : ids);
      } else if (stroke.mode === "draw" && enabled) onStroke?.(stroke.points, fromX, fromY);
    }}
    onLostPointerCapture={(event) => { finishGesture(event.pointerId); }}
    onPointerCancel={(event) => { finishGesture(event.pointerId); }} />;
}

type CanvasWork = NonNullable<WorkContent["canvas"]>;

function frameCenter(objects: CanvasItem[]): Pose {
  const drawing = [...grouped(objects).values()].filter((item) => item.kind !== "group" && item.kind !== "link");
  const points = drawing.flatMap((item) => item.kind === "stroke"
    ? item.points.map(([x, y]) => [item.x + x, item.y + y]) : [[item.x - 80, item.y - 60], [item.x + 80, item.y + 60]]);
  if (!points.length) return center;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { x: (left + right) / 2, y: (top + bottom) / 2, zoom: Math.min(1, 250 / Math.max(1, right - left, bottom - top)) };
}

export function CanvasWorkCover({ service, work, panel }: { service: UsService; work: CanvasWork; panel: number }) {
  const objects = useMemo(() => sortedItems(work.objects, panel).slice(-120), [work.objects, panel]);
  const camera = useMemo(() => {
    const frame = frameCenter(objects);
    return { ...frame, zoom: frame.zoom * 0.20 };
  }, [objects]);
  return <CanvasBoard service={service} paper={work.paper} objects={objects} camera={camera} background={work.backgrounds?.[panel]}
    label="画作封面" lowResolution />;
}

export function CanvasWorkPreview({ service, work }: { service: UsService; work: CanvasWork }) {
  const frames = work.frames.length ? work.frames : [""];
  return <div className={frames.length > 1 ? "play-comic" : "play-canvas-work"}>
    {work.cover && <h3>{work.cover}</h3>}
    {frames.map((caption, panel) => {
      const objects = sortedItems(work.objects, panel);
      return <div key={panel}>
        <CanvasBoard service={service} paper={work.paper} objects={objects} camera={frameCenter(objects)} background={work.backgrounds?.[panel]}
          label={caption || (frames.length > 1 ? "分镜 " + (panel + 1) : "画作预览")} />
        {caption && <p>{caption}</p>}
      </div>;
    })}
    {work.ending && <p>{work.ending}</p>}
  </div>;
}

export async function exportCanvasWork(service: UsService, work: CanvasWork, id: string) {
  const releases: (() => void)[] = [];
  try {
    const { files, wishes } = assets(service, work.objects);
    const images = await loadImages(service, files, releases);
    if (!service.ready) return;
    const canvas = document.createElement("canvas");
    const frames = work.frames.length ? work.frames : [""];
    const columns = frames.length > 1 ? 2 : 1;
    const rows = Math.ceil(frames.length / columns);
    const header = work.cover ? 70 : 0;
    const footer = work.ending ? 70 : 0;
    canvas.width = columns * 620 + 32;
    canvas.height = header + footer + rows * 460 + 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fffdf7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "22px sans-serif";
    ctx.fillStyle = "#49362c";
    if (work.cover) ctx.fillText(work.cover, 25, 45, canvas.width - 48);
    if (work.ending) ctx.fillText(work.ending, 25, canvas.height - 26, canvas.width - 48);
    frames.forEach((caption, index) => {
      const objects = sortedItems(work.objects, index);
      const camera = frameCenter(objects);
      const x = 16 + index % columns * 620;
      const y = 16 + header + Math.floor(index / columns) * 460;
      fillFrame(ctx, x, y, 600, 420, work.paper, work.backgrounds?.[index]);
      ctx.strokeStyle = "#a88d76";
      ctx.strokeRect(x, y, 600, 420);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, 600, 420); ctx.clip();
      const scale = camera.zoom * 1.55;
      ctx.translate(x + 300, y + 210);
      ctx.scale(scale, scale);
      ctx.translate(-camera.x, -camera.y);
      paintBoard(ctx, objects, images, wishes);
      ctx.restore();
      if (caption) { ctx.fillStyle = "#49362c"; ctx.fillText(caption, x + 5, y + 447, 590); }
    });
    const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!image) throw new Error("图片导出暂时失败");
    if (service.ready) download("Us-" + id.slice(0, 8) + ".png", image);
  } finally { for (const release of releases) release(); }
}
