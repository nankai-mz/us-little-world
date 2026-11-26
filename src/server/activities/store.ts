import type { Tx } from "../api";
import type { RoomHeader, WorkHeader } from "../../features/play-core/protocol";
import type { CipherRecord } from "../../core/types";

export const collections = {
  rooms: "play_rooms",
  operations: "play_ops",
  receipts: "play_receipts",
  works: "play_works",
  versions: "play_work_versions",
  deleted: "play_deleted",
  checkpoints: "play_checkpoints",
  proposals: "play_checkpoint_proposals",
  workMedia: "play_work_media",
} as const;

export interface PlayTransaction extends Tx {
  rooms(space: string, after: string, at: number, limit: number): RoomHeader[];
  works(space: string, after: string, owner: string | null, limit: number): WorkHeader[];
  page(collection: string, resource: string, after: string, limit: number): unknown[];
  clear(collection: string, resource: string): void;
  clearWorkMedia(workId: string): void;
  trimOperations(resource: string, through: number): number;
  expired(at: number, limit: number): RoomHeader[];
  mediaGarbage(limit: number): CipherRecord[];
}

export interface PlayRepository {
  read<T>(query: (tx: PlayTransaction) => Promise<T>): Promise<T>;
  write<T>(query: (tx: PlayTransaction) => Promise<T>): Promise<T>;
}

export const sequenceKey = (sequence: number) => sequence.toString().padStart(8, "0");
