import type { UsService } from "./service";
import { AppError, type Attachment, type Entry, type Payload } from "./types";

export type MealStamp = "again" | "other";
export const stampNames: Record<MealStamp, string> = { again: "还想再来", other: "下次换一家" };

export function receiptOf(data: Payload): Payload["mealReceipt"] {
  if (data.kind !== "memory") return;
  if (data.mealReceipt) return data.mealReceipt;
  // Meals archived before the receipt design have just the generated title and tag.
  const old = data.tags?.includes("今天吃什么") && /^(早餐|午餐|晚餐)吃(.+)$/.exec(data.title);
  if (old) return { meal: old[1], dish: old[2] };
}

export function canReplyToPhoto(entry: Entry, me: string) {
  const photos = entry.data.photos ?? [];
  return entry.data.kind === "memory" && entry.data.photoPage === true && !entry.deletedAt &&
    entry.visibility === "shared" && entry.creatorId !== me && photos.length > 0 && photos.length < 6 &&
    !photos.some(photo => photo.id === entry.data.replyPhotoId);
}

// Preserve changes made by the other member while the editor was open.
export function rebaseJournalEdit(base: Payload, edited: Payload, latest: Payload): Payload {
  const changes = Object.entries(edited).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(base[key as keyof Payload]));
  const result: Payload = { ...latest, ...Object.fromEntries(changes) };
  if (changes.some(([key]) => key === "photos") && latest.photos) {
    const original = new Set(base.photos?.map(photo => photo.id));
    const local = edited.photos ?? [];
    const kept = new Set(local.map(photo => photo.id));
    const remote = new Set(latest.photos.map(photo => photo.id));
    result.photos = [
      ...latest.photos.filter(photo => !original.has(photo.id) || kept.has(photo.id)),
      ...local.filter(photo => !original.has(photo.id) && !remote.has(photo.id)),
    ];
  }
  const original = receiptOf(base), remote = receiptOf(latest), local = edited.mealReceipt;
  if (original && local && remote) {
    const meal = local.meal !== original.meal ? local.meal : remote.meal;
    const dish = local.dish !== original.dish ? local.dish : remote.dish;
    result.mealReceipt = { ...remote, meal, dish };
    if (local.meal !== original.meal || local.dish !== original.dish) result.title = meal + "吃" + dish;
  }
  return result;
}

async function updateKeepsake(service: UsService, id: string, patch: (entry: Entry) => Payload | undefined) {
  const session = service.secrets;
  for (let attempt = 0; attempt < 3; attempt++) {
    await service.refresh();
    if (!session || service.secrets !== session) throw new AppError("LOCKED", "请重新解锁空间");
    const entry = service.active.find(item => item.id === id && item.visibility === "shared");
    if (!entry || service.space?.status !== "active") throw new AppError("RECORD_UNAVAILABLE", "这页收藏暂时无法修改");
    const data = patch(entry);
    if (!data) return;
    try {
      await service.save(data, "shared", entry);
      return;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "REVISION_CONFLICT" || attempt === 2) throw error;
    }
  }
}

export async function stampMeal(service: UsService, id: string, stamp: MealStamp) {
  await updateKeepsake(service, id, entry => {
    const receipt = receiptOf(entry.data);
    if (!receipt) throw new AppError("RECORD_UNAVAILABLE", "这张小票已更改");
    if (receipt.stamps?.[service.userId] === stamp) return;
    return { ...entry.data, mealReceipt: { ...receipt, stamps: { ...receipt.stamps, [service.userId]: stamp } } };
  });
}

export async function finishPhotoPair(service: UsService, id: string, photo: Attachment) {
  await updateKeepsake(service, id, entry => {
    if (entry.data.replyPhotoId === photo.id && entry.data.photos?.some(item => item.id === photo.id)) return;
    if (!canReplyToPhoto(entry, service.userId)) throw new AppError("PHOTO_CHANGED", "这张相纸已更新，请重新查看");
    return { ...entry.data, photos: [...entry.data.photos!, photo], replyPhotoId: photo.id };
  });
}
