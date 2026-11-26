import type { CanvasItem, Point } from "./canvas";

type Position = readonly [number, number];
type Bounds = { left: number; right: number; top: number; bottom: number };
type Segment = Bounds & { from: Position; to: Position };

function segment(from: Position, to: Position): Segment {
  return { from, to, left: Math.min(from[0], to[0]), right: Math.max(from[0], to[0]),
    top: Math.min(from[1], to[1]), bottom: Math.max(from[1], to[1]) };
}

function overlaps(a: Bounds, b: Bounds, margin: number) {
  return a.left <= b.right + margin && a.right + margin >= b.left && a.top <= b.bottom + margin && a.bottom + margin >= b.top;
}

function side(a: Position, b: Position, p: Position) {
  return Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
}

function distanceSquared(point: Position, line: Segment) {
  const dx = line.to[0] - line.from[0], dy = line.to[1] - line.from[1];
  const x = point[0] - line.from[0], y = point[1] - line.from[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.min(1, Math.max(0, (x * dx + y * dy) / length)) : 0;
  return (x - t * dx) ** 2 + (y - t * dy) ** 2;
}

function hits(a: Segment, b: Segment, radius: number) {
  if (!overlaps(a, b, radius)) return false;
  if (overlaps(a, b, 0) && side(a.from, a.to, b.from) * side(a.from, a.to, b.to) <= 0 &&
    side(b.from, b.to, a.from) * side(b.from, b.to, a.to) <= 0) return true;
  const limit = radius * radius;
  return distanceSquared(a.from, b) <= limit || distanceSquared(a.to, b) <= limit ||
    distanceSquared(b.from, a) <= limit || distanceSquared(b.to, a) <= limit;
}

export function strokesUnderEraser(objects: CanvasItem[], trace: Point[], radius: number) {
  if (!trace.length) return [];
  const path = trace.map(([x, y], i) => {
    const [fromX, fromY] = trace[Math.max(0, i - 1)];
    return segment([fromX, fromY], [x, y]);
  });
  const area = { ...path[0] };
  for (const line of path) {
    area.left = Math.min(area.left, line.left);
    area.right = Math.max(area.right, line.right);
    area.top = Math.min(area.top, line.top);
    area.bottom = Math.max(area.bottom, line.bottom);
  }
  return objects.filter((item) => {
    if (item.kind !== "stroke") return false;
    const angle = item.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const points: Position[] = item.points.map(([x, y]) => [item.x + x * cos - y * sin, item.y + x * sin + y * cos]);
    return points.some((to, i) => {
      const ink = segment(points[Math.max(0, i - 1)], to);
      const thickness = item.width * (0.55 + item.points[i][2] * 0.9) / 2;
      const reach = radius + thickness;
      return overlaps(ink, area, reach) && path.some((sweep) => hits(ink, sweep, reach));
    });
  }).map(({ id, version }) => ({ id, version }));
}
