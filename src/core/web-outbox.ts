import type { CipherRecord, Envelope, Secrets } from "./types";
import { hashText } from "./crypto";

export const recordOutboxScope = (secrets: Secrets) => hashText(JSON.stringify([secrets.userId, secrets.spaceId]));

export type OutboxState = "queued" | "retry" | "conflict" | "blocked" | "expired";
export type OutboxItem = {
  scope: string;
  operationId: string;
  queuedAt: number;
  record: CipherRecord;
  expectedRevision: number;
  photoRefs?: string[];
  attachments?: { fileId: string; envelope: Envelope }[];
  state: OutboxState;
};

export interface RecordOutbox {
  read(scope: string): Promise<OutboxItem[]>;
  add(item: OutboxItem): Promise<void>;
  set(item: OutboxItem): Promise<void>;
  remove(scope: string, operationId: string): Promise<void>;
  exclusive<T>(scope: string, work: () => Promise<T>): Promise<T | undefined>;
}
