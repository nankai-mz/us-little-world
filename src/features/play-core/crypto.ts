import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { open, seal, unb64 } from "../../core/crypto";
import { AppError, type Envelope, type RandomSource, type Secrets } from "../../core/types";
import type { OpHeader, RoomCheckpoint, RoomHeader, WorkHeader } from "./protocol";
import type { CanvasRelay } from "./realtime";

type Context = {
  spaceId: string;
  resourceId: string;
  opId: string;
  deviceId: string;
  keyVersion: number;
  kind: "seed" | "operation" | "shared-work" | "private-work" | "author-draft" | "device-draft" | "preview" | "checkpoint";
  binding?: unknown[];
};

export function deriveActivityKey(master: Uint8Array, resourceId: string) {
  // Both the salt and info are UTF-8 bytes. The salt uses the ID's lowercase hex text.
  return hkdf(sha256, master, utf8ToBytes(resourceId), utf8ToBytes("Us/play/v1"), 32);
}

function activityKey(secrets: Secrets, fields: Context) {
  const encoded = fields.kind === "device-draft" ? (secrets.deviceId === fields.deviceId ? secrets.signingSecret : undefined)
    : fields.kind === "private-work" || fields.kind === "author-draft" ? (secrets.sharedOnly ? undefined : secrets.personalKey)
      : secrets.spaceKeys[fields.keyVersion];
  if (secrets.spaceId !== fields.spaceId || !encoded)
    throw new AppError("KEY_NOT_FOUND", "此设备缺少活动所用的密钥");
  const master = unb64(encoded);
  try { return deriveActivityKey(master, fields.resourceId); }
  finally { master.fill(0); }
}

export function draftContext(room: Pick<RoomHeader, "id" | "spaceId" | "keyVersion">, author: string,
  deviceId: string, field: string, deviceOnly: boolean): Context {
  return { kind: deviceOnly ? "device-draft" : "author-draft", spaceId: room.spaceId, resourceId: room.id,
    keyVersion: room.keyVersion, deviceId, opId: field, binding: [author] };
}

function associatedData(fields: Context) {
  return JSON.stringify(["Us/play/v1", fields.kind, fields.spaceId, fields.resourceId,
    fields.opId, fields.deviceId, fields.keyVersion, ...(fields.binding ?? [])]);
}

export function seedContext(room: Pick<RoomHeader, "spaceId" | "id" | "seedDeviceId" | "keyVersion" | "stage" | "mode" | "createdBy" |
  "seedMode" | "supportsAsync">): Context {
  return { kind: "seed", spaceId: room.spaceId, resourceId: room.id, opId: room.id,
    deviceId: room.seedDeviceId, keyVersion: room.keyVersion, binding: [room.stage, room.seedMode ?? room.mode, room.createdBy,
      ...(room.supportsAsync === undefined ? [] : [room.supportsAsync])] };
}

export function opContext(header: OpHeader): Context {
  return { kind: "operation", spaceId: header.spaceId, resourceId: header.roomId, opId: header.opId,
    deviceId: header.deviceId, keyVersion: header.keyVersion,
    binding: [header.protocolVersion, header.actor, header.expectedRevision, header.turn, header.nextTurn] };
}

export function previewContext(fields: Omit<CanvasRelay, "envelope">): Context {
  return { kind: "preview", spaceId: fields.spaceId, resourceId: fields.roomId, deviceId: fields.deviceId,
    opId: fields.id, keyVersion: fields.keyVersion, binding: [fields.actor] };
}

export function checkpointContext(fields: Omit<RoomCheckpoint, "envelope" | "confirmations">): Context {
  return { kind: "checkpoint", spaceId: fields.spaceId, resourceId: fields.roomId, deviceId: fields.deviceId,
    opId: fields.id, keyVersion: fields.keyVersion, binding: [fields.author, fields.through] };
}

export function workContext(work: Pick<WorkHeader, "spaceId" | "id" | "opId" | "deviceId" | "visibility" | "authorId" | "revision">,
  keyVersion: number): Context {
  return { kind: work.visibility === "private" ? "private-work" : "shared-work", spaceId: work.spaceId,
    resourceId: work.id, opId: work.opId, deviceId: work.deviceId, keyVersion, binding: [work.authorId, work.revision] };
}

export async function encryptPlay(value: unknown, secrets: Secrets, fields: Context, rng: RandomSource) {
  const key = activityKey(secrets, fields);
  try { return await seal(value, key, associatedData(fields), rng, fields.keyVersion); }
  finally { key.fill(0); }
}

export function decryptPlay<T>(envelope: Envelope, secrets: Secrets, fields: Context): T {
  if (envelope.keyVersion !== fields.keyVersion) throw new AppError("DECRYPT_FAILED", "活动密钥版本不匹配");
  const key = activityKey(secrets, fields);
  try { return open<T>(envelope, key, associatedData(fields)); }
  finally { key.fill(0); }
}
