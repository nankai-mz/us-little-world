import { hashText } from "./crypto";
import type { Attachment, Entry } from "./types";

export type GalaxyStar = {
  id: string;
  memory: Entry;
  photo: Attachment;
  year: string;
  group: string;
  x: number;
  y: number;
  color: number;
};

export function buildGalaxy(entries: Entry[]): GalaxyStar[] {
  const stars = new Map<string, GalaxyStar>();
  for (const memory of entries) {
    if (memory.deletedAt || memory.visibility !== "shared" || memory.data.kind !== "memory") continue;
    const year = memory.data.date.slice(0, 4);
    const group = memory.data.date.slice(0, 7);
    const month = Math.max(0, Math.min(11, Number(group.slice(5)) - 1 || 0));
    for (const photo of memory.data.photos ?? []) {
      if ((!photo.fileId && !photo.sample) || stars.has(photo.id)) continue;
      const hash = hashText(JSON.stringify([photo.id, group]));
      stars.set(photo.id, {
        id: photo.id, memory, photo, year, group,
        x: 4 + (month + (Number.parseInt(hash.slice(0, 6), 16) % 600) / 1000 + 0.2) * (92 / 12),
        y: 5 + (Number.parseInt(hash.slice(6, 12), 16) % 9000) / 100,
        color: Math.floor(month / 3),
      });
    }
  }
  return [...stars.values()];
}

export function drawGalaxyStar(stars: GalaxyStar[], randomWord: () => number): GalaxyStar | undefined {
  if (stars.length < 2) return stars[0];
  const range = 2 ** 32;
  const limit = range - (range % stars.length);
  let word = randomWord();
  while (word >= limit) word = randomWord();
  return stars[word % stars.length];
}
