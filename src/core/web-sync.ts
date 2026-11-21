import type { CipherRecord, Envelope, Secrets } from "./types";

export const cipherSnapshotScope = (secrets: Secrets) =>
  JSON.stringify([secrets.userId, secrets.spaceId, secrets.deviceId, !!secrets.sharedOnly]);

export type SyncPage = {
  records: CipherRecord[];
  removed: string[];
  cursor: string;
  more: boolean;
};

export type CipherSnapshot = { records: CipherRecord[]; cursor: string; writeKeyVersion?: number; binaryPhotos?: boolean };
export interface CipherCache {
  readonly enabled: boolean;
  read(scope: string): Promise<CipherSnapshot | undefined>;
  write(scope: string, snapshot: CipherSnapshot): Promise<void>;
  readPhoto?(scope: string, fileId: string): Promise<Envelope | undefined>;
  writePhoto(scope: string, fileId: string, envelope: Envelope): Promise<void>;
  clear(): Promise<void>;
}
