import { AppError } from "../../core/types";
import { memoryIdPattern, playIdPattern, type Seat } from "../play-core/protocol";
import {
  escapeRooms, flightBadges, furniture, ingredients, kitchens, orders, planetTiles, sameCell, shadowLevels, spaceLevels, stargazingTiles,
  validateLevel, type Coord, type FlightBadge,
} from "./levels";

export type Explorer = { id: "g12" | "g13"; level: number; avatars: [Coord, Coord]; lit: [boolean, boolean];
  stars: number[]; box: Coord | null; solved: number[]; tribute: string | null; tributePhoto?: string;
  badges?: [FlightBadge | null, FlightBadge | null] };
export type Escape = { id: "g11"; level: number; solved: number; finished: number[] };
type Food = { ingredient: number; stage: "raw" | "washed" | "cut" | "cooked" };
export type Kitchen = { id: "g04"; map: number; order: number | null; avatars: [Coord, Coord];
  carrying: [Food | null, Food | null]; table: Food | null; plated: number[]; deadline: number; served: number[] };
export type Decoration = { key: string; kind: string; x: number; y: number; angle: number; memory?: string; photo?: string; revision: number };
export type World = { id: "c17" | "w23"; decorations: Decoration[]; recent: string; stargazingDecorations?: true };
export type SceneGame = Explorer | Escape | Kitchen | World;
export type SceneCommand =
  | { type: "scene.move"; from: Coord; to: Coord }
  | { type: "scene.use"; from?: Coord }
  | { type: "scene.next" }
  | { type: "scene.tribute"; id: string; photo?: string }
  | { type: "scene.badge"; badge: FlightBadge | null; previous: FlightBadge | null }
  | { type: "escape.solve"; stage: number; value: string }
  | { type: "kitchen.start"; map: number; order: number; at: number }
  | { type: "kitchen.use"; ingredient: number; at: number }
  | { type: "world.claimStargazingDecorations" }
  | { type: "world.put"; item: Omit<Decoration, "revision"> }
  | { type: "world.edit"; key: string; version: number; x: number; y: number; angle: number; memory?: string; photo?: string | null }
  | { type: "world.remove"; key: string; version: number };

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new AppError("INVALID_MOVE", message); }
export const levelsFor = (id: Explorer["id"]) => id === "g12" ? spaceLevels : shadowLevels;
export const worldSize = (id: World["id"]) => id === "w23" ? 10 : 20;
const planetCatalog = [...planetTiles, ...stargazingTiles] as const;
export const itemsFor = (id: World["id"]) => id === "w23" ? furniture : planetCatalog;
export const availableWorldItems = (world: World) => world.id === "c17" && !world.stargazingDecorations ? planetTiles : itemsFor(world.id);

function explorer(id: Explorer["id"], level: number, solved: number[] = []): Explorer {
  const map = levelsFor(id)[level];
  check(map && validateLevel(map), "关卡配置不正确");
  return { id, level, avatars: map.start, lit: [false, false], stars: [], box: map.box, solved, tribute: null };
}

export function startScene(id: SceneGame["id"]): SceneGame {
  switch (id) {
    case "g12": case "g13": return explorer(id, 0);
    case "g11": return { id, level: 0, solved: 0, finished: [] };
    case "g04": return { id, map: 0, order: null, avatars: kitchens[0].start,
      carrying: [null, null], table: null, plated: [], deadline: 0, served: [] };
    case "c17": case "w23": return { id, decorations: [], recent: "" };
  }
}

function replacing<T>(pair: [T, T], actor: Seat, value: T): [T, T] {
  return actor === 0 ? [value, pair[1]] : [pair[0], value];
}

function step(actor: Seat, current: [Coord, Coord], from: Coord, to: Coord, enter: (point: Coord) => boolean) {
  check(Array.isArray(from) && Array.isArray(to) && from.length === 2 && to.length === 2 &&
    to.every(Number.isInteger) && sameCell(current[actor], from) && Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) === 1,
  "请从当前的位置移动一格");
  check(enter(to), "前面暂时走不通");
  return replacing(current, actor, to);
}

export function stardust(game: Explorer): number {
  if (game.id !== "g12") return 0;
  const completedDust = game.solved.reduce((sum, level) => sum + spaceLevels[level].stars.length, 0);
  return completedDust + (game.solved.includes(game.level) ? 0 : game.stars.length);
}

export function applyExplorer(game: Explorer, command: SceneCommand, actor: Seat): Explorer {
  const map = levelsFor(game.id)[game.level];
  if (command.type === "scene.next") {
    check(game.solved.includes(game.level) && game.level + 1 < levelsFor(game.id).length, "本关完成后才能前往下一关");
    return { ...explorer(game.id, game.level + 1, game.solved), tribute: game.tribute, tributePhoto: game.tributePhoto,
      ...(game.badges ? { badges: game.badges } : {}) };
  }
  if (command.type === "scene.tribute") {
    check(game.id === "g12" && memoryIdPattern.test(command.id) &&
      (command.photo === undefined || playIdPattern.test(command.photo)), "请选择一条共同回忆或共同照片");
    return { ...game, tribute: command.id, tributePhoto: command.photo };
  }
  if (command.type === "scene.badge") {
    check(game.id === "g12", "这项活动没有宇航服装饰");
    const badges = game.badges ?? [null, null];
    check(badges[actor] === command.previous, "当前宇航服装饰已更新，请核对后重试");
    check(command.badge === null || flightBadges.some(({ id, dust }) => id === command.badge && stardust(game) >= dust),
      "先收集足够的星尘再佩戴这件装饰");
    return { ...game, badges: replacing(badges, actor, command.badge) };
  }
  check(!game.solved.includes(game.level), "这一关已经完成");
  const open = ([x, y]: Coord) => {
    const tile = map.rows[y]?.[x];
    return tile === "." || (tile === "G" && game.lit.every(Boolean)) || (tile === "D" && actor === 1);
  };
  let { avatars, box, stars, lit } = game;
  if (command.type === "scene.move") {
    avatars = step(actor, avatars, command.from, command.to, open);
    if (box && sameCell(box, command.to)) {
      const destination: Coord = [2 * box[0] - command.from[0], 2 * box[1] - command.from[1]];
      check(open(destination) && !sameCell(destination, avatars[actor === 0 ? 1 : 0]), "箱子推不动");
      box = destination;
    }
  } else if (command.type === "scene.use") {
    const position = avatars[actor];
    check(command.from === undefined || (Array.isArray(command.from) && command.from.length === 2 && sameCell(position, command.from)),
      "位置已更新，请回到机关旁重新操作");
    if (game.id === "g13" && sameCell(position, map.controls[actor]) && (!lit[actor] || command.from === undefined))
      lit = replacing(lit, actor, true);
    else if (map.portals && map.portals.some((portal) => sameCell(portal, position))) {
      const target = map.portals[sameCell(map.portals[0], position) ? 1 : 0];
      check(!box || !sameCell(box, target), "传送出口被箱子挡住了");
      avatars = replacing(avatars, actor, target);
    } else check(game.id === "g12", "站在自己的机关旁再操作");
  } else throw new AppError("INVALID_MOVE", "当前关卡不支持此操作");

  if (game.id === "g12" && map.controls.every((control, index) => sameCell(control, avatars[index]))) lit = [true, true];
  const arrived = map.stars.findIndex((star) => sameCell(star, avatars[actor]));
  if (arrived >= 0 && !stars.includes(arrived)) stars = [...stars, arrived].sort((a, b) => a - b);
  const complete = lit.every(Boolean) && stars.length === map.stars.length && avatars.every((position) => sameCell(position, map.exit));
  return { ...game, avatars, box, stars, lit, solved: complete ? [...game.solved, game.level] : game.solved };
}

function applyKitchen(game: Kitchen, command: SceneCommand, actor: Seat): Kitchen {
  if (command.type === "kitchen.start") {
    const map = kitchens[command.map];
    check(map && orders[command.order] && Number.isSafeInteger(command.at) && command.at > 0 &&
      (game.order === null || game.deadline <= command.at || game.plated.length === orders[game.order].items.length),
    "这张订单还在进行中");
    return { ...game, map: command.map, order: command.order, avatars: map.start, carrying: [null, null], table: null,
      plated: [], deadline: command.at + (3 + command.order % 3) * 60000 };
  }
  check(game.order !== null && game.plated.length < orders[game.order].items.length, "请先开始一张新的订单");
  const map = kitchens[game.map];
  const tile = ([x, y]: Coord) => map.rows[y]?.[x];
  if (command.type === "scene.move") {
    return { ...game, avatars: step(actor, game.avatars, command.from, command.to, (to) =>
      !!tile(to) && !["#", "T"].includes(tile(to)) && (actor === 0 ? to[0] < 5 : to[0] > 5)) };
  }
  check(command.type === "kitchen.use" && Number.isSafeInteger(command.at) && command.at < game.deadline, "本单时间到了，可以重新开火");
  const position = game.avatars[actor];
  const station = position[1] === 2 && position[0] === (actor === 0 ? 4 : 6) ? "T" : tile(position);
  const food = game.carrying[actor];
  let next: Food | null = food;
  let table = game.table;
  let plated = game.plated;
  if (actor === 0) {
    if (station === "F") {
      const ingredient = command.ingredient;
      const required = orders[game.order].items.filter((item) => item === ingredient).length;
      const already = plated.filter((item) => item === ingredient).length +
        (game.table?.ingredient === ingredient ? 1 : 0) + (game.carrying[1]?.ingredient === ingredient ? 1 : 0);
      check(!food && ingredients[ingredient] && required > already, "选订单所需且尚未备好的食材，每次拿一个");
      next = { ingredient, stage: "raw" };
    } else if (station === "W" && food?.stage === "raw") next = { ...food, stage: "washed" };
    else if (station === "K" && food?.stage === "washed") next = { ...food, stage: "cut" };
    else if (station === "T" && food?.stage === "cut" && !table) { table = food; next = null; }
    else throw new AppError("INVALID_MOVE", "在食材架拿取、到水池清洗、到案板切配，最后放上交接台");
  } else if (station === "T" && !food && table) { next = table; table = null; }
  else if (station === "C" && food?.stage === "cut") next = { ...food, stage: "cooked" };
  else if (station === "D" && food?.stage === "cooked") { plated = [...plated, food.ingredient]; next = null; }
  else throw new AppError("INVALID_MOVE", "从交接台取切好的食材，到灶台烹饪，再去窗口装盘");
  const complete = plated.length === orders[game.order].items.length && plated !== game.plated;
  return { ...game, carrying: replacing(game.carrying, actor, next), table, plated,
    served: complete ? [...new Set([...game.served, game.order])] : game.served };
}

function applyWorld(game: World, command: SceneCommand): World {
  const size = worldSize(game.id);
  const inside = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size;
  const vacant = (x: number, y: number, except?: string) =>
    !game.decorations.some((item) => item.x === x && item.y === y && item.key !== except);
  const angleValid = (angle: number) => [0, 90, 180, 270].includes(angle);
  const referenceValid = (memory?: string, photo?: string) => (!memory || memoryIdPattern.test(memory)) &&
    (photo === undefined || (game.id === "c17" && !!memory && playIdPattern.test(photo)));
  if (command.type === "world.claimStargazingDecorations") {
    check(game.id === "c17", "只有共同星球可以领取这组装饰");
    return game.stargazingDecorations ? game : { ...game, stargazingDecorations: true };
  }
  if (command.type === "world.put") {
    const item = command.item;
    check(game.decorations.length < 200 && playIdPattern.test(item.key) && !game.decorations.some(({ key }) => item.key === key) &&
      inside(item.x, item.y) && vacant(item.x, item.y) && angleValid(item.angle) &&
      referenceValid(item.memory, item.photo) && availableWorldItems(game).some(([kind]) => kind === item.kind),
    "此处已有物件，或布局超出限制");
    return { ...game, decorations: [...game.decorations, { ...item, revision: 1 }], recent: item.kind };
  }
  check(command.type === "world.edit" || command.type === "world.remove", "布局不支持此操作");
  const item = game.decorations.find(({ key }) => key === command.key);
  check(item && item.revision === command.version, "物件已更新，请核对布局再操作");
  if (command.type === "world.remove") return { ...game, decorations: game.decorations.filter(({ key }) => key !== item.key) };
  const photo = command.photo === undefined && command.memory === item.memory ? item.photo : command.photo ?? undefined;
  check(inside(command.x, command.y) && vacant(command.x, command.y, item.key) && angleValid(command.angle) &&
    referenceValid(command.memory, photo), "该位置无法放置物件，或回忆引用已失效");
  return { ...game, decorations: game.decorations.map((object) => object.key === item.key
    ? { ...object, x: command.x, y: command.y, angle: command.angle, memory: command.memory, photo, revision: object.revision + 1 } : object) };
}

export function isSceneGame(game: { id: string }): game is SceneGame {
  return ["g04", "g11", "g12", "g13", "c17", "w23"].includes(game.id);
}

export function applyScene(game: SceneGame, command: SceneCommand, actor: Seat): SceneGame {
  switch (game.id) {
    case "g12": case "g13": return applyExplorer(game, command, actor);
    case "g04": return applyKitchen(game, command, actor);
    case "c17": case "w23": return applyWorld(game, command);
    case "g11": {
      const theme = escapeRooms[game.level];
      if (command.type === "scene.next") {
        check(game.solved === theme.locks.length && game.level + 1 < escapeRooms.length, "完成机关后才能进入下一间");
        return { ...game, level: game.level + 1, solved: 0 };
      }
      const lock = theme.locks[game.solved];
      check(command.type === "escape.solve" && command.stage === game.solved && lock && lock.role === actor &&
        typeof command.value === "string" && command.value.trim().toLowerCase() === lock.code, "机关还没打开，请和对方核对线索");
      const solved = game.solved + 1;
      return { ...game, solved, finished: solved === theme.locks.length ? [...game.finished, game.level] : game.finished };
    }
  }
}
