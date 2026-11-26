import type { Seat } from "../play-core/protocol";

export type Coord = [number, number];
export type MazeLevel = { name: string; rows: string[]; start: [Coord, Coord]; exit: Coord;
  controls: [Coord, Coord]; stars: Coord[]; box: Coord | null; portals: [Coord, Coord] | null };
type Lock = { name: string; kind: "box" | "mirror" | "dial" | "lamp" | "door";
  role: Seat; code: string; clue: string; hint: string };
export type EscapeLevel = { name: string; areas: [string, string]; locks: Lock[] };
export type LevelCampaign = { version: 1; g11: EscapeLevel[]; g12: MazeLevel[]; g13: MazeLevel[] };

const lockKinds = new Set(["box", "mirror", "dial", "lamp", "door"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export const sameCell = (a: Coord, b: Coord) => a[0] === b[0] && a[1] === b[1];

export function validateLevel(value: unknown): value is MazeLevel {
  if (!isRecord(value)) return false;
  const { name, rows, start, controls, stars, exit, box, portals } = value;
  if (!isText(name) || !Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "string") return false;
  const width = rows[0].length;
  if (width < 7 || !rows.every((row, index) => typeof row === "string" && row.length === width &&
    /^[#.GD]+$/.test(row) && row.startsWith("#") && row.endsWith("#") &&
    ((index !== 0 && index !== rows.length - 1) || /^#+$/.test(row)))) return false;

  const floor = (point: unknown): point is Coord => {
    return Array.isArray(point) && point.length === 2 && point.every(Number.isInteger) && rows[point[1]]?.[point[0]] === ".";
  };
  function pair(points: unknown): points is [Coord, Coord] {
    return Array.isArray(points) && points.length === 2 && points.every(floor);
  }
  return pair(start) && pair(controls) && !sameCell(...controls) && floor(exit) &&
    Array.isArray(stars) && stars.every(floor) && new Set(stars.map((point) => point.join(","))).size === stars.length &&
    (box === null || floor(box)) && (portals === null || (pair(portals) && !sameCell(...portals))) &&
    rows.join("").split("G").length === 2;
}

function validateEscape(value: unknown): value is EscapeLevel {
  if (!isRecord(value)) return false;
  const { name, areas, locks } = value;
  return isText(name) && Array.isArray(areas) && areas.length === 2 && areas.every(isText) && areas[0] !== areas[1] &&
    Array.isArray(locks) && locks.length >= 5 && locks.length <= 8 && locks.every((lock) =>
      isRecord(lock) && isText(lock.name) && isText(lock.kind) && lockKinds.has(lock.kind) &&
      (lock.role === 0 || lock.role === 1) && isText(lock.clue) && isText(lock.hint) && isText(lock.code) &&
      lock.code.length <= 12 && lock.code === lock.code.trim().toLowerCase()) &&
    new Set(locks.map(({ name }) => name)).size === locks.length && new Set(locks.map(({ role }) => role)).size === 2;
}

function campaignLevels<T>(id: keyof Omit<LevelCampaign, "version">, value: unknown, validate: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${id} 缺少关卡列表`);
  return value.map((item, index) => {
    if (!validate(item)) throw new Error(`${id} 第 ${index + 1} 关的关卡配置无效`);
    return item;
  });
}

export function parseCampaign(value: unknown): LevelCampaign {
  if (!isRecord(value) || value.version !== 1) throw new Error("关卡配置须使用版本 1");
  const g11 = campaignLevels("g11", value.g11, validateEscape);
  const g12 = campaignLevels("g12", value.g12, validateLevel);
  const g13 = campaignLevels("g13", value.g13, validateLevel);
  for (const [index, level] of g12.entries()) {
    if (!level.stars.length || level.rows.some((row) => row.includes("D")))
      throw new Error(`g12 第 ${index + 1} 关应有星尘，且只使用双人压力板开门`);
  }
  for (const [index, level] of g13.entries()) {
    if (!level.rows.some((row) => row.includes("D"))) throw new Error(`g13 第 ${index + 1} 关缺少影门`);
  }
  return { version: 1, g11, g12, g13 };
}
