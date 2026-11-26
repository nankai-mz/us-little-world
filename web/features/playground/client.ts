import { hashText, randomId } from "../../../src/core/crypto";
import type { UsService } from "../../../src/core/service";
import { AppError, type Envelope } from "../../../src/core/types";
import type { HiddenAnswer, RevealAnswer } from "../../../src/features/play-core/async-games";
import { applyGame, canRebase, gameGate, rebaseKey, startGame, type GameCommand, type PlayGame } from "../../../src/features/play-core/game";
import { activities, isActivityId, type ActivityId } from "../../../src/features/play-core/catalog";
import { checkpointContext, decryptPlay, draftContext, encryptPlay, opContext, previewContext, seedContext, workContext } from "../../../src/features/play-core/crypto";
import { validPreview, type StrokePreview } from "../../../src/features/canvas-core/canvas";
import type { CanvasRelay } from "../../../src/features/play-core/realtime";
import {
  PLAY_PROTOCOL, playActions, type ActivityMode, type OperationReceipt, type PlayOperation,
  type PlayStage, type RoomCheckpoint, type RoomHeader, type RoomPage, type Seat, type WorkHeader,
} from "../../../src/features/play-core/protocol";
import { withWorkCover, type WorkContent } from "../../../src/features/play-core/works";
import { connectRoomSocket } from "./socket";

type RoomSeed = { activityId: ActivityId; title: string; choice?: string };
export type RoomView = { room: RoomHeader; seed: RoomSeed; game: PlayGame; through: number };
export type OpenWork = { header: WorkHeader; data: WorkContent };
type Page<T> = { items: T[]; next: string | null };
type DraftValue = { text: string; title?: string };
type CommandBody = { command: GameCommand; basis: string | null };

export function isRetryablePlayError(error: unknown) {
  return error instanceof AppError && ["NETWORK_ERROR", "TIMEOUT", "INTERNAL_ERROR", "RATE_LIMITED"].includes(error.code);
}

export class PlayClient {
  constructor(private readonly service: UsService) {}

  private unlocked() {
    const { secrets, space } = this.service;
    if (!secrets || !space || space.id !== secrets.spaceId || !this.service.ready)
      throw new AppError("LOCKED", "请先解锁共同空间");
    return { secrets, space };
  }

  async call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    const { secrets } = this.unlocked();
    const result = await this.service.transport.call<T>(action, { ...input, spaceId: secrets.spaceId, deviceId: secrets.deviceId });
    if (this.service.secrets !== secrets) throw new AppError("LOCKED", "当前设备已锁定");
    return result;
  }

  config() { return this.call<{ stages: PlayStage[] }>(playActions.config); }

  socket(id: string, callbacks: Parameters<typeof connectRoomSocket>[3]) {
    const { secrets } = this.unlocked();
    return connectRoomSocket(id, secrets, () => this.service.secrets === secrets, callbacks);
  }

  async preview(room: RoomHeader, data: StrokePreview | null): Promise<CanvasRelay> {
    const { secrets } = this.unlocked();
    const fields = { id: await randomId(this.service.rng), roomId: room.id, spaceId: room.spaceId,
      keyVersion: room.keyVersion, actor: this.seat(room), deviceId: secrets.deviceId };
    return { ...fields, envelope: await encryptPlay(data, secrets, previewContext(fields), this.service.rng) };
  }

  openPreview(room: RoomHeader, preview: CanvasRelay) {
    if (preview.roomId !== room.id || preview.spaceId !== room.spaceId || preview.keyVersion !== room.keyVersion ||
      preview.actor === this.seat(room)) return null;
    const value = decryptPlay<StrokePreview | null>(preview.envelope, this.unlocked().secrets, previewContext(preview));
    return validPreview(value) ? value : null;
  }

  seat(room: RoomHeader): Seat {
    const userId = this.unlocked().secrets.userId;
    if (room.memberIds[0] === userId) return 0;
    if (room.memberIds[1] === userId) return 1;
    throw new AppError("ROOM_UNAVAILABLE", "此活动不属于当前空间");
  }

  canWrite(room: RoomHeader) { return this.unlocked().space.keyVersion === room.keyVersion; }

  seed(room: RoomHeader) {
    const { secrets } = this.unlocked();
    const value = decryptPlay<RoomSeed>(room.seed, secrets, seedContext(room));
    if (!isActivityId(value?.activityId) || typeof value.title !== "string" || activities[value.activityId].stage !== room.stage)
      throw new AppError("UNSUPPORTED_ACTIVITY", "请使用新版 Us 打开此活动");
    return value;
  }

  async create(activityId: ActivityId, title: string, mode: ActivityMode, choice?: string) {
    const { secrets, space } = this.unlocked();
    const id = await randomId(this.service.rng);
    startGame(activityId, choice, id);
    const stage = activities[activityId].stage;
    const supportsAsync = (activities[activityId].modes as readonly ActivityMode[]).includes("asynchronous");
    const fields = { id, spaceId: space.id, seedDeviceId: secrets.deviceId, createdBy: secrets.userId,
      keyVersion: space.keyVersion, stage, mode, supportsAsync };
    const seed = await encryptPlay({ activityId, title: title.trim() || activities[activityId].title, choice },
      secrets, seedContext(fields), this.service.rng);
    if (this.service.secrets !== secrets) throw new AppError("LOCKED", "当前设备已锁定");
    const input = { roomId: id, mode, stage, supportsAsync, initialTurn: activityId === "g05" ? 0 : null, seed };
    try { return await this.call<RoomHeader>(playActions.create, input); }
    catch (error) {
      if (!isRetryablePlayError(error) || !navigator.onLine) throw error;
      return this.call<RoomHeader>(playActions.create, input);
    }
  }

  async roomList() {
    const rooms: { room: RoomHeader; seed: RoomSeed | null }[] = [];
    let after: string | undefined;
    do {
      const page = await this.call<Page<RoomHeader>>(playActions.list, { after });
      for (const room of page.items) {
        try { rooms.push({ room, seed: this.seed(room) }); }
        catch { rooms.push({ room, seed: null }); }
      }
      after = page.next ?? undefined;
    } while (after);
    return rooms.sort((a, b) => b.room.updatedAt - a.room.updatedAt);
  }

  async readRoom(id: string, previous?: RoomView, stopAt?: number): Promise<RoomView> {
    let through = previous?.through ?? 0;
    let room: RoomHeader;
    let seed = previous?.seed;
    let game = previous?.game;
    const { secrets } = this.unlocked();
    let more: boolean;
    do {
      let page: RoomPage;
      try {
        page = await this.call<RoomPage>(playActions.get, { roomId: id, after: through });
      } catch (error) {
        if (previous && error instanceof AppError && error.code === "REPLAY_RESET") return this.readRoom(id, undefined, stopAt);
        throw error;
      }
      room = page.room;
      seed ??= this.seed(room);
      if (page.checkpoint) {
        const checkpoint = page.checkpoint;
        if (checkpoint.confirmations.length !== 2 || checkpoint.through !== room.snapshotThrough ||
          checkpoint.roomId !== room.id || checkpoint.spaceId !== room.spaceId || checkpoint.keyVersion !== room.keyVersion ||
          (stopAt !== undefined && checkpoint.through > stopAt))
          throw new AppError("INVALID_RESPONSE", "检查点与房间不一致");
        game = decryptPlay<PlayGame>(checkpoint.envelope, secrets, checkpointContext(checkpoint));
        if (game?.id !== seed.activityId) throw new AppError("INVALID_RESPONSE", "检查点活动类型不一致");
        through = checkpoint.through;
      }
      game ??= startGame(seed.activityId, seed.choice, id);
      for (const operation of page.operations) {
        if (stopAt !== undefined && through === stopAt) break;
        const { header, envelope, sequence } = operation;
        if (header.spaceId !== room.spaceId || header.roomId !== room.id || sequence !== through + 1)
          throw new AppError("INVALID_RESPONSE", "活动记录不连续，请重新载入");
        const { command, basis } = decryptPlay<CommandBody>(envelope, secrets, opContext(header));
        if (basis !== rebaseKey(game, command)) throw new AppError("INVALID_RESPONSE", "活动操作引用了另一回合");
        const next = applyGame(game, command, header.actor);
        const gate = gameGate(game, next, command);
        if (gate.turn !== header.turn || gate.nextTurn !== header.nextTurn)
          throw new AppError("INVALID_RESPONSE", "活动回合与记录不一致");
        game = next;
        through = sequence;
      }
      more = page.more && (stopAt === undefined || through < stopAt);
    } while (more);
    if ((stopAt ?? room.lastSeq) !== through) throw new AppError("INVALID_RESPONSE", "活动记录缺失，请重新载入");
    return { room, seed, game, through };
  }

  async checkpoint(view: RoomView) {
    const { room } = view;
    const roomId = room.id;
    if (view.through - (room.snapshotThrough ?? 0) < 200 || !this.canWrite(room)) return;
    const { secrets } = this.unlocked();
    const own = this.seat(room);
    let candidate = await this.call<RoomCheckpoint | null>(playActions.getSnapshot, { roomId });
    if (!candidate) {
      const fields = { id: await randomId(this.service.rng), roomId, spaceId: room.spaceId,
        deviceId: secrets.deviceId, keyVersion: room.keyVersion, through: view.through, author: own };
      const envelope = await encryptPlay(view.game, secrets, checkpointContext(fields), this.service.rng);
      if (envelope.ciphertext.length > 1250000 || this.service.secrets !== secrets) return;
      candidate = await this.call<RoomCheckpoint>(playActions.putSnapshot, {
        roomId, snapshotId: fields.id, through: fields.through, envelope,
      });
    }
    if (candidate?.author === own || !candidate) return;
    const local = candidate.through === view.through ? view : await this.readRoom(roomId, undefined, candidate.through);
    const state = decryptPlay<PlayGame>(candidate.envelope, secrets, checkpointContext(candidate));
    if (candidate.roomId !== roomId || candidate.spaceId !== room.spaceId || candidate.keyVersion !== room.keyVersion ||
      JSON.stringify(state) !== JSON.stringify(local.game))
      throw new AppError("CHECKPOINT_MISMATCH", "双方的检查点有差异，操作记录仍保留");
    await this.call(playActions.confirmSnapshot, { roomId, snapshotId: candidate.id });
  }

  async prepare(view: RoomView, command: GameCommand, reuseId?: string) {
    const { secrets } = this.unlocked();
    const { room, game } = view;
    const actor = this.seat(room);
    const next = applyGame(game, command, actor);
    const gate = gameGate(game, next, command);
    const header: PlayOperation["header"] = {
      spaceId: room.spaceId, roomId: room.id, opId: reuseId ?? await randomId(this.service.rng),
      deviceId: secrets.deviceId, actor, keyVersion: room.keyVersion, protocolVersion: PLAY_PROTOCOL,
      expectedRevision: room.revision, ...gate,
    };
    return { header, envelope: await encryptPlay({ command, basis: rebaseKey(game, command) } satisfies CommandBody,
      secrets, opContext(header), this.service.rng) } satisfies PlayOperation;
  }

  rebase(view: RoomView, operation: PlayOperation) {
    const { command, basis } = decryptPlay<CommandBody>(operation.envelope, this.unlocked().secrets, opContext(operation.header));
    if (basis !== rebaseKey(view.game, command) || !canRebase(view.game, command))
      throw new AppError("REVISION_CONFLICT", "房间已更新，请核对进度后重新操作。");
    return this.prepare(view, command, operation.header.opId);
  }

  send(operation: PlayOperation) {
    return this.call<OperationReceipt>(playActions.submit, { ...operation, roomId: operation.header.roomId });
  }

  async sealAnswer(room: RoomHeader, round: number, answer: RevealAnswer): Promise<HiddenAnswer> {
    const { secrets } = this.unlocked();
    const deviceOnly = !!secrets.sharedOnly;
    const context = draftContext(room, secrets.userId, secrets.deviceId, "answer/" + round, deviceOnly);
    const envelope = await encryptPlay({ ...answer, text: answer.text.trim() }, secrets, context, this.service.rng);
    return { envelope, deviceOnly, deviceId: secrets.deviceId };
  }

  openAnswer(room: RoomHeader, round: number, hidden: HiddenAnswer): RevealAnswer {
    const { secrets } = this.unlocked();
    return decryptPlay(hidden.envelope, secrets, draftContext(room, secrets.userId, hidden.deviceId, "answer/" + round, hidden.deviceOnly));
  }

  private storageKey(room: string, field: string) {
    const { secrets } = this.unlocked();
    return `us.play.v1.${secrets.deviceId}.${room}.${field}`;
  }

  pending(room: string) {
    const value = localStorage.getItem(this.storageKey(room, "pending"));
    return value ? JSON.parse(value) as PlayOperation : null;
  }

  storePending(room: string, operation: PlayOperation | null) {
    const key = this.storageKey(room, "pending");
    if (operation) localStorage.setItem(key, JSON.stringify(operation));
    else localStorage.removeItem(key);
  }

  loadDraft<T = DraftValue>(room: RoomHeader, field: string): T | null {
    try {
      const { secrets } = this.unlocked();
      const draft = localStorage.getItem(this.storageKey(room.id, field));
      if (!draft) return null;
      const envelope: Envelope = JSON.parse(draft);
      return decryptPlay(envelope, secrets, draftContext(room, secrets.userId, secrets.deviceId, field, true));
    } catch { return null; }
  }

  async saveDraft<T>(room: RoomHeader, field: string, value: T | null, current: () => boolean) {
    const { secrets } = this.unlocked();
    const key = this.storageKey(room.id, field);
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    const envelope = await encryptPlay(value, secrets, draftContext(room, secrets.userId, secrets.deviceId, field, true), this.service.rng);
    if (this.service.secrets === secrets && current()) localStorage.setItem(key, JSON.stringify(envelope));
  }

  openWork(header: WorkHeader): OpenWork {
    const { secrets } = this.unlocked();
    const data = decryptPlay<WorkContent>(header.envelope, secrets, workContext(header, header.envelope.keyVersion));
    if (data?.version !== 1 || !isActivityId(data.activityId))
      throw new AppError("UNSUPPORTED_ACTIVITY", "请使用新版 Us 打开此作品");
    return { header, data };
  }

  async workList(after?: string) {
    const page = await this.call<Page<WorkHeader>>(playActions.listWorks, { after });
    return { ...page, items: page.items.map((header) => {
      try { return this.openWork(header); }
      catch { return { header, data: null }; }
    }) };
  }

  async work(id: string, revision?: number) {
    return this.openWork(await this.call<WorkHeader>(playActions.getWork, { workId: id, revision }));
  }

  workIdFor(roomId: string, visibility: WorkHeader["visibility"]) {
    const user = visibility === "shared" ? "" : this.unlocked().secrets.userId;
    return hashText(JSON.stringify(["Us/play/result/1", roomId, visibility, user])).slice(0, 32);
  }

  async saveWork(data: WorkContent, visibility: WorkHeader["visibility"], existing?: WorkHeader, source?: { workId?: string; sequence?: number }) {
    const { secrets, space } = this.unlocked();
    const id = existing?.id ?? (source?.workId ? await randomId(this.service.rng) : this.workIdFor(data.roomId, visibility));
    const fields = { id, spaceId: space.id, visibility, authorId: existing?.authorId ?? secrets.userId,
      deviceId: secrets.deviceId, opId: await randomId(this.service.rng), revision: (existing?.revision ?? 0) + 1 };
    const envelope = await encryptPlay(withWorkCover(data), secrets, workContext(fields, space.keyVersion), this.service.rng);
    if (this.service.secrets !== secrets) throw new AppError("LOCKED", "当前设备已锁定");
    const input = { workId: id, visibility, opId: fields.opId, expectedRevision: fields.revision - 1,
      references: data.references, sourceRoomId: data.roomId, sourceWorkId: source?.workId, sourceSequence: source?.sequence, envelope };
    try { return await this.call<WorkHeader>(playActions.saveWork, input); }
    catch (error) {
      if (!isRetryablePlayError(error) || !navigator.onLine) throw error;
      return this.call<WorkHeader>(playActions.saveWork, input);
    }
  }

  async deleteWork(header: WorkHeader) {
    const opId = await randomId(this.service.rng);
    return this.call(playActions.deleteWork, { workId: header.id, expectedRevision: header.revision, opId });
  }
}
