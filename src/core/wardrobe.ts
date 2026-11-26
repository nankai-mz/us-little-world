import { hashText } from "./crypto";
import { AppError, type Attachment, type Entry } from "./types";
import type { UsService } from "./service";

export const wardrobeSlots = ["上装", "下装", "外套", "鞋履", "配饰"] as const;
export const wardrobeNameLimit = 32;
export const wardrobeWeatherLimit = 40;
export const wardrobePreviewLimit = 6;
export type WardrobeSlot = typeof wardrobeSlots[number];
type PublicItem = { id: string; name: string; slot: WardrobeSlot; photoId?: string };
export type WardrobeSelection = {
  edition: number;
  items: PublicItem[];
  weather?: string;
  response?: { revision: number; accepted: boolean };
};
export type WardrobeSuggestion = { selectionEdition: number; selected: string[] };

const resourceId = (kind: string, ...parts: string[]) => hashText(JSON.stringify(["Us/wardrobe", kind, ...parts]));
const isSlot = (value: unknown): value is WardrobeSlot => wardrobeSlots.includes(value as WardrobeSlot);

export const visibleItemId = (selectionId: string, itemId: string) => resourceId("item", selectionId, itemId);
export function privateWardrobe(service: UsService) {
  return service.active.filter((entry) => entry.visibility === "private" && entry.creatorId === service.userId &&
    entry.data.kind === "wardrobe-item" && isSlot(entry.data.category));
}
export function wardrobeSelection(service: UsService, ownerId: string) {
  const id = resourceId("selection", service.space?.id ?? "", ownerId);
  return service.active.find((entry) => entry.id === id && entry.ownerOnly &&
    entry.visibility === "shared" && entry.creatorId === ownerId && entry.data.kind === "wardrobe-share");
}
export function wardrobeSuggestion(service: UsService, senderId: string, ownerId: string) {
  const selection = wardrobeSelection(service, ownerId)?.data.wardrobeSelection;
  if (!selection?.items.length) return;
  const id = resourceId("suggestion", service.space?.id ?? "", senderId, ownerId, String(selection.edition));
  const suggestion = service.active.find((entry) => entry.id === id && entry.ownerOnly &&
    entry.visibility === "shared" && entry.creatorId === senderId && entry.data.kind === "wardrobe-suggestion");
  return suggestion?.data.wardrobeSuggestion?.selectionEdition === selection.edition
    ? suggestion : undefined;
}

async function latest(service: UsService, partnerRequired = false) {
  const secrets = service.secrets;
  if (!secrets) throw new AppError("LOCKED", "请先解锁");
  await service.refresh();
  const space = service.space;
  if (!space || secrets !== service.secrets) throw new AppError("LOCKED", "请先解锁");
  if (partnerRequired && space.members.length !== 2) throw new AppError("WARDROBE_MEMBERS", "等双方加入后再共享穿搭");
  return { space, me: secrets.userId };
}

export async function addWardrobeItem(
  service: UsService, name: string, slot: WardrobeSlot, image?: Attachment | (() => Promise<Attachment>),
) {
  const title = name.trim();
  if (!isSlot(slot) || !title || [...title].length > wardrobeNameLimit)
    throw new AppError("WARDROBE_ITEM", "请选择类别，并填写 1 至 32 字的衣物名称");
  await latest(service);
  if (!service.hasPrivateAccess) throw new AppError("PRIVATE_KEY_REQUIRED", "请先恢复本机私人记录密钥");
  if (privateWardrobe(service).length >= 24) throw new AppError("WARDROBE_LIMIT", "私人衣橱最多收纳 24 件衣物");
  const session = service.secrets;
  const photo = typeof image === "function" ? await image() : image;
  try {
    if (!session || session !== service.secrets) throw new AppError("LOCKED", "请先解锁");
    await service.save({ kind: "wardrobe-item", title, date: service.day, category: slot, ...(photo ? { photos: [photo] } : {}) }, "private");
  } catch (error) {
    if (typeof image === "function" && photo?.fileId && session === service.secrets &&
      error instanceof AppError && !["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE", "WRITE_UNCONFIRMED"].includes(error.code))
      await service.call("fileDelete", { fileId: photo.fileId }).catch(() => {});
    throw error;
  }
}

export async function publishWardrobe(
  service: UsService, privateIds: string[], weather: string, previousEdition: number, previewIds: string[] = [],
) {
  const { space, me } = await latest(service, true);
  if (!service.hasPrivateAccess) throw new AppError("PRIVATE_KEY_REQUIRED", "请先恢复本机私人记录密钥");
  if (space.status !== "active") throw new AppError("SPACE_CLOSING", "空间处于只读期，暂时无法更新共享衣物");
  const existing = wardrobeSelection(service, me);
  const current = existing?.data.wardrobeSelection;
  if ((current?.edition ?? 0) !== previousEdition) throw new AppError("WARDROBE_CHANGED", "共享衣物已更新，请重新选择");
  if (privateIds.length > 8 || new Set(privateIds).size !== privateIds.length || [...weather.trim()].length > wardrobeWeatherLimit)
    throw new AppError("WARDROBE_LIMIT", "最多共享 8 件衣物，天气备注限 40 字");
  if (previewIds.length > wardrobePreviewLimit || new Set(previewIds).size !== previewIds.length ||
    previewIds.some((id) => !privateIds.includes(id)))
    throw new AppError("WARDROBE_LIMIT", "最多为 6 件已选衣物共享照片");
  if (previewIds.length && !service.supportsManagedPhotos)
    throw new AppError("WARDROBE_PREVIEW_UNAVAILABLE", "当前服务暂不支持共享衣物照片");
  if (!existing && !privateIds.length) return;
  const selectionId = resourceId("selection", space.id, me);
  const wardrobe = privateWardrobe(service);
  const sources = privateIds.map((id) => {
    const item = wardrobe.find((entry) => entry.id === id);
    const slot = item?.data.category;
    if (!item || !isSlot(slot)) throw new AppError("WARDROBE_ITEM", "所选衣物已经移除，请重新选择");
    const photo = previewIds.includes(id) ? item.data.photos?.[0] : undefined;
    if (previewIds.includes(id) && !photo?.fileId)
      throw new AppError("WARDROBE_ITEM", "有衣物照片已不可用，请重新选择");
    return { id: visibleItemId(selectionId, item.id), name: item.data.title, slot, photo };
  });
  const session = service.secrets;
  const active = () => !!session && session === service.secrets && space.id === service.space?.id;
  const items: PublicItem[] = [];
  const photos: Attachment[] = [];
  const uploads: Attachment[] = [];
  try {
    for (const { id, name, slot, photo } of sources) {
      const item: PublicItem = { id, name, slot };
      if (photo) {
        const previousPhotoId = current?.items.find((previous) => previous.id === id)?.photoId;
        let preview = existing?.data.photos?.find((attachment) => attachment.id === previousPhotoId);
        if (!preview) {
          const bytes = await service.readPhotoBytes(photo, "private", active);
          if (!active()) throw new AppError("LOCKED", "请先解锁");
          preview = await service.addPhoto(bytes, photo.mime, `${name}的共享预览`, "shared");
          uploads.push(preview);
        }
        item.photoId = preview.id;
        photos.push(preview);
      }
      items.push(item);
    }
    if (!active()) throw new AppError("LOCKED", "请先解锁");
    const selection = { edition: previousEdition + 1, items, ...(items.length && weather.trim() ? { weather: weather.trim() } : {}) };
    await service.save(
      { kind: "wardrobe-share", title: "衣橱共享", date: service.day, wardrobeSelection: selection, ...(photos.length ? { photos } : {}) },
      "shared", existing, selectionId,
    );
  } catch (error) {
    if (active() && error instanceof AppError && !["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE", "WRITE_UNCONFIRMED"].includes(error.code))
      await Promise.all(uploads.map(({ fileId }) => service.call("fileDelete", { fileId }).catch(() => {})));
    throw error;
  }
}

export async function suggestWardrobe(service: UsService, owner: string, selected: string[], edition: number, revision: number) {
  const { space, me } = await latest(service, true);
  if (owner === me || !space.members.includes(owner)) throw new AppError("WARDROBE_OWNER", "只能为另一位成员提交搭配");
  const selection = wardrobeSelection(service, owner)?.data.wardrobeSelection;
  const items = selected.map((id) => selection?.items.find((item) => item.id === id));
  if (!selection || edition !== selection.edition || !items.length || items.some((item) => !item) ||
    new Set(items.map((item) => item?.slot)).size !== items.length)
    throw new AppError("WARDROBE_CHANGED", "请选择最新共享衣物，每个类别只能选一件");
  const existing = wardrobeSuggestion(service, me, owner);
  if ((existing?.revision ?? 0) !== revision) throw new AppError("WARDROBE_CHANGED", "已有更新的搭配，请刷新后查看");
  await service.save({ kind: "wardrobe-suggestion", title: "搭配建议", date: service.day,
    wardrobeSuggestion: { selectionEdition: edition, selected } }, "shared", existing,
  resourceId("suggestion", space.id, me, owner, String(edition)));
}

export async function respondToWardrobe(service: UsService, edition: number, revision: number, accepted: boolean) {
  const { space, me } = await latest(service, true);
  const existing = wardrobeSelection(service, me);
  const selection = existing?.data.wardrobeSelection;
  const other = space.members.find((member) => member !== me);
  const suggestion = other && wardrobeSuggestion(service, other, me);
  if (!existing || !selection || selection.edition !== edition || !suggestion || suggestion.revision !== revision)
    throw new AppError("WARDROBE_CHANGED", "搭配建议已更新，请刷新后查看");
  await service.save({ ...existing.data, wardrobeSelection: { ...selection, response: { revision, accepted } } }, "shared", existing);
}
