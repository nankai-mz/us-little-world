import { authorizedDevice } from "../api";
import type { Device, Space } from "../../core/types";
import {
  PLAY_PROTOCOL, playActions, playRetention, type ActivityMode, type OperationReceipt, type OpHeader,
  type PlayStage, type RoomCheckpoint, type RoomHeader, type RoomPage, type Seat, type StoredOperation,
} from "../../features/play-core/protocol";
import { collections, sequenceKey, type PlayTransaction } from "./store";
import { check, cipher, counter, object, playId, seat } from "./validation";

export interface PlayActor {
  accountId: string;
  deviceId: string;
  spaceId: string;
}

export interface PlayAccess {
  device: Device;
  space: Space;
}

type StoredRoom = RoomHeader & { bytes: number };
type StoredReceipt = OperationReceipt & { spaceId: string; deviceId: string; digest: string };

const maxOperations = 5000;
const maxRoomBytes = 8 * 1024 * 1024;
const maxRooms = 80;

export async function playAccess(tx: PlayTransaction, actor: PlayActor): Promise<PlayAccess> {
  const space: Space | null = await tx.get("spaces", actor.spaceId);
  check(space?.status === "active" && space.members.includes(actor.accountId), "MEMBER_REQUIRED", "当前账号不能访问这个空间");
  const device = await authorizedDevice(tx, actor.deviceId, actor.accountId, actor.spaceId);
  return { device, space };
}

function roomSeat(room: RoomHeader, access: PlayAccess): Seat {
  return room.memberIds[0] === access.device.userId ? 0 : 1;
}

function visible(room: StoredRoom | null, access: PlayAccess, now: number, stages: ReadonlySet<string>): room is StoredRoom {
  return !!room && room.spaceId === access.space.id &&
    room.memberIds.every((member) => access.space.members.includes(member)) &&
    room.memberIds.includes(access.device.userId) &&
    (room.expiresAt === null || room.expiresAt > now) && stages.has(room.stage);
}

export async function authorizedRoom(tx: PlayTransaction, id: string, access: PlayAccess, now: number, stages: ReadonlySet<string>) {
  const room: StoredRoom | null = await tx.get(collections.rooms, id);
  check(visible(room, access, now, stages), "ROOM_UNAVAILABLE", "此活动已过期或不可访问");
  return room;
}

function renewable(room: RoomHeader, now: number) {
  return room.expiresAt === null ? null : now + playRetention;
}

export async function removeRoom(tx: PlayTransaction, id: string) {
  tx.clear(collections.operations, id);
  tx.clear(collections.receipts, id);
  await tx.remove(collections.checkpoints, id);
  await tx.remove(collections.proposals, id);
  await tx.remove(collections.rooms, id);
}

function publicHeader({ bytes: _bytes, ...room }: StoredRoom): RoomHeader {
  return room;
}

export async function rooms(
  tx: PlayTransaction, access: PlayAccess, action: string, input: Record<string, unknown>, now: number,
  stages: ReadonlySet<string>, hash: (value: string) => string,
) {
  const { space, device } = access;
  check(space.members.length === 2, "PAIR_REQUIRED", "两位成员配对后即可开始活动");
  if (action === playActions.list) {
    const after = input.after === undefined ? "" : playId(input.after);
    const rows = tx.rooms(space.id, after, now, maxRooms + 1) as StoredRoom[];
    const page = rows.filter((room) => visible(room, access, now, stages)).slice(0, 24);
    return { items: page.map(publicHeader), next: page.length === 24 ? page.at(-1)!.id : null };
  }
  const id = playId(input.roomId);
  if (action === playActions.create) {
    const stage = input.stage as PlayStage;
    const mode = input.mode as ActivityMode;
    check(stages.has(stage), "FEATURE_DISABLED", "该活动目前未开放");
    check(mode === "asynchronous" || mode === "realtime", "INVALID_REQUEST", "活动模式不正确");
    check(mode !== "realtime" || stages.has("shared_canvas"), "FEATURE_DISABLED", "实时合作目前未开放");
    const initialTurn = seat(input.initialTurn);
    const seed = cipher(input.seed, space.keyVersion, 24000);
    const existing: StoredRoom | null = await tx.get(collections.rooms, id);
    if (existing) {
      check(visible(existing, access, now, stages) && existing.createdBy === device.userId &&
        existing.seedDeviceId === device.id && JSON.stringify(existing.seed) === JSON.stringify(seed),
      "ALREADY_EXISTS", "活动标识已使用");
      return publicHeader(existing);
    }
    check(!await tx.get(collections.deleted, "room:" + id), "ROOM_UNAVAILABLE", "此活动已过期");
    check(tx.rooms(space.id, "", now, maxRooms).length < maxRooms, "ROOM_LIMIT", "房间数量达到上限");
    // Seat zero belongs to the creator. Seat ordering is authenticated by the seed envelope.
    const members: [string, string] = [device.userId, space.members.find((member) => member !== device.userId)!];
    const room: StoredRoom = {
      id, spaceId: space.id, memberIds: members, createdBy: device.userId, protocolVersion: PLAY_PROTOCOL,
      keyVersion: space.keyVersion, stage, mode, status: mode === "asynchronous" ? "active" : "waiting",
      ...(typeof input.supportsAsync === "boolean" ? { supportsAsync: input.supportsAsync } : {}),
      ready: [0], finish: [], turn: initialTurn, revision: 0, lastSeq: 0, createdAt: now, updatedAt: now,
      expiresAt: null,
      seedDeviceId: device.id, seed, bytes: seed.ciphertext.length,
    };
    await tx.put(collections.rooms, id, room);
    return publicHeader(room);
  }

  const room = await authorizedRoom(tx, id, access, now, stages);
  if (action === playActions.get) {
    const after = counter(input.after ?? 0);
    check(after <= room.lastSeq, "REPLAY_RESET", "房间已恢复到较早版本，请重新载入");
    const checkpoint: RoomCheckpoint | undefined = after < (room.snapshotThrough ?? 0) ?
      await tx.get(collections.checkpoints, id) : undefined;
    const page = tx.page(collections.operations, id, sequenceKey(checkpoint?.through ?? after), 25) as StoredOperation[];
    return { room: publicHeader(room), operations: page.slice(0, 24), more: page.length > 24, checkpoint } satisfies RoomPage;
  }
  const actor = roomSeat(room, access);
  if (action === playActions.getSnapshot) return tx.get(collections.proposals, id);
  if (action === playActions.putSnapshot || action === playActions.confirmSnapshot) {
    check(room.keyVersion === space.keyVersion, "KEY_VERSION_CHANGED", "此活动使用旧空间密钥，仅可回顾");
    const proposed: RoomCheckpoint | null = await tx.get(collections.proposals, id);
    const snapshotId = playId(input.snapshotId);
    if (action === playActions.putSnapshot) {
      if (proposed) return proposed;
      const through = counter(input.through);
      check(through >= (room.snapshotThrough ?? 0) + 200 && through <= room.lastSeq,
        "CHECKPOINT_NOT_DUE", "当前进度无需保存检查点");
      const candidate: RoomCheckpoint = { id: snapshotId, roomId: id, spaceId: space.id, deviceId: device.id,
        keyVersion: room.keyVersion, through, author: actor, confirmations: [actor],
        envelope: cipher(input.envelope, room.keyVersion, 1250000) };
      await tx.put(collections.proposals, id, candidate);
      return candidate;
    }
    if (!proposed) {
      const current: RoomCheckpoint | null = await tx.get(collections.checkpoints, id);
      check(current?.id === snapshotId, "CHECKPOINT_CHANGED", "检查点已更新，请等待下次同步");
      return current;
    }
    check(proposed.id === snapshotId, "CHECKPOINT_CHANGED", "检查点已更新，请等待下次同步");
    if (proposed.confirmations.includes(actor)) return proposed;
    const verified = { ...proposed, confirmations: [...proposed.confirmations, actor] };
    await tx.put(collections.checkpoints, id, verified);
    await tx.remove(collections.proposals, id);
    const removed = tx.trimOperations(id, verified.through);
    await tx.put(collections.rooms, id, { ...room, snapshotThrough: verified.through, bytes: room.bytes - removed });
    return verified;
  }
  if (action === playActions.submit) {
    const raw = object(input.header);
    const header: OpHeader = {
      spaceId: space.id, roomId: id, opId: playId(raw.opId), deviceId: device.id, actor, keyVersion: room.keyVersion,
      protocolVersion: PLAY_PROTOCOL, expectedRevision: counter(raw.expectedRevision),
      turn: seat(raw.turn), nextTurn: seat(raw.nextTurn),
    };
    check(raw.spaceId === space.id && raw.roomId === id && raw.deviceId === device.id &&
      raw.keyVersion === room.keyVersion && raw.protocolVersion === PLAY_PROTOCOL && raw.actor === actor,
    "INVALID_REQUEST", "操作与房间或设备不匹配");
    const envelope = cipher(input.envelope, room.keyVersion, 48000);
    const receiptId = id + ":" + header.opId;
    const digest = hash(JSON.stringify([header, envelope]));
    const previous: StoredReceipt | null = await tx.get(collections.receipts, receiptId);
    if (previous) {
      check(previous.deviceId === device.id && previous.digest === digest, "OPERATION_REUSED", "操作编号已用于另一条变更");
      return { sequence: previous.sequence, revision: previous.revision } satisfies OperationReceipt;
    }
    check(room.keyVersion === space.keyVersion, "KEY_VERSION_CHANGED", "此活动使用旧空间密钥，仅可回顾");
    check(room.status === "active", "ROOM_INACTIVE", "活动尚未开始、已暂停或已结束");
    check(header.expectedRevision === room.revision, "REVISION_CONFLICT", "进度已变化，请核对后重试");
    check(header.turn === null ? header.nextTurn === room.turn : (header.turn === room.turn && actor === room.turn),
      "TURN_REQUIRED", "请等待轮到自己后再提交");
    check(room.lastSeq - (room.snapshotThrough ?? 0) < maxOperations && room.lastSeq < 99999999 &&
      room.bytes + envelope.ciphertext.length <= maxRoomBytes,
      "ROOM_LIMIT", "房间已达到保存上限，请保存作品后新开一局");
    const sequence = room.lastSeq + 1;
    const revision = room.revision + 1;
    const operation: StoredOperation = { header, envelope, sequence };
    await tx.put(collections.operations, id + ":" + sequenceKey(sequence), { ...operation, spaceId: space.id });
    await tx.put(collections.receipts, receiptId, { sequence, revision, spaceId: space.id, deviceId: device.id, digest } satisfies StoredReceipt);
    await tx.put(collections.rooms, id, {
      ...room, lastSeq: sequence, revision, turn: header.nextTurn, updatedAt: now, finish: [], archive: undefined,
      expiresAt: renewable(room, now), bytes: room.bytes + envelope.ciphertext.length,
    });
    return { sequence, revision, operation };
  }
  check(room.keyVersion === space.keyVersion, "KEY_VERSION_CHANGED", "此活动使用旧空间密钥，仅可回顾");
  const next = { ...room };
  if (action === playActions.join) {
    if (room.ready.includes(actor) || room.status === "completed") return publicHeader(room);
    next.ready = [...room.ready, actor];
    if (next.ready.length === 2 && next.status === "waiting") next.status = "active";
  } else if (action === playActions.extend) {
    if (room.expiresAt === null) return publicHeader(room);
    next.expiresAt = renewable(room, now);
  } else if (action === playActions.approveArchive) {
    check(counter(input.expectedSequence) === room.lastSeq, "REVISION_CONFLICT", "请核对最新进度后再确认收藏");
    check(room.status === "active" || room.status === "paused", "ROOM_INACTIVE", "房间当前无法确认收藏");
    const approved = room.archive?.through === room.lastSeq ? room.archive.approved : [];
    if (approved.includes(actor)) return publicHeader(room);
    next.archive = { through: room.lastSeq, approved: [...approved, actor] };
  } else if (action === playActions.close) {
    check(counter(input.expectedSequence) === room.lastSeq,
      "REVISION_CONFLICT", "进度已变化，请核对后再确认结束");
    if (room.finish.includes(actor)) return publicHeader(room);
    check(room.status === "active" || room.status === "paused", "ROOM_INACTIVE", "当前无法结束活动");
    next.finish = [...room.finish, actor];
    if (next.finish.length === 2) {
      next.status = "completed";
      next.expiresAt = now + playRetention;
      delete next.cleanupVotes;
    }
  } else {
    const expected = counter(input.expectedRevision);
    check(expected === room.revision, "REVISION_CONFLICT", "进度已变化，请核对后重试");
    if (action === playActions.approveCleanup || action === playActions.keepRoom) {
      check(room.status !== "completed", "ROOM_INACTIVE", "已结束房间可以延长保留时间");
      const votes = room.cleanupVotes ?? [];
      if (action === playActions.keepRoom) {
        if (!votes.length) return publicHeader(room);
        delete next.cleanupVotes;
        next.expiresAt = null;
      } else {
        if (votes.includes(actor)) return publicHeader(room);
        next.cleanupVotes = [...votes, actor];
        if (next.cleanupVotes.length === 2) next.expiresAt = now + playRetention;
      }
    } else if (action === playActions.pause) {
      check(room.status === "active", "ROOM_INACTIVE", "只有进行中的活动可以暂停");
      next.status = "paused";
      next.pausedAt = now;
      next.finish = [];
    } else if (action === playActions.resume) {
      check(room.status === "paused", "ROOM_INACTIVE", "只有暂停的活动可以继续");
      next.status = "active";
      next.pausedDuration = (room.pausedDuration ?? 0) + (room.pausedAt ? now - room.pausedAt : 0);
      delete next.pausedAt;
    } else if (action === playActions.useAsync) {
      check(room.mode === "realtime" && room.supportsAsync && room.status !== "completed",
        "ROOM_INACTIVE", "这个房间无法切换为错峰模式");
      next.seedMode = room.seedMode ?? room.mode;
      next.mode = "asynchronous";
      if (next.status === "waiting") next.status = "active";
    } else {
      check(false, "UNKNOWN_ACTION", "暂不支持此活动操作");
    }
  }
  next.updatedAt = now;
  next.revision++;
  await tx.put(collections.rooms, id, next);
  return publicHeader(next);
}
