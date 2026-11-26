import { applyDrawing, startDrawing, type DrawCommand, type Drawing } from "../canvas-core/canvas";
import { applyAsync, asyncGate, startAsync, type AsyncActivity, type AsyncCommand } from "./async-games";
import type { ActivityId } from "./catalog";
import { applyMedia, startMedia, type MediaCommand, type MediaGame } from "./media-games";
import { applyScene, isSceneGame, startScene, type SceneCommand, type SceneGame } from "../scene-core/scene";
import type { Seat } from "./protocol";

export type PlayGame = AsyncActivity | Drawing | MediaGame | SceneGame;
export type GameCommand = AsyncCommand | DrawCommand | MediaCommand | SceneCommand;

export function startGame(id: ActivityId, choice?: string, seed = "Us"): PlayGame {
  switch (id) {
    case "g01":
    case "c15":
    case "c16":
    case "c22":
      return startDrawing(id, choice);
    case "g02":
    case "g08":
    case "g10":
    case "g14":
    case "c18":
    case "c20":
    case "c21":
    case "w24":
      return startMedia(id, seed);
    case "g04": case "g11": case "g12": case "g13": case "c17": case "w23":
      return startScene(id);
    default:
      return startAsync(id, choice);
  }
}

export function isMediaGame(game: PlayGame): game is MediaGame {
  switch (game.id) {
    case "g02": case "g08": case "g10": case "g14": case "c18": case "c20": case "c21": case "w24": return true;
    default: return false;
  }
}

export function applyGame(state: PlayGame, command: GameCommand, actor: Seat): PlayGame {
  if ("objects" in state) return applyDrawing(state, command as DrawCommand, actor);
  if (isMediaGame(state)) return applyMedia(state, command as MediaCommand, actor);
  if (isSceneGame(state)) return applyScene(state, command as SceneCommand, actor);
  return applyAsync(state, command as AsyncCommand, actor);
}

export function gameGate(before: PlayGame, after: PlayGame, command: GameCommand) {
  if ("objects" in before || "objects" in after || isMediaGame(before) || isMediaGame(after) ||
    isSceneGame(before) || isSceneGame(after)) return { turn: null, nextTurn: null };
  return asyncGate(before, after, command as AsyncCommand);
}

export function rebaseKey(game: PlayGame, command: GameCommand) {
  if (game.id === "g03" && command.type === "bond.answer") return "bond/" + game.rounds.length;
  if (game.id === "g09" && command.type === "box.put") return "box";
  if (game.id === "g02" && command.type === "puzzle.swap") return "photo-puzzle";
  if (game.id === "g08" && command.type === "link.clear") return "tiles/" + game.shuffle;
  if (game.id === "g14" && command.type === "garden.tend") return "flower/" + game.planting;
  if (game.id === "c18" && command.type === "stars.add") return "constellation";
  if (game.id === "w24" && command.type === "tree.select") return "memory-tree";
  if ((game.id === "g12" || game.id === "g13") && command.type === "scene.move") return "maze/" + game.level;
  if ((game.id === "g12" || game.id === "g13") && command.type === "scene.use" && command.from !== undefined)
    return "maze/" + game.level;
  if (game.id === "g12" && command.type === "scene.badge") return "flight-badge";
  if ((game.id === "c17" || game.id === "w23") && command.type === "world.put") return "world";
  if (game.id === "g01" && (command.type === "canvas.erase" ||
    ((command.type === "drawing.guess" || command.type === "drawing.reveal") && command.round !== undefined)))
    return "drawing/" + game.rounds.length;
  if ("objects" in game && (command.type === "canvas.add" || command.type === "canvas.change" ||
    command.type === "canvas.delete" || command.type === "comic.claim")) return "canvas/" + game.rounds.length;
  return null;
}

export function canRebase(game: PlayGame, command: GameCommand) {
  // Their reducers verify a previous value or object version before applying a rebased edit.
  return rebaseKey(game, command) !== null || (game.id === "c21" && command.type === "sky.put" && command.previous !== undefined) ||
    (game.id === "c18" && command.type === "stars.move" && !!command.from) ||
    ((game.id === "c17" || game.id === "w23") && (command.type === "world.edit" || command.type === "world.remove")) ||
    (game.id === "c17" && command.type === "world.claimStargazingDecorations");
}
