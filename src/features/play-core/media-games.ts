import { hashText } from "../../core/crypto";
import { dayNumber } from "../../core/date";
import { AppError } from "../../core/types";
import { connectTiles, linkBoard, pickPair, shuffled } from "../puzzle-core/grid";
import { flowers } from "../scene-core/levels";
import type { HiddenAnswer, MemoryReference } from "./async-games";
import { memoryIdPattern, otherSeat, playIdPattern, type Seat } from "./protocol";

export type PhotoReference = MemoryReference & { fileId: string };
export type SkyCard = { photo: PhotoReference; note: string; city: string };
export type SongCard = { track: string; artist: string; link: string; note: string; photos: PhotoReference[] };
export { flowers };
export type StarPosition = { x: number; y: number };
export type Star = StarPosition & { photo: PhotoReference };
type Pair<T> = [T | null, T | null];
export type PhotoPuzzle = { id: "g02"; photo: PhotoReference | null; size: number; tiles: number[]; moves: number };
export type LinkPuzzle = { id: "g08"; tiles: (number | null)[]; cleared: number; last: Seat | null; together: number; seed: string; shuffle: number };
export type DateGuess = { id: "g10"; photo: PhotoReference | null; hidden: HiddenAnswer | null; author: Seat;
  guess: string | null; answer: string | null; match: number };
export type Garden = { id: "g14"; seed: number | null; planting: number; growth: number; experience: number;
  actions: { by: Seat; action: string }[]; decoration: string };
export type BloomCard = { id: "g14"; seed: number; growth: number; decoration: string };
export type Stars = { id: "c18"; stars: Star[]; lines: [string, string][]; name: string; story: string };
export type Music = { id: "c20"; cards: Pair<SongCard> };
export type Sky = { id: "c21"; cards: Pair<SkyCard>; layout: "side" | "stack" | "round" };
export type Tree = { id: "w24"; selected: string[] };
export type MediaGame = PhotoPuzzle | LinkPuzzle | DateGuess | Garden | Stars | Music | Sky | Tree;

export type MediaCommand =
  | { type: "puzzle.pick"; photo: PhotoReference; size: number }
  | { type: "puzzle.swap"; a: number; b: number; values: [number, number] }
  | { type: "link.clear"; a: number; b: number }
  | { type: "link.shuffle" }
  | { type: "date.pick"; photo: PhotoReference; hidden: HiddenAnswer }
  | { type: "date.guess"; value: string }
  | { type: "date.reveal"; answer: string }
  | { type: "date.next" }
  | { type: "garden.plant"; seed: number }
  | { type: "garden.tend"; action: "水" | "日照" }
  | { type: "garden.decorate"; value: string }
  | { type: "garden.reset" }
  | { type: "stars.add"; star: Star }
  | ({ type: "stars.move"; id: string; from?: StarPosition } & StarPosition)
  | { type: "stars.remove"; id: string }
  | { type: "stars.link"; from: string; to: string }
  | { type: "stars.story"; name: string; story: string }
  | { type: "music.put"; value: SongCard }
  | { type: "sky.put"; value: SkyCard; previous?: string | null }
  | { type: "sky.layout"; layout: Sky["layout"] }
  | { type: "tree.select"; id: string; include: boolean };

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new AppError("INVALID_MOVE", message); }
function text(value: string, max: number) {
  check(typeof value === "string" && Array.from(value.trim()).length <= max, "请输入符合长度要求的文字");
  return value.trim();
}
function validPhoto(photo: PhotoReference) { return memoryIdPattern.test(photo?.recordId ?? "") && playIdPattern.test(photo?.fileId ?? ""); }
function pair<T>(values: Pair<T>, actor: Seat, value: T): Pair<T> { return actor === 0 ? [value, values[1]] : [values[0], value]; }
function validRange(value: string) {
  if (/^\d{4}$/.test(value)) return value !== "0000";
  try { dayNumber(value.length === 7 ? value + "-01" : value); return true; } catch { return false; }
}

export const musicDomains = ["music.163.com", "y.qq.com", "c.y.qq.com", "open.spotify.com", "music.apple.com", "music.youtube.com", "www.youtube.com"] as const;
export function officialMusicLink(link: string) {
  if (!link.trim()) return "";
  try {
    const url = new URL(link);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname !== "/" &&
      (musicDomains as readonly string[]).includes(url.hostname)) return url.href;
  } catch { /* An invalid URL is handled by the field validation below. */ }
  throw new AppError("INVALID_LINK", "请填写受支持音乐服务的 HTTPS 曲目链接");
}

export const puzzleFinished = (game: PhotoPuzzle) => !!game.photo && game.tiles.every((tile, i) => tile === i);
export const growthStage = (garden: Garden) => garden.growth >= 6 ? "开花" : garden.growth >= 3 ? "嫩芽" : "种子";

export function gardenCard(game: Garden): BloomCard | null {
  return game.seed === null || growthStage(game) !== "开花" ? null : {
    id: game.id, seed: game.seed, growth: game.growth, decoration: game.decoration,
  };
}

export function skyCardFingerprint(card: SkyCard | null) {
  return card ? hashText(JSON.stringify([card.photo.recordId, card.photo.fileId, card.note, card.city])) : null;
}

export function startMedia(id: MediaGame["id"], seed: string): MediaGame {
  switch (id) {
    case "g02": return { id, photo: null, size: 3, tiles: [], moves: 0 };
    case "g08": return { id, tiles: linkBoard(seed), cleared: 0, last: null, together: 0, seed, shuffle: 0 };
    case "g10": return { id, photo: null, hidden: null, author: 0, guess: null, answer: null, match: 1 };
    case "g14": return { id, seed: null, planting: 0, growth: 0, experience: 0, actions: [], decoration: "" };
    case "c18": return { id, stars: [], lines: [], name: "", story: "" };
    case "c20": return { id, cards: [null, null] };
    case "c21": return { id, cards: [null, null], layout: "side" };
    case "w24": return { id, selected: [] };
  }
}

export function applyMedia(game: MediaGame, command: MediaCommand, actor: Seat): MediaGame {
  switch (game.id) {
    case "g02": {
      if (command.type === "puzzle.pick") {
        check(!game.photo && validPhoto(command.photo) && [3, 4, 6].includes(command.size), "请选择共同照片与拼图大小");
        const tiles = shuffled(Array.from({ length: command.size ** 2 }, (_, index) => index), command.photo.fileId);
        if (tiles.every((tile, index) => tile === index)) [tiles[0], tiles[1]] = [tiles[1], tiles[0]];
        return { ...game, photo: command.photo, size: command.size, tiles };
      }
      check(command.type === "puzzle.swap" && game.photo && !puzzleFinished(game) && command.a !== command.b &&
        command.values?.length === 2 && command.values.every(Number.isInteger) &&
        game.tiles[command.a] === command.values[0] && game.tiles[command.b] === command.values[1], "拼块刚刚移动过，请重选");
      const tiles = game.tiles.slice();
      [tiles[command.a], tiles[command.b]] = [tiles[command.b], tiles[command.a]];
      return { ...game, tiles, moves: game.moves + 1 };
    }
    case "g08": {
      if (command.type === "link.shuffle") {
        check(game.cleared < 24 && !pickPair(game.tiles), "棋盘仍有可以连接的图案");
        const remaining = game.tiles.filter((tile): tile is number => tile !== null).sort((a, b) => a - b);
        const ordered = [...remaining, ...Array<null>(game.tiles.length - remaining.length).fill(null)];
        return { ...game, tiles: ordered, shuffle: game.shuffle + 1 };
      }
      check(command.type === "link.clear" && connectTiles(game.tiles, command.a, command.b), "图案必须相同，连线至多两次转弯");
      const tiles = game.tiles.slice();
      tiles[command.a] = tiles[command.b] = null;
      return { ...game, tiles, cleared: game.cleared + 1, last: actor, together: game.together + (game.last === otherSeat(actor) ? 1 : 0) };
    }
    case "g10": {
      if (command.type === "date.pick") {
        check(game.author === actor && !game.photo && validPhoto(command.photo) && command.hidden?.envelope?.version === 1, "由出题者选择照片");
        return { ...game, photo: command.photo, hidden: command.hidden };
      }
      if (command.type === "date.guess") {
        check(game.author !== actor && game.photo && !game.guess && validRange(command.value), "请选择有效的年份、月份或日期");
        return { ...game, guess: command.value };
      }
      if (command.type === "date.reveal") {
        check(game.author === actor && game.guess && !game.answer && validRange(command.answer), "对方提交猜测后揭晓");
        return { ...game, answer: command.answer };
      }
      check(command.type === "date.next" && game.answer && game.match < 12, "当前还不能交换出题");
      return { ...game, photo: null, hidden: null, author: otherSeat(game.author), guess: null, answer: null, match: game.match + 1 };
    }
    case "g14": {
      if (command.type === "garden.plant") {
        check(game.seed === null && flowers[command.seed] && game.experience >= flowers[command.seed].unlock, "请选择已解锁的花种");
        return { ...game, seed: command.seed, planting: game.planting + 1, growth: 0, actions: [] };
      }
      if (command.type === "garden.decorate") return { ...game, decoration: text(command.value, 32) };
      if (command.type === "garden.reset") return { ...game, seed: null, growth: 0, actions: [] };
      check(command.type === "garden.tend" && game.seed !== null && ["水", "日照"].includes(command.action), "先播种再照料");
      return { ...game, growth: game.growth + 1, experience: game.experience + 1,
        actions: [...game.actions, { by: actor, action: command.action }].slice(-30) };
    }
    case "c18": {
      if (command.type === "stars.add") {
        check(game.stars.length < 20 && validPhoto(command.star.photo) && !game.stars.some((star) => star.photo.fileId === command.star.photo.fileId) &&
          position(command.star.x) && position(command.star.y), "请选择还未入选的照片，最多 20 颗");
        return { ...game, stars: [...game.stars, command.star] };
      }
      if (command.type === "stars.move") {
        const star = game.stars.find((item) => item.photo.fileId === command.id);
        check(star && position(command.x) && position(command.y), "请选择可以移动的星点");
        if (command.from && (command.from.x !== star.x || command.from.y !== star.y))
          throw new AppError("REVISION_CONFLICT", "这颗星已被移动，请核对后再调整");
        return { ...game, stars: game.stars.map((item) => item.photo.fileId === command.id ? { ...item, x: command.x, y: command.y } : item) };
      }
      if (command.type === "stars.remove") return { ...game, stars: game.stars.filter((item) => item.photo.fileId !== command.id),
        lines: game.lines.filter((line) => !line.includes(command.id)) };
      if (command.type === "stars.link") {
        const [from, to] = [command.from, command.to].sort();
        check(from !== to && [from, to].every((id) => game.stars.some((item) => item.photo.fileId === id)), "请选择两颗不同的星");
        if (game.lines.some((line) => line[0] === from && line[1] === to))
          return { ...game, lines: game.lines.filter((line) => line[0] !== from || line[1] !== to) };
        return { ...game, lines: [...game.lines, [from, to]] };
      }
      check(command.type === "stars.story" && text(command.name, 60), "请为星座命名");
      return { ...game, name: text(command.name, 60), story: text(command.story, 1000) };
    }
    case "c20": {
      check(command.type === "music.put" && Array.isArray(command.value.photos) &&
        command.value.photos.length <= 3 && command.value.photos.every(validPhoto), "至多添加三张共同照片");
      const { track, artist, link, note, photos } = command.value;
      check(text(track, 100) && text(artist, 100), "请填写歌曲和演唱者");
      return { ...game, cards: pair(game.cards, actor, { track: text(track, 100), artist: text(artist, 100),
        link: officialMusicLink(text(link, 512)), note: text(note, 500), photos }) };
    }
    case "c21":
      if (command.type === "sky.layout") {
        check(["side", "stack", "round"].includes(command.layout), "请选择拼贴模板");
        return { ...game, layout: command.layout };
      }
      check(command.type === "sky.put" && validPhoto(command.value.photo), "请选一张天空照片");
      if (command.previous !== undefined && command.previous !== skyCardFingerprint(game.cards[actor]))
        throw new AppError("REVISION_CONFLICT", "这张天空卡已在另一台设备更新，请核对后再提交");
      return { ...game, cards: pair(game.cards, actor, { photo: command.value.photo, note: text(command.value.note, 240), city: text(command.value.city, 60) }) };
    case "w24":
      check(command.type === "tree.select" && memoryIdPattern.test(command.id) &&
        (game.selected.length < 1000 || !command.include || game.selected.includes(command.id)), "回忆树已达到保存上限");
      return { ...game, selected: command.include ? [...new Set([...game.selected, command.id])] : game.selected.filter((id) => id !== command.id) };
  }
}

function position(value: number) { return Number.isFinite(value) && value >= 0 && value <= 100; }
