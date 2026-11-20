import { encryptRecord, randomId } from "./crypto";
import { dayNumber } from "./date";
import { AppError, type Entry, type Payload, type RandomSource, type Secrets, type Visibility } from "./types";

export async function prepareRecordWrite(
  data: Payload, visibility: Visibility, secrets: Secrets, keyVersion: number, rng: RandomSource,
  existing?: Entry, fixedId?: string,
) {
  const scope = existing?.visibility ?? visibility;
  if (scope === "private" && (secrets.sharedOnly || (existing && existing.creatorId !== secrets.userId)))
    throw new AppError("PRIVATE_KEY_REQUIRED", "请从原设备导出的加密备份恢复私人记录");
  if (existing && existing.spaceId !== secrets.spaceId)
    throw new AppError("SPACE_MISMATCH", "不能修改另一空间的记录");
  if (!data.title.trim()) throw new AppError("TITLE_REQUIRED", "写个小标题吧");
  dayNumber(data.date);
  if (data.kind === "capsule") dayNumber(data.unlockDate || "");
  if (existing && data.kind === "memory" && (data.title !== existing.data.title || data.body !== existing.data.body)) {
    data = {
      ...data,
      history: [...(existing.data.history || []), {
        at: Date.now(), title: existing.data.title, body: existing.data.body || "",
      }].slice(-10),
    };
  }
  const now = Date.now();
  const ownerOnly = existing?.ownerOnly || (!existing && scope === "shared" &&
    (data.kind === "wardrobe-share" || data.kind === "wardrobe-suggestion"));
  const meta = {
    id: existing?.id || fixedId || (await randomId(rng)),
    spaceId: secrets.spaceId,
    creatorId: existing?.creatorId || secrets.userId,
    visibility: scope,
    revision: existing?.revision || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...(ownerOnly ? { ownerOnly: true as const } : {}),
  };
  const record = await encryptRecord(meta, data, secrets, rng, keyVersion);
  const photoRefs = [...new Set((data.photos ?? []).flatMap((photo) => photo.fileId ? [photo.fileId] : []))];
  return { record, expectedRevision: meta.revision, photoRefs, data };
}
