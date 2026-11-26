import type { MealPlan } from "./meal-plan";
import type { WardrobeSelection, WardrobeSuggestion } from "./wardrobe";

export type Visibility = "shared" | "private";
export type Kind =
  | "memory"
  | "capsule"
  | "place"
  | "wish"
  | "anniversary"
  | "date"
  | "pet"
  | "question"
  | "quiz"
  | "mood"
  | "thought"
  | "meal-plan"
  | "wardrobe-item"
  | "wardrobe-share"
  | "wardrobe-suggestion"
  | "play-media"
  | "comment"
  | "report";
export interface Envelope {
  version: 1;
  algorithm: "XCHACHA20-POLY1305";
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  encoding?: "bytes";
}
export interface RecordMeta {
  id: string;
  spaceId: string;
  creatorId: string;
  visibility: Visibility;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  ownerOnly?: true;
  playMediaRoomId?: string;
}
export interface CipherRecord extends RecordMeta {
  envelope: Envelope;
  photoRefs?: string[];
}
export interface Attachment {
  id: string;
  mime: string;
  name: string;
  bytes: number;
  fileId?: string;
  encrypted?: Envelope;
  sample?: string;
}
export interface Payload {
  kind: Kind;
  title: string;
  photoPage?: true;
  replyPhotoId?: string;
  playWorkId?: string;
  playMediaRoomId?: string;
  mealReceipt?: { meal: string; dish: string; stamps?: Record<string, "again" | "other"> };
  body?: string;
  date: string;
  mood?: string;
  tags?: string[];
  photos?: Attachment[];
  favoriteBy?: string[];
  targetId?: string;
  unlockDate?: string;
  needsBoth?: boolean;
  confirmedBy?: string[];
  openedAt?: number;
  category?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  completedAt?: string;
  wishTargetDate?: string;
  priority?: string;
  budget?: string;
  location?: string;
  yearly?: boolean;
  pet?: Pet;
  answers?: { [userId: string]: string };
  question?: string;
  options?: string[];
  history?: { at: number; title: string; body: string }[];
  mealPlan?: MealPlan;
  wardrobeSelection?: WardrobeSelection;
  wardrobeSuggestion?: WardrobeSuggestion;
}
export interface Entry extends RecordMeta {
  data: Payload;
}
export interface Pet {
  name: string;
  exp: number;
  hunger: number;
  mood: number;
  energy: number;
  intimacy: number;
  decorations: string[];
  history: { userId: string; action: string; day: string; at: number }[];
  totalActions?: number;
  byAction?: Record<string, number>;
  dailyActions?: Record<string, number>;
}
export interface Space {
  id: string;
  members: string[];
  status: "active" | "closing" | "purging" | "closed";
  keyVersion: number;
  createdAt: number;
  keyCommitment?: string;
  closedBy?: string;
  closingAt?: number;
  purgeAfter?: number;
  purgedAt?: number;
  closeConfirmations?: string[];
  closeRequestedAt?: number;
}
export interface Device {
  id: string;
  userId: string;
  spaceId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  label: string;
  status: "active" | "revoked";
  createdAt: number;
  sharedOnly?: true;
}
export interface KeyTransfer {
  id: string;
  spaceId: string;
  fromDevice: string;
  toDevice: string;
  keyVersion: number;
  ephemeralPublicKey: string;
  envelope: Envelope;
  signature: string;
}
export interface Secrets {
  personalKey: string;
  sharedOnly?: true;
  localDraftKey?: string;
  encryptionSecret: string;
  signingSecret: string;
  deviceId: string;
  spaceKeys: { [version: string]: string };
  spaceId: string;
  userId: string;
  recoveryKey?: string;
  trustedDevices?: Record<string, string>;
  webSetup?: { kind: "create"; title: string; date: string } | { kind: "join"; token: string };
}
export interface Vault {
  version: 1;
  salt: string;
  passwordEnvelope: Envelope;
  recoveryEnvelope: Envelope;
}
export type RecoveryVault = Pick<Vault, "version" | "recoveryEnvelope">;
export interface ApiReply<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
export interface Transport {
  call<T>(action: string, data?: Record<string, unknown>): Promise<T>;
  webDeviceChallenges?: boolean;
  webRecordSync?: boolean;
}
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
export type RandomSource = (length: number) => Promise<Uint8Array>;
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
