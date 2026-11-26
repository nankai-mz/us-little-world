import { AppError, type ApiReply } from "../../core/types";
import { playActions, type PlayStage, type Seat } from "../../features/play-core/protocol";
import { verifyPlaySocket } from "../../features/play-core/realtime";
import { works } from "../works/works";
import { authorizedRoom, playAccess, removeRoom, rooms, type PlayActor } from "./rooms";
import { collections, type PlayRepository } from "./store";
import { check } from "./validation";
import { RECORD_TOMBSTONES } from "../lifecycle";
import { markRecordChange } from "../web-sync";

const stages: PlayStage[] = ["async_games", "shared_canvas", "realtime_games", "creative_worlds"];
const supported = new Set<string>(Object.values(playActions));
const reading = new Set<string>([playActions.config, playActions.list, playActions.get, playActions.listWorks,
  playActions.getWork, playActions.getSnapshot]);

export function createPlayApi(repository: PlayRepository, flags: string, now: () => number,
  hash: (text: string) => string, log: (error: unknown) => void) {
  const configured = new Set(flags.split(",").map((value) => value.trim()));
  const enabled = configured.has("playground");
  const active = new Set(stages.filter((stage) => enabled && configured.has(stage)));
  const rates = new Map<string, { count: number; until: number }>();
  return {
    realtime: active.has("shared_canvas"),
    async authorizeSocket(actor: PlayActor, roomId: string, sessionValid: () => boolean,
      proof?: { nonce: string; signature: unknown }, keyVersion?: number): Promise<Seat> {
      return repository.read(async (tx) => {
        check(sessionValid(), "AUTH_REQUIRED", "当前网站会话已失效");
        const access = await playAccess(tx, actor);
        const room = await authorizedRoom(tx, roomId, access, now(), active);
        check(room.mode === "realtime" && room.keyVersion === access.space.keyVersion,
          "ROOM_UNAVAILABLE", "此房间当前无法实时连接");
        if (keyVersion !== undefined) check(room.keyVersion === keyVersion && room.status === "active",
          "ROOM_INACTIVE", "当前房间不接受实时预览");
        if (proof) {
          check(verifyPlaySocket({ roomId, spaceId: actor.spaceId, deviceId: actor.deviceId, nonce: proof.nonce },
            proof.signature, access.device.signingPublicKey), "DEVICE_PROOF_INVALID", "实时房间设备签名未通过");
        }
        return room.memberIds[0] === actor.accountId ? 0 : 1;
      });
    },
    async call(actor: PlayActor, action: string, input: Record<string, unknown>, sessionValid: () => boolean): Promise<ApiReply> {
      try {
        check(enabled && supported.has(action), "FEATURE_DISABLED", "双人游乐园目前未开放");
        const read = reading.has(action);
        const at = now();
        const key = actor.accountId + (read ? "/read" : "/write");
        const previous = rates.get(key);
        const window = previous && previous.until > at ? previous : { count: 0, until: at + 10000 };
        check(++window.count <= (read ? 480 : 240), "RATE_LIMITED", "同步请求过多，请稍后重试");
        rates.set(key, window);
        const transact = read ? repository.read : repository.write;
        const data = await transact(async (tx) => {
          check(sessionValid(), "AUTH_REQUIRED", "当前网站会话已失效");
          const access = await playAccess(tx, actor);
          if (action === playActions.config) return { stages: [...active] };
          return action.startsWith("works.") ? works(tx, access, action, input, now())
            : rooms(tx, access, action, input, now(), active, hash);
        });
        return { success: true, data };
      } catch (error) {
        if (error instanceof AppError) return { success: false, error: { code: error.code, message: error.message } };
        log(error);
        return { success: false, error: { code: "INTERNAL_ERROR", message: "暂时无法同步活动" } };
      }
    },
    async prune() {
      if (!await repository.read(async (tx) => tx.expired(now(), 1).length || tx.mediaGarbage(1).length)) return;
      await repository.write(async (tx) => {
        for (const room of tx.expired(now(), 24)) {
          await removeRoom(tx, room.id);
          await tx.put(collections.deleted, "room:" + room.id, { spaceId: room.spaceId });
        }
        for (const record of tx.mediaGarbage(16)) {
          for (const fileId of record.photoRefs ?? []) {
            const file = await tx.get("encrypted_files", fileId);
            if (file?.recordId !== record.id || file.spaceId !== record.spaceId) continue;
            await tx.deletePhoto?.(file.storageId);
            await tx.remove("encrypted_files", fileId);
          }
          tx.clear(collections.workMedia, record.id);
          await tx.remove("encrypted_records", record.id);
          await tx.put(RECORD_TOMBSTONES, record.id, { id: record.id, spaceId: record.spaceId, purgedAt: now() });
          await markRecordChange(tx, record.spaceId, record.creatorId, record);
        }
      });
    },
  };
}
