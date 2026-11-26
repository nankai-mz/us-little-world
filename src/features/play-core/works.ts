import { activities, type ActivityId } from "./catalog";
import type { AsyncActivity, MemoryReference } from "./async-games";
import type { CanvasItem, Drawing } from "../canvas-core/canvas";
import { isMediaGame, type PlayGame } from "./game";
import { flowers, gardenCard, puzzleFinished, type BloomCard, type Music, type PhotoReference, type Sky, type Stars } from "./media-games";
import { isSceneGame, levelsFor, itemsFor, type World } from "../scene-core/scene";
import { escapeRooms, orders } from "../scene-core/levels";

export type WorkCover = { kind: "title" } | { kind: "canvas"; panel: number } | ({ kind: "photo" } & PhotoReference);

export interface WorkContent {
  version: 1;
  activityId: ActivityId;
  title: string;
  markdown: string;
  roomId: string;
  references: MemoryReference[];
  cover?: WorkCover;
  canvas?: { objects: CanvasItem[]; paper: Drawing["paper"]; frames: string[]; backgrounds?: string[]; cover: string; ending: string };
  postcard?: Music | Sky | Stars | BloomCard;
  world?: World;
}

export function withWorkCover(work: WorkContent): WorkContent & { cover: WorkCover } {
  const cover = work.cover;
  if (cover?.kind === "title" || (cover?.kind === "canvas" && work.canvas?.objects.some((item) =>
    item.panel === cover.panel && item.kind !== "group" && item.kind !== "link")) ||
    (cover?.kind === "photo" && work.references.some(({ recordId, fileId }) => !!fileId &&
      recordId === cover.recordId && fileId === cover.fileId))) return { ...work, cover };

  const item = work.canvas?.objects.find(({ kind }) => kind !== "group" && kind !== "link");
  if (item) return { ...work, cover: { kind: "canvas", panel: item.panel } };
  const photo = work.references.find(({ fileId }) => !!fileId);
  return { ...work, cover: photo?.fileId ? { kind: "photo", recordId: photo.recordId, fileId: photo.fileId } : { kind: "title" } };
}

export function archiveGame(game: PlayGame, title: string, roomId: string): WorkContent {
  if (isSceneGame(game)) {
    const base = { version: 1 as const, activityId: game.id, title, roomId, references: [] as MemoryReference[], markdown: "" };
    switch (game.id) {
      case "g04": return { ...base, markdown: game.served.map((index) => orders[index].name).join("\n\n") };
      case "g11": return { ...base, markdown: game.finished.map((index) => escapeRooms[index].name + " · 双人通关").join("\n\n") };
      case "g12":
      case "g13": return { ...base, markdown: game.solved.map((index) => levelsFor(game.id)[index].name + " · 到达出口").join("\n\n"),
        references: game.tribute ? [{ recordId: game.tribute, ...(game.tributePhoto ? { fileId: game.tributePhoto } : {}) }] : [] };
      case "c17":
      case "w23": {
        const references = new Map<string, MemoryReference>();
        for (const { memory, photo } of game.decorations) {
          if (memory) references.set(`${memory}:${photo ?? ""}`, { recordId: memory, ...(photo ? { fileId: photo } : {}) });
        }
        return { ...base, world: game, markdown: game.decorations.map((item) =>
          `${itemsFor(game.id).find(([kind]) => kind === item.kind)?.[1]}（${item.x + 1}, ${item.y + 1}）`).join("\n\n"),
          references: [...references.values()] };
      }
    }
  }
  if (isMediaGame(game)) {
    const base = { version: 1 as const, activityId: game.id, title, roomId, references: [] as MemoryReference[], markdown: "" };
    switch (game.id) {
      case "g02": return puzzleFinished(game) ? { ...base, references: [game.photo!], markdown: `${game.size} × ${game.size} 拼图 · 移动了 ${game.moves} 步` } : base;
      case "g08": return game.cleared === 24 ? { ...base, markdown: `一起连起 ${game.cleared} 对图案 · ${game.together} 次接力` } : base;
      case "g10": return game.answer && game.photo ? { ...base, references: [game.photo],
        markdown: `猜测：${game.guess}\n\n记录日期：${game.answer}` } : base;
      case "g14": {
        const postcard = gardenCard(game);
        return postcard ? { ...base, postcard,
          markdown: `${flowers[postcard.seed].symbol} ${flowers[postcard.seed].name}开花了\n\n两个人照料了 ${postcard.growth} 次${postcard.decoration ? "，在花盆上留了" + postcard.decoration : ""}。` } : base;
      }
      case "c18": return game.stars.length >= 3 && game.name ? { ...base, title: game.name, postcard: game,
        references: game.stars.map(({ photo }) => photo), markdown: game.story || `${game.stars.length} 颗星` } : base;
      case "c20": return { ...base, postcard: game, references: game.cards.flatMap((card) => card?.photos ?? []),
        markdown: game.cards.flatMap((card) => card ? [`## ${card.track} · ${card.artist}\n\n${card.note}`] : []).join("\n\n") };
      case "c21": return game.cards.every(Boolean) ? { ...base, postcard: game, references: game.cards.flatMap((card) => card ? [card.photo] : []),
        markdown: game.cards.map((card) => [card?.city, card?.note].filter(Boolean).join(" · ")).filter(Boolean).join("\n\n") || "两张同一天的天空" } : base;
      case "w24": return { ...base, references: game.selected.map((recordId) => ({ recordId })),
        markdown: game.selected.length ? `挑选了 ${game.selected.length} 段共同回忆` : "" };
    }
  }
  if (!("objects" in game)) return textWork(game, title, roomId);
  const objects = game.id === "g01" ? game.rounds.filter((round) => round.artwork).at(-1)?.artwork ?? [] : game.objects;
  const references = objects.flatMap((object) => object.kind === "photo" || object.kind === "wish" ? [object.reference] : []);
  const keys = new Set();
  const items = references.filter((ref) => {
    const key = ref.recordId + ":" + (ref.fileId ?? "");
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  const notes = objects.flatMap((item) => "text" in item ? [item.text] : []);
  if (game.id === "g01") notes.push(...game.rounds.flatMap((round) => round.result
    ? [`${round.result.answer} · ${round.result.correct ? "猜对了" : "时间到"}`] : []));
  const frames = game.frames.map(({ title }) => title);
  return {
    version: 1, activityId: game.id, title, roomId, references: items.slice(0, 100),
    markdown: [game.cover, ...frames, ...notes, game.ending].filter(Boolean).join("\n\n") ||
      (objects.length ? `共 ${objects.length} 个绘图物件` : ""),
    canvas: { objects, paper: game.paper, frames, backgrounds: game.frames.map((frame) => frame.background ?? "paper"),
      cover: game.cover, ending: game.ending },
  };
}

export function textWork(activity: AsyncActivity, title: string, roomId: string): WorkContent {
  const references: MemoryReference[] = [];
  let sections: string[];
  switch (activity.id) {
    case "g03":
      sections = activity.rounds.filter((round) => round.answers.every(Boolean)).map((round) =>
        [`## ${round.question}`, ...round.answers.map((answer, i) => `成员 ${i + 1}：${answer?.text ?? "跳过"}`),
          ...round.comments.map(({ text }) => text)].join("\n\n"));
      break;
    case "g06":
    case "g07":
      sections = activity.rounds.filter((round) => round.answer).map((round) => {
        if (round.answer?.memoryId) references.push({ recordId: round.answer.memoryId });
        return [`## ${round.symbols?.join(" ") || round.prompt}`, `猜测：${round.guess}`,
          `答案：${round.answer!.text}`, ...round.comments.map(({ text }) => text)].join("\n\n");
      });
      break;
    case "g09":
      sections = activity.boxes.flatMap((box) => {
        if (!box || (!box.opened && !box.instant)) return [];
        if (box.memory) references.push(box.memory);
        return [box.text + (box.reply ? `\n\n${box.reply === "accept" ? "已接受邀请" : "这次先跳过"}` : "")];
      });
      break;
    case "g05":
      sections = [...activity.game.history, { stones: activity.game.stones, winner: activity.game.winner }]
        .filter(({ stones }) => stones.length).map(({ stones, winner }, i) =>
          [`## 第 ${i + 1} 局`, winner === "draw" ? "平局" : winner === null ? "进行中" : `成员 ${winner + 1} 获胜`,
            stones.map(({ x, y, by }) => `${by === 0 ? "●" : "○"} ${String.fromCharCode(65 + x)}${y + 1}`).join(" · ")]
            .join("\n\n"));
      break;
    case "c19":
      sections = activity.chapters.filter(({ accepted }) => accepted).map((chapter) =>
        [`## ${chapter.title}`, chapter.text, ...chapter.comments.map(({ text }) => `> ${text.replace(/\n/g, "\n> ")}`)].join("\n\n"));
      break;
  }
  return { version: 1, activityId: activity.id, title: title.trim() || activities[activity.id].title,
    markdown: sections.join("\n\n"), roomId, references };
}
