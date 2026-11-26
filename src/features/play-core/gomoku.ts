import { AppError } from "../../core/types";
import { otherSeat, type Seat } from "./protocol";

export const boardSize = 15;
export type Stone = { x: number; y: number; by: Seat };
export interface Gomoku {
  stones: Stone[];
  starter: Seat;
  winner: Seat | "draw" | null;
  undo: Seat | null;
  match: number;
  history: { stones: Stone[]; winner: Seat | "draw" }[];
}

export const newGomoku = (starter: Seat = 0): Gomoku => ({
  stones: [], starter, winner: null, undo: null, match: 1, history: [],
});
export const gomokuTurn = (game: Gomoku) => game.stones.length % 2 ? otherSeat(game.starter) : game.starter;

function winning(stones: Stone[], last: Stone) {
  const board = new Map(stones.map(({ x, y, by }) => [y * boardSize + x, by]));
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) => {
    let count = 1;
    for (const direction of [-1, 1]) {
      for (let step = 1; step < 5; step++) {
        const x = last.x + step * dx * direction;
        const y = last.y + step * dy * direction;
        if (x < 0 || x >= boardSize || y < 0 || y >= boardSize || board.get(y * boardSize + x) !== last.by) break;
        count++;
      }
    }
    return count >= 5;
  });
}

export function moveGomoku(game: Gomoku, actor: Seat, x: number, y: number): Gomoku {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= boardSize || y >= boardSize)
    throw new AppError("INVALID_MOVE", "请在棋盘内落子");
  if (game.winner !== null || game.undo !== null || gomokuTurn(game) !== actor)
    throw new AppError("TURN_REQUIRED", "当前不能落子");
  if (game.stones.some((stone) => stone.x === x && stone.y === y))
    throw new AppError("INVALID_MOVE", "这个位置已有棋子");
  const stone = { x, y, by: actor };
  const stones = [...game.stones, stone];
  return { ...game, stones, winner: winning(stones, stone) ? actor : stones.length === boardSize ** 2 ? "draw" : null };
}

export function requestGomokuUndo(game: Gomoku, actor: Seat): Gomoku {
  if (game.undo !== null || game.stones.at(-1)?.by !== actor)
    throw new AppError("INVALID_MOVE", "只能申请撤回自己刚下的一步");
  return { ...game, undo: actor };
}

export function respondGomokuUndo(game: Gomoku, actor: Seat, accepted: boolean): Gomoku {
  if (game.undo === null || game.undo === actor)
    throw new AppError("INVALID_MOVE", "只有对方可以处理这次悔棋申请");
  return accepted ? { ...game, undo: null, stones: game.stones.slice(0, -1), winner: null } : { ...game, undo: null };
}

export function rematchGomoku(game: Gomoku, actor: Seat): Gomoku {
  if (game.winner === null || game.undo !== null || gomokuTurn(game) !== actor || game.match >= 12)
    throw new AppError("INVALID_MOVE", "本局结束后由下一位成员发起新一盘");
  return { ...newGomoku(otherSeat(game.starter)), match: game.match + 1,
    history: [...game.history, { stones: game.stones, winner: game.winner }] };
}
