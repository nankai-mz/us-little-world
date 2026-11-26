import { hashText } from "../../core/crypto";

export function shuffled<T>(items: T[], seed: string) {
  let number = Number.parseInt(hashText(seed).slice(0, 8), 16) || 1;
  const output = items.slice();
  for (let i = output.length - 1; i > 0; i--) {
    number ^= number << 13;
    number ^= number >>> 17;
    number ^= number << 5;
    const j = (number >>> 0) % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

export const linkWidth = 8;
export const linkHeight = 6;
export const tileArt = ["🌙", "🌸", "🍓", "🍋", "🍄", "🐇", "☕", "🍰", "🫖", "⭐", "☁️", "🎈"];
type Coordinate = [number, number];

export function linkBoard(seed: string) {
  const pairs = shuffled(Array.from({ length: linkWidth * linkHeight / 2 }, (_, i) => i % tileArt.length), seed);
  return pairs.flatMap((tile) => [tile, tile]);
}

// Search includes a one-tile border, so paths can go round the outside of the board.
export function connectTiles(board: (number | null)[], first: number, second: number): Coordinate[] | null {
  if (!Number.isInteger(first) || !Number.isInteger(second) || first === second ||
    first < 0 || second < 0 || first >= board.length || second >= board.length || board[first] === null || board[first] !== board[second]) return null;
  const start: Coordinate = [first % linkWidth, Math.floor(first / linkWidth)];
  const target: Coordinate = [second % linkWidth, Math.floor(second / linkWidth)];
  const open = (x: number, y: number) => x >= -1 && x <= linkWidth && y >= -1 && y <= linkHeight &&
    (x < 0 || x >= linkWidth || y < 0 || y >= linkHeight || board[y * linkWidth + x] === null || (x === target[0] && y === target[1]));
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const pending = [{ path: [start], dir: -1, turns: 0 }];
  const seen = new Set<string>();
  for (let i = 0; i < pending.length; i++) {
    const { path, dir, turns } = pending[i];
    const [x, y] = path.at(-1)!;
    for (const [nextDir, [dx, dy]] of directions.entries()) {
      const nextTurns = turns + (dir === -1 || nextDir === dir ? 0 : 1);
      if (nextTurns > 2 || !open(x + dx, y + dy)) continue;
      const next: Coordinate = [x + dx, y + dy];
      if (next[0] === target[0] && next[1] === target[1]) return [...path, next];
      const key = next.join(",") + "/" + nextDir + "/" + nextTurns;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push({ path: [...path, next], dir: nextDir, turns: nextTurns });
    }
  }
  return null;
}

export function pickPair(board: (number | null)[]) {
  for (let first = 0; first < board.length; first++) for (let second = first + 1; second < board.length; second++)
    if (connectTiles(board, first, second)) return [first, second] as const;
  return null;
}
