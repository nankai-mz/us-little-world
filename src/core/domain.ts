import { AppError, type Entry, type Pet } from "./types";
import { today } from "./date";
export { QUESTIONS, QUIZ } from "./questions";
export const newPet = (): Pet => ({
  name: "糯米",
  exp: 0,
  hunger: 75,
  mood: 80,
  energy: 85,
  intimacy: 0,
  decorations: ["plant"],
  history: [],
});
export function petAction(
  pet: Pet,
  action: string,
  userId: string,
  at = Date.now(),
): Pet {
  const day = today(new Date(at));
  if (!["feed", "pat", "play", "sleep"].includes(action))
    throw new AppError("INVALID_ACTION", "未知互动");
  if (
    pet.history.filter(
      (h) => h.userId === userId && h.day === day && h.action === action,
    ).length >= 5
  )
    throw new AppError("DAILY_LIMIT", "今天已经陪它玩够啦，休息一下也很好");
  const p = {
    ...pet,
    history: [...pet.history, { userId, action, day, at }],
    exp: pet.exp + 8,
    intimacy: pet.intimacy + 1,
  };
  if (action === "feed") p.hunger = Math.min(100, p.hunger + 12);
  if (action === "pat") p.mood = Math.min(100, p.mood + 10);
  if (action === "play") {
    p.mood = Math.min(100, p.mood + 15);
    p.energy = Math.max(0, p.energy - 5);
  }
  if (action === "sleep") p.energy = Math.min(100, p.energy + 20);
  return p;
}
export function canOpenCapsule(e: Entry, members: string[], now = today()) {
  return (
    !!e.data.unlockDate &&
    now >= e.data.unlockDate &&
    (!e.data.needsBoth ||
      (members.length === 2 &&
        members.every((m) => e.data.confirmedBy?.includes(m))))
  );
}
export function report(entries: Entry[], from: string, to: string) {
  const shared = entries.filter(
    (e) =>
      !e.deletedAt &&
      e.visibility === "shared" &&
      e.data.date >= from &&
      e.data.date <= to,
  );
  const memories = shared.filter((e) => e.data.kind === "memory");
  return {
    memories: memories.length,
    photos: memories.reduce((n, e) => n + (e.data.photos?.length || 0), 0),
    places: shared.filter((e) => e.data.kind === "place").length,
    wishes: entries.filter(
      (e) =>
        !e.deletedAt &&
        e.visibility === "shared" &&
        e.data.kind === "wish" &&
        e.data.completedAt &&
        e.data.completedAt >= from &&
        e.data.completedAt <= to,
    ).length,
    games: shared.filter(
      (e) =>
        ["question", "quiz"].includes(e.data.kind) &&
        Object.keys(e.data.answers || {}).length === 2,
    ).length,
    pet: entries
      .filter(
        (e) =>
          !e.deletedAt && e.visibility === "shared" && e.data.kind === "pet",
      )
      .reduce(
        (n, e) =>
          n +
          (e.data.pet?.history.filter((h) => h.day >= from && h.day <= to)
            .length || 0),
        0,
      ),
    highlights: memories
      .slice()
      .sort((a, b) => b.data.date.localeCompare(a.data.date))
      .slice(0, 6),
  };
}
export function secureChoice<T>(items: T[], random: Uint8Array): T {
  if (items.length < 2 || items.length > 256)
    throw new AppError("INVALID_OPTIONS", "请填写 2 到 256 个不同选项");
  const limit = 256 - (256 % items.length);
  const n = random.find((x) => x < limit);
  if (n === undefined) throw new AppError("RETRY_RANDOM", "请再转一次");
  return items[n % items.length];
}
