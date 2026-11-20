import type { Tx } from "./api";
import type { CipherRecord, Device } from "../core/types";
import { AppError } from "../core/types";
import type { SyncPage } from "../core/web-sync";

export const recordStreams = "web_record_streams";
export const recordChanges = "web_record_changes";
const cursorTtl = 7 * 86400000;
const pageSize = 50;

type CursorState = {
  spaceId: string;
  userId: string;
  deviceId: string;
  sharedOnly: boolean;
  expires: number;
  shared: number;
  personal: number;
  after: string | null;
};
type CursorCodec = {
  encode(state: CursorState): string;
  decode(value: string): CursorState | null;
};
export type SyncReader = Tx & {
  visibleRecords(spaceId: string, privateOwner: string | null, after: string, offset: number): Promise<CipherRecord[]>;
  changes(streamId: string, after: number, limit: number): Promise<{ seq: number; recordId: string }[]>;
};
export type WebSync = CursorCodec & {
  read<T>(query: (tx: SyncReader) => Promise<T>): Promise<T>;
};

const streamId = (spaceId: string, owner?: string) => JSON.stringify([spaceId, owner ?? null]);
async function head(tx: Tx, stream: string): Promise<number> {
  return (await tx.get(recordStreams, stream))?.seq ?? 0;
}

export async function markRecordChange(
  tx: Tx, spaceId: string, actor: string,
  changed: { id: string; visibility: CipherRecord["visibility"] },
) {
  const stream = streamId(spaceId, changed.visibility === "private" ? actor : undefined);
  const seq = (await head(tx, stream)) + 1;
  await tx.put(recordStreams, stream, { id: stream, spaceId, seq });
  // Keep one change marker per record. The current ciphertext remains in encrypted_records.
  await tx.put(recordChanges, changed.id, { id: changed.id, recordId: changed.id, spaceId, stream, seq });
}

export async function syncRecords(
  tx: SyncReader, codec: CursorCodec, device: Device, token: unknown, now: number,
): Promise<SyncPage> {
  const identity = { spaceId: device.spaceId, userId: device.userId, deviceId: device.id, sharedOnly: !!device.sharedOnly };
  const sharedStream = streamId(device.spaceId);
  const personalStream = streamId(device.spaceId, device.userId);
  const expires = now + cursorTtl;
  let cursor: CursorState;
  if (token === undefined) {
    cursor = {
      ...identity, expires, after: "", shared: await head(tx, sharedStream),
      personal: identity.sharedOnly ? 0 : await head(tx, personalStream),
    };
  } else {
    const parsed = typeof token === "string" && token.length <= 2048 ? codec.decode(token) : null;
    if (!parsed || parsed.expires <= now || parsed.spaceId !== identity.spaceId || parsed.userId !== identity.userId ||
      parsed.deviceId !== identity.deviceId || parsed.sharedOnly !== identity.sharedOnly)
      throw new AppError("SYNC_RESET", "同步游标已失效，请重新同步");
    cursor = parsed;
  }
  const records: CipherRecord[] = [];
  const removed: string[] = [];
  if (cursor.after !== null) {
    const snapshot = await tx.visibleRecords(identity.spaceId, identity.sharedOnly ? null : identity.userId, cursor.after, 0);
    records.push(...snapshot.slice(0, 100));
    cursor.after = snapshot.length > 100 ? records.at(-1)!.id : null;
    return { records, removed, cursor: codec.encode(cursor), more: true };
  }
  const shared = await tx.changes(sharedStream, cursor.shared, pageSize + 1);
  const personal = identity.sharedOnly ? [] : await tx.changes(personalStream, cursor.personal, pageSize + 1);
  const more = shared.length > pageSize || personal.length > pageSize;
  for (const [scope, changes] of [["shared", shared], ["personal", personal]] as const) {
    for (const { seq, recordId } of changes.slice(0, pageSize)) {
      const record: CipherRecord | null = await tx.get("encrypted_records", recordId);
      if (!record) removed.push(recordId);
      else if (record.spaceId === device.spaceId && (
        scope === "shared" ? record.visibility === "shared"
          : record.visibility === "private" && record.creatorId === device.userId
      )) records.push(record);
      cursor[scope] = seq;
    }
  }
  if (!more) cursor.expires = expires;
  return { records, removed, cursor: codec.encode(cursor), more };
}
