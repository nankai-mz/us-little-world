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
  | "comment"
  | "report";
export interface Envelope {
  version: 1;
  algorithm: "XCHACHA20-POLY1305";
  keyVersion: number;
  nonce: string;
  ciphertext: string;
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
}
export interface CipherRecord extends RecordMeta {
  envelope: Envelope;
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
  priority?: string;
  budget?: string;
  location?: string;
  yearly?: boolean;
  pet?: Pet;
  answers?: { [userId: string]: string };
  question?: string;
  options?: string[];
  history?: { at: number; title: string; body: string }[];
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
}
export interface Space {
  id: string;
  members: string[];
  status: "active" | "closed";
  keyVersion: number;
  createdAt: number;
  keyCommitment?: string;
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
  encryptionSecret: string;
  signingSecret: string;
  deviceId: string;
  spaceKeys: { [version: string]: string };
  spaceId: string;
  userId: string;
  recoveryKey?: string;
  trustedDevices?: Record<string, string>;
}
export interface Vault {
  version: 1;
  salt: string;
  passwordEnvelope: Envelope;
  recoveryEnvelope: Envelope;
}
export interface ApiReply<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
export interface Transport {
  call<T>(action: string, data?: Record<string, unknown>): Promise<T>;
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
