import { AppError, type Envelope } from "../../core/types";
import { memoryIdPattern, playIdPattern, otherSeat, type Seat } from "../play-core/protocol";
import type { HiddenAnswer, MemoryReference } from "../play-core/async-games";

export type Point = [x: number, y: number, pressure: number];
export type StrokePreview = { panel: number; x: number; y: number; points: Point[]; color: string; width: number };
export type CanvasBody =
  | { kind: "stroke"; points: Point[]; color: string; width: number }
  | { kind: "shape"; shape: "rect" | "ellipse" | "line"; color: string }
  | { kind: "character"; avatar: number; expression: number; color: string }
  | { kind: "sticky" | "text" | "sticker" | "bubble"; text: string; color: string }
  | { kind: "photo"; reference: MemoryReference }
  | { kind: "wish"; reference: MemoryReference }
  | { kind: "link"; from: string; to: string; color: string }
  | { kind: "group"; children: string[] };
export type CanvasItem = CanvasBody & {
  id: string; by: Seat; x: number; y: number; angle: number; version: number; layer: number; panel: number;
};
export type ItemInput = CanvasBody & { id: string; x: number; y: number };
type CanvasChange = { before: CanvasItem | null; after: CanvasItem | null };
type CanvasEdit = CanvasChange | { erased: CanvasItem[] };
type Frame = { title: string; owner: Seat | null; background?: string };
export type Drawing = {
  id: "c15" | "c16" | "c22" | "g01";
  objects: CanvasItem[];
  versions: Record<string, number>;
  undo: [CanvasEdit[], CanvasEdit[]];
  redo: [CanvasEdit[], CanvasEdit[]];
  frames: Frame[];
  cover: string;
  ending: string;
  paper: "plain" | "grid" | "pink";
  rounds: DrawRound[];
};
type DrawRound = {
  author: Seat; secret: HiddenAnswer | null; start: number; seconds: number;
  guesses: string[]; result: { answer: string; correct: boolean } | null;
  artwork?: CanvasItem[];
};

export type DrawCommand =
  | { type: "canvas.add"; item: ItemInput; panel: number }
  | { type: "canvas.change"; id: string; version: number; x?: number; y?: number; angle?: number; layer?: number }
  | { type: "canvas.delete"; id: string; version: number }
  | { type: "canvas.erase"; round: number; items: { id: string; version: number }[] }
  | { type: "canvas.clear"; panel: number }
  | { type: "canvas.undo" | "canvas.redo" }
  | { type: "canvas.paper"; paper: Drawing["paper"] }
  | { type: "comic.claim"; panel: number }
  | { type: "comic.caption"; panel: number; text: string }
  | { type: "comic.background"; panel: number; background: string }
  | { type: "comic.cover" | "comic.ending"; text: string }
  | { type: "drawing.ask"; hidden: HiddenAnswer; start: number; seconds: number }
  | { type: "drawing.guess"; value: string; at: number; round?: number }
  | { type: "drawing.reveal"; answer: string; at: number; round?: number }
  | { type: "drawing.next" };

export const paperColors = { plain: "#fffdf7", grid: "#fffdf7", pink: "#f9e9e8" } as const;
export const brushColors = ["#392f2c", "#a65449", "#b26f25", "#507256", "#3a7198", "#795b8b", "#e1b74b"];
export const stickers = ["✨", "❤️", "🌻", "🌙", "☁️", "🐇", "🎈", "🍰", "🌈", "📍", "😮", "😊", "😴", "😢"];
export const characters = ["软圆团子", "尖耳信使", "戴帽旅人"];
export const expressions = ["微笑", "大笑", "惊讶", "思考", "困倦", "皱眉", "害羞", "张望", "眨眼", "伤心"];
export const comicBackgrounds = {
  paper: { name: "留白", sky: "#fffdf7", floor: "#f1ece0" },
  street: { name: "老街", sky: "#f3e4c6", floor: "#c9a98b" },
  park: { name: "公园", sky: "#e1eddb", floor: "#b9ceaa" },
  coast: { name: "海边", sky: "#d8edf2", floor: "#e6cc92" },
  night: { name: "夜空", sky: "#cdd0ea", floor: "#8d8ab3" },
  home: { name: "客厅", sky: "#f4e7df", floor: "#d7ab87" },
  train: { name: "列车", sky: "#e0e5e9", floor: "#a9bdc4" },
  coffee: { name: "咖啡馆", sky: "#efdfd8", floor: "#b4826d" },
} as const;
export const publicPrompts = {
  容易: ["热气球", "向日葵", "雨伞", "海边日落", "生日蛋糕", "一轮月亮"],
  进阶: ["追公车", "半夜看流星", "在雨里跳舞", "露营地的猫", "满满一碗热汤", "把信寄给未来"],
};

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new AppError("INVALID_MOVE", message);
}
function limitText(value: string, length: number) {
  check(typeof value === "string" && Array.from(value.trim()).length <= length, "文字超过长度限制");
  return value.trim();
}
function xy(value: number) { return Number.isFinite(value) && Math.abs(value) <= 1000000; }
function color(value: string) { return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value); }
function resource(value: string) { return typeof value === "string" && playIdPattern.test(value); }
export function validPreview(value: StrokePreview | null): value is StrokePreview {
  return !!value && Number.isInteger(value.panel) && value.panel >= 0 && value.panel < 6 &&
    xy(value.x) && xy(value.y) && color(value.color) && value.width >= 1 && value.width <= 28 &&
    Array.isArray(value.points) && value.points.length <= 125 && value.points.every((p) => Array.isArray(p) && p.length === 3 &&
      xy(p[0]) && xy(p[1]) && Number.isFinite(p[2]) && p[2] >= 0 && p[2] <= 1);
}

function nextRound(author: Seat): DrawRound {
  return { author, secret: null, start: 0, seconds: 0, guesses: [], result: null };
}

export function startDrawing(id: Drawing["id"], choice?: string): Drawing {
  return { id, objects: [], versions: {}, undo: [[], []], redo: [[], []],
    frames: id === "c16" ? Array.from({ length: choice === "6" ? 6 : 4 }, () => ({ title: "", owner: null })) : [],
    paper: id === "c22" ? "grid" : "plain", cover: "", ending: "", rounds: id === "g01" ? [nextRound(0)] : [] };
}

function validateItem(item: ItemInput, existing: CanvasItem[], actor: Seat, panel: number) {
  check(resource(item.id) && xy(item.x) && xy(item.y) && !existing.some(({ id }) => id === item.id), "物件坐标或标识无效");
  const inPanel = (id: string) => existing.find((item) => item.id === id && item.panel === panel);
  switch (item.kind) {
    case "stroke":
      check(color(item.color) && Number.isFinite(item.width) && item.width >= 1 && item.width <= 28 &&
        Array.isArray(item.points) && item.points.length >= 1 && item.points.length <= 700 &&
        item.points.every((p) => p.length === 3 && xy(p[0]) && xy(p[1]) && Number.isFinite(p[2]) && p[2] >= 0 && p[2] <= 1),
      "笔迹格式不正确");
      break;
    case "shape":
      check(color(item.color) && ["rect", "ellipse", "line"].includes(item.shape), "形状不正确");
      break;
    case "character":
      check(color(item.color) && Number.isInteger(item.avatar) && characters[item.avatar] &&
        Number.isInteger(item.expression) && expressions[item.expression], "请选择角色和表情");
      break;
    case "text":
    case "sticky":
    case "bubble":
    case "sticker":
      check(color(item.color) && limitText(item.text, 240), "请输入文字");
      break;
    case "photo":
    case "wish":
      check(memoryIdPattern.test(item.reference?.recordId ?? "") && (item.kind === "wish" || resource(item.reference.fileId ?? "")), "无效的共同回忆引用");
      break;
    case "link":
      check(color(item.color) && item.from !== item.to && inPanel(item.from) && inPanel(item.to), "请选择同一画面的两个物件");
      break;
    case "group":
      check(Array.isArray(item.children) && item.children.length >= 2 && item.children.length <= 15 &&
        new Set(item.children).size === item.children.length && item.children.every((id) => {
          const child = inPanel(id);
          return child && child.by === actor && child.kind !== "group" && child.kind !== "link" &&
            !existing.some((item) => item.kind === "group" && item.children.includes(id));
        }), "只能将自己的未分组物件组合起来");
      break;
    default:
      throw new AppError("INVALID_MOVE", "画布物件不受支持");
  }
}

function panelAvailable(state: Drawing, panel: number, actor: Seat) {
  return state.frames.length ? state.frames[panel]?.owner === actor : panel === 0;
}

function editOne(state: Drawing, actor: Seat, before: CanvasItem | null, after: CanvasItem | null): Drawing {
  const undo = [...state.undo] as Drawing["undo"];
  const redo = [...state.redo] as Drawing["redo"];
  undo[actor] = [...undo[actor], { before, after }].slice(-40);
  redo[actor] = [];
  const id = (before ?? after)!.id;
  const version = (state.versions[id] ?? before?.version ?? 0) + 1;
  const objects = state.objects.filter((item) => item.id !== id);
  if (after) objects.push({ ...after, version });
  return { ...state, undo, redo, objects, versions: { ...state.versions, [id]: version } };
}

function travelHistory(state: Drawing, actor: Seat, direction: "undo" | "redo"): Drawing {
  const source = state[direction][actor];
  const edit = source.at(-1);
  check(edit, direction === "undo" ? "没有自己的操作可以撤销" : "没有可以重做的操作");
  const other = direction === "undo" ? "redo" : "undo";
  const changes = "erased" in edit ? edit.erased.map((item) => ({ before: item, after: null })) : [edit];
  const ids = new Set(changes.map(({ before, after }) => (before ?? after)!.id));
  const objects = state.objects.filter((item) => !ids.has(item.id));
  const versions = { ...state.versions };
  for (const change of changes) {
    const id = (change.before ?? change.after)!.id;
    const restored = direction === "undo" ? change.before : change.after;
    const version = versions[id] = (versions[id] ?? 0) + 1;
    if (restored) objects.push({ ...restored, version });
  }
  const next = { ...state, objects, versions,
    [direction]: [...state[direction]], [other]: [...state[other]] } as Drawing;
  next[direction][actor] = source.slice(0, -1);
  next[other][actor] = [...state[other][actor], edit].slice(-40);
  return next;
}

export function matchesDrawingAnswer(guesses: string[], answer: string) {
  const canonical = (value: string) => value.normalize("NFKC").toLowerCase().trim();
  const value = canonical(answer);
  return guesses.some((guess) => canonical(guess) === value);
}

function drawGuess(state: Drawing, command: DrawCommand, actor: Seat): Drawing | null {
  const round = state.rounds.at(-1)!;
  const update = (next: DrawRound) => ({ ...state, rounds: [...state.rounds.slice(0, -1), next] });
  switch (command.type) {
    case "drawing.ask":
      check(actor === round.author && !round.secret && (command.hidden?.envelope as Envelope)?.version === 1 &&
        Number.isSafeInteger(command.start) && [60, 90, 120].includes(command.seconds), "请由画者选词并开始");
      return update({ ...round, secret: command.hidden, start: command.start, seconds: command.seconds });
    case "drawing.guess": {
      const value = limitText(command.value, 100);
      check(actor !== round.author && round.secret && !round.result && round.guesses.length < 20 && value &&
        (command.round === undefined || command.round === state.rounds.length) &&
        Number.isSafeInteger(command.at) && command.at <= round.start + round.seconds * 1000, "这一轮暂时无法猜词");
      return update({ ...round, guesses: [...round.guesses, value] });
    }
    case "drawing.reveal": {
      const answer = limitText(command.answer, 100);
      const correct = matchesDrawingAnswer(round.guesses, answer);
      check(actor === round.author && round.secret && !round.result && answer &&
        (command.round === undefined || (command.round === state.rounds.length && Number.isSafeInteger(command.at))) &&
        (correct || command.at >= round.start + round.seconds * 1000), "猜对或时间结束后由画者揭晓");
      return update({ ...round, result: { answer, correct }, artwork: state.objects });
    }
    case "drawing.next":
      check(round.result && state.rounds.length < 12, "先完成这一轮");
      return { ...state, objects: [], versions: {}, undo: [[], []], redo: [[], []], rounds: [...state.rounds, nextRound(otherSeat(round.author))] };
    default:
      check(round.author === actor && round.secret && !round.result, "这一轮由画者绘图");
      return null;
  }
}

export function applyDrawing(state: Drawing, command: DrawCommand, actor: Seat): Drawing {
  if (state.id === "g01") {
    const result = drawGuess(state, command, actor);
    if (result) return result;
  }
  switch (command.type) {
    case "canvas.add": {
      check(state.objects.length < (state.id === "g01" ? 350 : 1200), "画布物件已达上限，可保存作品后继续新画");
      check(panelAvailable(state, command.panel, actor), "请先认领分镜");
      check(!Object.hasOwn(state.versions, command.item.id), "物件编号已用过");
      check(state.id !== "g01" || ["stroke", "shape"].includes(command.item.kind), "画猜只使用手绘工具");
      validateItem(command.item, state.objects, actor, command.panel);
      const layer = Math.max(0, ...state.objects.map((item) => item.layer)) + 1;
      const item = { ...command.item, by: actor, angle: 0, layer, version: 1, panel: command.panel };
      return editOne(state, actor, null, item);
    }
    case "canvas.change":
    case "canvas.delete": {
      const item = state.objects.find(({ id }) => id === command.id);
      check(item && item.by === actor && item.version === command.version && panelAvailable(state, item.panel, actor),
        "只能编辑自己的当前版本物件，请刷新后重试");
      if (command.type === "canvas.delete") return editOne(state, actor, item, null);
      const { x = item.x, y = item.y, angle = item.angle, layer = item.layer } = command;
      check(xy(x) && xy(y) && Number.isFinite(angle) && Math.abs(angle) <= 360 &&
        Number.isInteger(layer) && Math.abs(layer) <= 10000, "无效的物件位置或图层");
      return editOne(state, actor, item, { ...item, x, y, angle, layer, version: item.version + 1 });
    }
    case "canvas.erase": {
      check(state.id === "g01" && command.round === state.rounds.length && Array.isArray(command.items) &&
        command.items.length > 0 && command.items.length <= state.objects.length &&
        command.items.every((item) => item && resource(item.id) && Number.isSafeInteger(item.version) && item.version > 0),
      "橡皮操作已过期，请核对画布");
      const revisions = new Map(command.items.map(({ id, version }) => [id, version]));
      const erased = state.objects.filter(({ id }) => revisions.has(id));
      check(erased.length === command.items.length && erased.every(({ by, id, kind, version, panel }) => by === actor &&
        kind === "stroke" && version === revisions.get(id) && panelAvailable(state, panel, actor)), "有笔迹已更新，请核对画布后再擦除");
      const undo = [...state.undo] as Drawing["undo"];
      const redo = [...state.redo] as Drawing["redo"];
      undo[actor] = [...undo[actor], { erased }].slice(-40);
      redo[actor] = [];
      const versions = { ...state.versions };
      for (const item of erased) versions[item.id] = item.version + 1;
      return { ...state, undo, redo, versions, objects: state.objects.filter(({ id }) => !revisions.has(id)) };
    }
    case "canvas.undo":
    case "canvas.redo": return travelHistory(state, actor, command.type === "canvas.undo" ? "undo" : "redo");
    case "canvas.clear":
      check(panelAvailable(state, command.panel, actor), "请先认领分镜");
      return state.objects.filter((item) => item.by === actor && item.panel === command.panel)
        .reduce((next, item) => editOne(next, actor, item, null), state);
    case "canvas.paper":
      check(Object.hasOwn(paperColors, command.paper), "请选择有效的纸张");
      return { ...state, paper: command.paper };
    case "comic.claim":
    case "comic.caption":
    case "comic.background": {
      const frame = state.frames[command.panel];
      check(frame && (command.type === "comic.claim" ? frame.owner === null : frame.owner === actor), "此分镜已被认领或不可编辑");
      if (command.type === "comic.background")
        check(Object.hasOwn(comicBackgrounds, command.background), "请选择分镜背景");
      const next = command.type === "comic.claim" ? { ...frame, owner: actor } : command.type === "comic.caption"
        ? { ...frame, title: limitText(command.text, 120) } : { ...frame, background: command.background };
      return { ...state, frames: state.frames.map((frame, index) => index === command.panel ? next : frame) };
    }
    case "comic.cover":
    case "comic.ending":
      check(state.id === "c16", "只有漫画可以添加封面和结尾");
      return { ...state, [command.type === "comic.cover" ? "cover" : "ending"]: limitText(command.text, 160) };
    default:
      throw new AppError("INVALID_MOVE", "此操作不适用于当前画布");
  }
}

export function sortedItems(objects: CanvasItem[], panel: number) {
  return objects.filter((item) => item.panel === panel).sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id));
}
