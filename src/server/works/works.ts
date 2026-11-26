import type { CipherRecord } from "../../core/types";
import { memoryIdPattern, playActions, type RoomHeader, type WorkHeader } from "../../features/play-core/protocol";
import type { PlayAccess } from "../activities/rooms";
import { collections, sequenceKey, type PlayTransaction } from "../activities/store";
import { check, cipher, counter, object, playId } from "../activities/validation";

type WorkRow = WorkHeader & { totalBytes: number };
const maxWorkBytes = 8 * 1024 * 1024;
const maxWorks = 96;

function publicWork({ totalBytes: _total, ...work }: WorkRow): WorkHeader {
  return work;
}

function visible(work: WorkRow | null, access: PlayAccess): work is WorkRow {
  return !!work && work.spaceId === access.space.id &&
    (work.visibility === "shared" || (!access.device.sharedOnly && work.authorId === access.device.userId));
}

export async function removeWork(tx: PlayTransaction, workId: string) {
  tx.clear(collections.versions, workId);
  tx.clearWorkMedia(workId);
  await tx.remove(collections.works, workId);
}

async function validateReferences(tx: PlayTransaction, access: PlayAccess, value: unknown, scope: WorkHeader["visibility"], workId: string) {
  const references = value === undefined ? [] : value;
  check(Array.isArray(references) && references.length <= 1000, "INVALID_REQUEST", "回忆引用数量超过上限");
  for (const candidate of references) {
    const reference = object(candidate);
    const id = reference.recordId;
    check(typeof id === "string" && memoryIdPattern.test(id), "INVALID_REQUEST", "回忆标识不正确");
    const record: CipherRecord | null = await tx.get("encrypted_records", id);
    check(record && !record.deletedAt && record.spaceId === access.space.id &&
      (record.visibility === "shared" || (scope === "private" && record.creatorId === access.device.userId && !access.device.sharedOnly)),
    "REFERENCE_UNAVAILABLE", "某条回忆已删除或未授权，请重新选择");
    if (reference.fileId !== undefined) {
      const file = await tx.get("encrypted_files", playId(reference.fileId));
      check(file && file.spaceId === access.space.id && file.recordId === id &&
        file.visibility === record.visibility && !file.staging,
      "REFERENCE_UNAVAILABLE", "某张照片已删除或未授权，请重新选择");
    }
    if (record.playMediaRoomId) await tx.put(collections.workMedia, id + ":" + workId, { spaceId: record.spaceId, workId });
  }
}

export async function works(tx: PlayTransaction, access: PlayAccess, action: string, input: Record<string, unknown>, now: number) {
  const { space, device } = access;
  if (action === playActions.listWorks) {
    const after = input.after === undefined ? "" : playId(input.after);
    const page = tx.works(space.id, after, device.sharedOnly ? null : device.userId, 9) as WorkRow[];
    return { items: page.slice(0, 8).map(publicWork), next: page.length > 8 ? page[7].id : null };
  }
  const id = playId(input.workId);
  const existing: WorkRow | null = await tx.get(collections.works, id);
  if (action === playActions.getWork) {
    check(visible(existing, access), "WORK_UNAVAILABLE", "此作品已删除或不可访问");
    if (input.revision !== undefined) {
      const version: WorkHeader | null = await tx.get(collections.versions, id + ":" + sequenceKey(counter(input.revision)));
      check(version, "WORK_UNAVAILABLE", "找不到该版本");
      return version;
    }
    return publicWork(existing);
  }
  const opId = playId(input.opId);
  const expected = counter(input.expectedRevision);
  const deletion = await tx.get(collections.deleted, id);
  if (action === playActions.deleteWork) {
    if (!existing && deletion?.spaceId === space.id && deletion.authorId === device.userId &&
      deletion.opId === opId && (!device.sharedOnly || deletion.visibility === "shared")) return null;
    check(visible(existing, access) && existing.authorId === device.userId,
      "WORK_UNAVAILABLE", "只有作品创建者可以删除作品");
    check(existing.revision === expected, "REVISION_CONFLICT", "作品已有新版本，请核对后再删除");
    await removeWork(tx, id);
    await tx.put(collections.deleted, id, { spaceId: space.id, authorId: device.userId, opId, visibility: existing.visibility });
    return null;
  }
  check(action === playActions.saveWork, "UNKNOWN_ACTION", "暂不支持此作品操作");
  check(!deletion && (!existing || visible(existing, access)), "WORK_UNAVAILABLE", "此作品已删除或不可访问");
  const visibility = input.visibility;
  check(visibility === "shared" || (visibility === "private" && !device.sharedOnly),
    "INVALID_VISIBILITY", "此设备只能保存共同作品");
  check(!existing || existing.visibility === visibility, "INVALID_VISIBILITY", "请另存为新作品以更改共享范围");
  const envelope = cipher(input.envelope, space.keyVersion, 1400000);
  const revision = expected + 1;
  if (existing && expected < existing.revision) {
    const previous: WorkHeader | null = await tx.get(collections.versions, id + ":" + sequenceKey(revision));
    if (previous?.opId === opId && previous.deviceId === device.id && JSON.stringify(previous.envelope) === JSON.stringify(envelope))
      return previous;
  }
  check((existing?.revision ?? 0) === expected, "REVISION_CONFLICT", "作品已有新版本，请核对后再保存");
  const totalBytes = (existing?.totalBytes ?? 0) + envelope.ciphertext.length;
  check(revision <= 40 && totalBytes <= maxWorkBytes, "WORK_LIMIT", "此作品已达到版本上限，请另存新作品");
  if (!existing) {
    if (visibility === "shared") {
      if (input.sourceWorkId !== undefined) {
        const source: WorkRow | null = await tx.get(collections.works, playId(input.sourceWorkId));
        check(visible(source, access) && source.visibility === "private" && source.authorId === device.userId,
          "WORK_UNAVAILABLE", "只有私人作品的作者可以另存共享副本");
      } else {
        const room: RoomHeader | null = await tx.get(collections.rooms, playId(input.sourceRoomId));
        const agreed = room?.archive && room.archive.approved.length === 2 && room.archive.through === room.lastSeq;
        check(room?.spaceId === space.id && room.memberIds.includes(device.userId) && (room.status === "completed" || agreed) &&
          room.lastSeq === input.sourceSequence,
          "ROOM_INACTIVE", "需要两位成员确认同一进度后才能收藏，请刷新房间");
      }
    }
    check(tx.works(space.id, "", device.userId, maxWorks).length < maxWorks, "WORK_LIMIT", "作品数量达到上限");
  }
  await validateReferences(tx, access, input.references, visibility, id);
  const next: WorkRow = {
    id, spaceId: space.id, authorId: existing?.authorId ?? device.userId, visibility, revision,
    createdAt: existing?.createdAt ?? now, updatedAt: now, deviceId: device.id, opId, envelope, totalBytes,
  };
  await tx.put(collections.versions, id + ":" + sequenceKey(revision), publicWork(next));
  await tx.put(collections.works, id, next);
  return publicWork(next);
}
