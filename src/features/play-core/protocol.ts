import type { Envelope } from "../../core/types";

export const PLAY_PROTOCOL = 1;
export const playIdPattern = /^[a-f0-9]{32}$/;
export const memoryIdPattern = /^[a-f0-9]{32,64}$/;
export const playRetention = 30 * 86400000;

export type Seat = 0 | 1;
export type PlayStage = "async_games" | "shared_canvas" | "realtime_games" | "creative_worlds";
export type ActivityMode = "asynchronous" | "realtime";
export type RoomStatus = "waiting" | "active" | "paused" | "completed";

export interface RoomHeader {
  id: string;
  spaceId: string;
  memberIds: [string, string];
  createdBy: string;
  protocolVersion: 1;
  keyVersion: number;
  stage: PlayStage;
  mode: ActivityMode;
  seedMode?: ActivityMode;
  supportsAsync?: boolean;
  status: RoomStatus;
  ready: Seat[];
  finish: Seat[];
  archive?: { through: number; approved: Seat[] };
  turn: Seat | null;
  revision: number;
  lastSeq: number;
  snapshotThrough?: number;
  createdAt: number;
  updatedAt: number;
  pausedAt?: number;
  pausedDuration?: number;
  cleanupVotes?: Seat[];
  expiresAt: number | null;
  seedDeviceId: string;
  seed: Envelope;
}

export interface OpHeader {
  spaceId: string;
  roomId: string;
  opId: string;
  deviceId: string;
  actor: Seat;
  keyVersion: number;
  protocolVersion: 1;
  expectedRevision: number;
  turn: Seat | null;
  nextTurn: Seat | null;
}

export interface PlayOperation {
  header: OpHeader;
  envelope: Envelope;
}

export interface StoredOperation extends PlayOperation {
  sequence: number;
}

export interface RoomPage {
  room: RoomHeader;
  operations: StoredOperation[];
  more: boolean;
  checkpoint?: RoomCheckpoint;
}

export interface RoomCheckpoint {
  id: string;
  roomId: string;
  spaceId: string;
  deviceId: string;
  keyVersion: number;
  through: number;
  author: Seat;
  confirmations: Seat[];
  envelope: Envelope;
}

export interface OperationReceipt {
  sequence: number;
  revision: number;
}

export interface WorkHeader {
  id: string;
  spaceId: string;
  authorId: string;
  visibility: "shared" | "private";
  revision: number;
  createdAt: number;
  updatedAt: number;
  deviceId: string;
  opId: string;
  envelope: Envelope;
}

export const playActions = {
  config: "play.config",
  create: "play.createRoom",
  list: "play.listRooms",
  get: "play.getRoom",
  join: "play.joinRoom",
  pause: "play.pauseRoom",
  resume: "play.resumeRoom",
  extend: "play.extendRoom",
  approveCleanup: "play.approveRoomCleanup",
  keepRoom: "play.keepRoom",
  close: "play.closeRoom",
  approveArchive: "play.approveArchive",
  useAsync: "play.useAsync",
  submit: "play.submitTurn",
  getSnapshot: "play.getSnapshot",
  putSnapshot: "play.putSnapshot",
  confirmSnapshot: "play.confirmSnapshot",
  listWorks: "works.list",
  getWork: "works.get",
  saveWork: "works.save",
  deleteWork: "works.delete",
} as const;

export const otherSeat = (seat: Seat): Seat => seat === 0 ? 1 : 0;

export function roomClock(room: Pick<RoomHeader, "pausedAt" | "pausedDuration">, now = Date.now()) {
  return (room.pausedAt ?? now) - (room.pausedDuration ?? 0);
}
