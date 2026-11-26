import {
  AppError,
  type Attachment,
  type CipherRecord,
  type Device,
  type Entry,
  type Envelope,
  type KeyTransfer,
  type Payload,
  type RandomSource,
  type RecordMeta,
  type Secrets,
  type Space,
  type StorageAdapter,
  type Transport,
  type Vault,
  type RecoveryVault,
  type Visibility,
} from "./types";
import {
  acceptTransfer,
  b64,
  createTransfer,
  decryptPhotoBytes,
  decryptRecord,
  deriveVaultKey,
  fingerprint,
  hashText,
  newSecrets,
  open,
  openVaultWithKey,
  publicKeys,
  randomId,
  recoverVault,
  recoveryOnlyVault,
  seal,
  sealVaultWithKey,
  unb64,
  unlockVault,
  type VaultKey,
} from "./crypto";
import { addDays, dayNumber, spaceDay, today } from "./date";
import { canOpenCapsule, newPet, petAction, QUESTIONS, SPACE_MEMBER_NAMES } from "./domain";
import { API_PROTOCOL, RECORD_RECEIPT_TTL_MS, type ConnectionStatus } from "./protocol";
import { PHOTO_DOWNLOAD_PART_SIZE, PHOTO_UPLOAD_PART_SIZE } from "./photos";
import { validateNewPassword } from "./password";
import { AI_TASKS, AI_TEXT_LIMIT, type AiTaskId } from "./ai";
import { signWebDevice, type WebDevice } from "./web-device";
import { profileContext, validDisplayName, type WebProfile } from "./web-profile";
import { thoughtId } from "./companionship";
import { cipherSnapshotScope, type CipherCache, type SyncPage } from "./web-sync";
import { recordOutboxScope, type OutboxState, type RecordOutbox } from "./web-outbox";
import { prepareRecordWrite } from "./record-write";
import { photoFileId, photoReceiptFor, preparePhotoWrite } from "./photo-write";

function unconfirmedPhotoRequest(error: unknown) {
  return error instanceof AppError && ["TIMEOUT", "NETWORK_ERROR"].includes(error.code);
}
function unconfirmedRecordWrite(error: unknown) {
  return error instanceof AppError && ["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE", "WRITE_UNCONFIRMED"].includes(error.code);
}
type PendingSave = { operationId: string; submittedAt: number; record: CipherRecord; expectedRevision: number; photoRefs?: string[] };
type Bootstrap = { userId: string; space: Space | null; initialDevicePending?: boolean; atomicEnrollment?: boolean };
type WebSetup = NonNullable<Secrets["webSetup"]>;

export class UsService {
  displayNames: ReadonlyMap<string, string> = new Map();
  private profileGeneration = 0;
  private syncSnapshot?: {
    scope: string; rows: Map<string, CipherRecord>; cursor: string; cachedAt: number; writeKeyVersion?: number; binaryPhotos: boolean;
  };
  private decodedRecords = new Map<string, { row: CipherRecord; key: string | undefined; entry?: Entry }>();
  private decodedKeys?: { personalKey: string; shared: Record<string, string> };
  private photoRequests = new Map<string, Promise<Uint8Array>>();
  private binaryPhotos = false;
  private recentPhotoEnvelopes = new Map<string, Envelope>();
  private activeSource?: Entry[];
  private activeEntries: Entry[] = [];
  initialDevicePending = false;
  secrets: Secrets | null = null;
  space: Space | null = null;
  entries: Entry[] = [];
  unreadable = 0;
  lastSyncedAt = 0;
  lastSyncError = "";
  syncStorageWarning = "";
  private lockSerial = 0;
  private refreshSerial = 0;
  private mutationSerial = 0;
  private mutations = new Map<
    string,
    { serial: number; entry: Entry | null }
  >();
  private vaultKey: VaultKey | null = null;
  constructor(
    public transport: Transport,
    public storage: StorageAdapter,
    public rng: RandomSource,
    private readonly features: { recordReceipts?: boolean; managedPhotos?: boolean; cipherCache?: CipherCache;
      outbox?: RecordOutbox; enrollmentLock?: <T>(task: () => Promise<T>) => Promise<T | undefined> } = {},
  ) {}
  get userId() {
    return this.secrets?.userId || "";
  }
  get day() {
    return this.transport.webDeviceChallenges ? spaceDay() : today();
  }
  get ready() {
    return (
      !!this.secrets &&
      !!this.space &&
      !!this.secrets.spaceKeys[this.space.keyVersion]
    );
  }
  get active() {
    if (this.activeSource !== this.entries) {
      this.activeSource = this.entries;
      this.activeEntries = this.entries.filter((e) => !e.deletedAt);
    }
    return this.activeEntries;
  }
  get hasPrivateAccess() {
    return !!this.secrets && !this.secrets.sharedOnly;
  }
  private requirePrivateAccess(visibility: Visibility) {
    if (visibility === "private" && !this.hasPrivateAccess)
      throw new AppError("PRIVATE_KEY_REQUIRED", "请从原设备导出的加密备份恢复私人记录");
  }
  get vault(): Vault | null {
    const v = (this.transport.webDeviceChallenges ? this.storage.get("webSetupVault") : null) ?? this.storage.get("vault");
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  get enrollmentPending() {
    return this.transport.webDeviceChallenges === true && !!this.storage.get("webSetupVault");
  }
  async persistSecrets() {
    const access = this.vaultKey;
    if (!this.secrets || !access)
      throw new AppError("LOCKED", "请先解锁");
    const { vault, recoveryKey } = await sealVaultWithKey(
      this.secrets,
      access,
      this.rng,
    );
    if (access !== this.vaultKey) throw new AppError("LOCKED", "请先解锁");
    this.storage.set("vault", JSON.stringify(vault));
    return recoveryKey;
  }
  private setVaultKey(access: VaultKey) {
    this.vaultKey?.key.fill(0);
    this.vaultKey = access;
  }
  getUnlockKey(): VaultKey | null {
    const access = this.vaultKey;
    return access && { salt: access.salt, key: access.key.slice() };
  }
  async unlock(password: string) {
    const vault = this.vault;
    if (!vault) throw new AppError("KEY_NOT_FOUND", "本机尚未建立密钥");
    const access = await deriveVaultKey(password, vault.salt);
    try {
      await this.unlockWithKey(access);
    } finally {
      access.key.fill(0);
    }
  }
  async unlockWithKey(access: VaultKey) {
    const vault = this.vault;
    if (!vault) throw new AppError("KEY_NOT_FOUND", "本机尚未建立密钥");
    const secrets = openVaultWithKey(vault, access);
    this.secrets = secrets;
    this.setVaultKey({ salt: access.salt, key: access.key.slice() });
    try {
      await this.bootstrap();
    } catch (error) {
      if (this.secrets === secrets) this.lock();
      throw error;
    }
  }
  private async verifyCurrentUnlock(password: string) {
    const session = this.secrets;
    const vault = this.vault;
    if (!session || !vault) throw new AppError("LOCKED", "请先解锁");
    let verified: Secrets;
    try {
      verified = await unlockVault(vault, password);
    } catch {
      throw new AppError("WRONG_PASSWORD", "本机解锁口令不正确");
    }
    if (
      this.secrets !== session ||
      verified.userId !== session.userId ||
      verified.spaceId !== session.spaceId
    )
      throw new AppError("LOCKED", "会话已改变，请重新解锁");
    return verified;
  }
  async confirmUnlockPassword(password: string) {
    await this.verifyCurrentUnlock(password);
  }
  async createBackup(password: string) {
    const session = this.secrets;
    if (!session) throw new AppError("LOCKED", "请先解锁");
    this.requirePrivateAccess("private");
    const verified = await this.verifyCurrentUnlock(password);
    if (!verified.recoveryKey) await this.persistSecrets();
    if (this.secrets !== session)
      throw new AppError("LOCKED", "会话已改变，请重新解锁");
    return {
      vault: recoveryOnlyVault(this.vault!),
      recoveryKey: this.secrets.recoveryKey || verified.recoveryKey!,
    };
  }
  async recover(vault: RecoveryVault, recoveryKey: string, password: string) {
    validateNewPassword(password);
    const recovered = recoverVault(vault, recoveryKey);
    if (recovered.sharedOnly)
      throw new AppError("PRIVATE_KEY_REQUIRED", "此备份只包含共同空间访问，请使用原设备导出的加密备份");
    const original = this.secrets;
    const lockSerial = this.lockSerial;
    const boot = await this.transport.call<Bootstrap>("bootstrap");
    if (
      boot.userId !== recovered.userId ||
      boot.space?.id !== recovered.spaceId
    )
      throw new AppError("IDENTITY_MISMATCH", "备份不属于当前账号和空间");
    if (!["active", "closing"].includes(boot.space.status))
      throw new AppError("SPACE_CLOSED", "这个空间已经关闭，无法恢复云端访问");
    // Drafts live only in this browser and keep their local key during same-space recovery.
    delete recovered.localDraftKey;
    if (original?.userId === recovered.userId && original.spaceId === recovered.spaceId)
      recovered.localDraftKey = original.localDraftKey ?? original.personalKey;
    const source = { deviceId: recovered.deviceId, signingSecret: recovered.signingSecret };
    recovered.deviceId = await randomId(this.rng);
    recovered.encryptionSecret = b64(await this.rng(32));
    recovered.signingSecret = b64(await this.rng(32));
    const access = await deriveVaultKey(password, b64(await this.rng(16)));
    try {
      const current = () => this.lockSerial === lockSerial && this.secrets === original;
      const sealed = await sealVaultWithKey(recovered, access, this.rng, recoveryKey);
      if (!current()) throw new AppError("LOCKED", "会话已改变，请重新恢复");
      await this.registerKeys(recovered, source);
      if (!current()) throw new AppError("LOCKED", "会话已改变，请重新恢复");
      this.storage.set("vault", JSON.stringify(sealed.vault));
      this.lock();
      this.setVaultKey({ salt: access.salt, key: access.key.slice() });
      this.secrets = recovered;
      this.space = boot.space;
    } finally {
      access.key.fill(0);
    }
    if (this.ready) await this.refresh();
  }
  async bootstrap() {
    const boot = await this.transport.call<Bootstrap>("bootstrap");
    if (this.secrets && this.secrets.userId !== boot.userId) {
      this.lock();
      throw new AppError("IDENTITY_MISMATCH", "恢复包不属于当前账号");
    }
    if (this.secrets?.webSetup && this.transport.webDeviceChallenges) {
      if (!boot.atomicEnrollment) throw new AppError("PROTOCOL_MISMATCH", "当前发布版本无法继续这次配对，请使用支持首次登记恢复的版本");
      const secrets = this.secrets;
      await this.withEnrollmentLock(async () => {
        if (this.secrets !== secrets) throw new AppError("LOCKED", "请先解锁");
        await this.completeWebSetup(secrets);
        return true;
      });
      return;
    }
    this.space = boot.space;
    this.initialDevicePending = !!boot.initialDevicePending;
    if (this.space && ["closed", "purging"].includes(this.space.status)) {
      this.lock();
      throw new AppError("SPACE_CLOSED", "这个空间已经关闭，云端访问已停止");
    }
    if (
      this.secrets &&
      this.space &&
      ["active", "closing"].includes(this.space.status)
    ) {
      if (this.secrets.spaceId !== this.space.id)
        throw new AppError("SPACE_MISMATCH", "当前密钥属于其他空间");
      await this.registerDevice();
      await this.verifyCurrentKey();
      if (this.ready) await this.refresh();
    }
  }
  async create(
    password: string,
    title: string,
    startDate: string,
    demo = false,
  ) {
    validateNewPassword(password);
    if (this.transport.webDeviceChallenges) return this.beginWebSetup(password, { kind: "create", title, date: startDate });
    const boot = await this.transport.call<{
      userId: string;
      space: Space | null;
    }>("bootstrap");
    if (boot.space?.status === "active")
      throw new AppError("ALREADY_BOUND", "当前账号已有空间，请恢复密钥");
    const secrets = await newSecrets(this.rng, boot.userId);
    const access = await deriveVaultKey(password, b64(await this.rng(16)));
    try {
      this.space = await this.transport.call<Space>("createSpace");
    } catch (error) {
      access.key.fill(0);
      throw error;
    }
    this.secrets = secrets;
    this.setVaultKey(access);
    this.secrets.spaceId = this.space.id;
    this.secrets.spaceKeys["1"] = b64(await this.rng(32));
    const recovery = await this.persistInitialDevice();
    await this.seedInitialSpace(title, startDate, demo);
    return recovery;
  }
  private async seedInitialSpace(title: string, startDate: string, demo = false) {
    await this.save({
      kind: "anniversary",
      title,
      body: demo ? SPACE_MEMBER_NAMES.join(" & ") : "我 & 你",
      date: startDate,
      category: "relationship",
      yearly: true,
    });
    await this.save(
      { kind: "pet", title: "糯米的小屋", date: this.day, pet: newPet() },
      "shared",
      undefined,
      hashText(this.space!.id + "/pet"),
    );
    if (demo) await this.seedDemo();
  }
  async join(password: string, token: string) {
    validateNewPassword(password);
    if (this.transport.webDeviceChallenges) return this.beginWebSetup(password, { kind: "join", token: token.trim() });
    const { userId } = await this.transport.call<{ userId: string }>(
      "bootstrap",
    );
    const secrets = await newSecrets(this.rng, userId);
    const access = await deriveVaultKey(password, b64(await this.rng(16)));
    let space: Space;
    try {
      space = await this.transport.call<Space>("joinSpace", { token: token.trim() });
    } catch (error) {
      access.key.fill(0);
      throw error;
    }
    secrets.spaceId = space.id;
    this.secrets = secrets;
    this.setVaultKey(access);
    this.space = space;
    return this.persistInitialDevice();
  }
  private async withEnrollmentLock<T>(work: () => Promise<T>) {
    const lock = this.features.enrollmentLock;
    if (!lock) return work();
    const value = await lock(work);
    if (value === undefined) throw new AppError("ENROLLMENT_BUSY", "另一标签页正在完成首次登记，请稍后重试");
    return value;
  }
  private async beginWebSetup(password: string, setup: WebSetup) {
    return this.withEnrollmentLock(async () => {
      const generation = this.lockSerial;
      if (this.storage.get("webSetupVault"))
        throw new AppError("ENROLLMENT_PENDING", "请用本机口令继续原来的配对");
      if (setup.kind === "create") dayNumber(setup.date);
      const boot = await this.transport.call<Bootstrap>("bootstrap");
      if (!boot.atomicEnrollment) throw new AppError("PROTOCOL_MISMATCH", "当前发布版本无法安全完成首次登记");
      // For join, check the token first so an invalid attempt does not replace any local keys.
      const spaceId = setup.kind === "join"
        ? (await this.transport.call<{ spaceId: string }>("inspectInvitation", { token: setup.token })).spaceId
        : await randomId(this.rng);
      if (boot.space?.status === "active") throw new AppError("ALREADY_BOUND", "当前账号已有空间，请恢复密钥");
      const secrets = await newSecrets(this.rng, boot.userId, spaceId);
      if (setup.kind === "create") secrets.spaceKeys["1"] = b64(await this.rng(32));
      secrets.webSetup = setup;
      const access = await deriveVaultKey(password, b64(await this.rng(16)));
      try {
        const { vault } = await sealVaultWithKey(secrets, access, this.rng);
        if (generation !== this.lockSerial) throw new AppError("LOCKED", "会话已改变，请重新开始配对");
        this.storage.set("webSetupVault", JSON.stringify(vault));
        this.setVaultKey({ salt: access.salt, key: access.key.slice() });
        this.secrets = secrets;
        return await this.completeWebSetup(secrets);
      } catch (error) {
        if (this.secrets === secrets) this.lock();
        throw error;
      } finally {
        access.key.fill(0);
      }
    });
  }
  private async completeWebSetup(secrets: Secrets) {
    const setup = secrets.webSetup!;
    const access = this.vaultKey!;
    const current = () => this.secrets === secrets && this.vaultKey === access;
    let space: Space;
    try {
      const claim = await this.deviceRegistration(secrets);
      if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
      space = await this.transport.call<Space>(setup.kind === "create" ? "createSpace" : "joinSpace", {
        ...claim, initialDevice: true, ...(setup.kind === "join" ? { token: setup.token } : {}),
      });
    } catch (error) {
      if (current() && error instanceof AppError &&
        ["INVITE_EXPIRED", "INVALID_INVITE", "SPACE_FULL", "SPACE_ID_IN_USE", "ALREADY_BOUND"].includes(error.code))
        this.storage.remove("webSetupVault");
      throw error;
    }
    if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
    if (space.id !== secrets.spaceId) throw new AppError("SPACE_MISMATCH", "服务端返回了不同的空间，请重新解锁核对");
    this.space = space;
    this.initialDevicePending = false;
    if (setup.kind === "create") {
      await this.refresh();
      if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
      if (!this.active.some(({ data }) => data.kind === "anniversary" && data.category === "relationship"))
        await this.save({ kind: "anniversary", title: setup.title, body: "我 & 你", date: setup.date, category: "relationship", yearly: true },
          "shared", undefined, hashText(space.id + "/relationship"));
      if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
      if (!this.active.some(({ data }) => data.kind === "pet"))
        await this.save({ kind: "pet", title: "糯米的小屋", date: this.day, pet: newPet() },
          "shared", undefined, hashText(space.id + "/pet"));
    }
    if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
    const { webSetup: _setup, ...completed } = secrets;
    const { vault, recoveryKey } = await sealVaultWithKey(completed, access, this.rng);
    if (!current()) throw new AppError("LOCKED", "会话已改变，请重新解锁");
    this.storage.set("vault", JSON.stringify(vault));
    this.storage.remove("webSetupVault");
    delete secrets.webSetup;
    return recoveryKey;
  }
  async setUpDevice(password: string, initial?: { title: string; date: string }) {
    if (this.vault)
      throw new AppError("LOCAL_KEYS_EXIST", "此浏览器已有密钥，请使用本机口令解锁");
    validateNewPassword(password);
    const { userId, space, initialDevicePending } = await this.transport.call<Bootstrap>("bootstrap");
    if (space?.status !== "active" || !space.members.includes(userId))
      throw new AppError("MEMBER_REQUIRED", "当前账号没有可登记设备的双人空间");
    const secrets = await newSecrets(this.rng, userId);
    secrets.spaceId = space.id;
    const initialOwner = initialDevicePending && space.members[0] === userId && space.keyVersion === 1;
    if (initialOwner) secrets.spaceKeys["1"] = b64(await this.rng(32));
    if (!initialDevicePending) secrets.sharedOnly = true;
    this.setVaultKey(await deriveVaultKey(password, b64(await this.rng(16))));
    this.secrets = secrets;
    this.space = space;
    const recoveryKey = await this.persistInitialDevice();
    if (initialOwner) await this.seedInitialSpace(initial?.title ?? "我们的小世界", initial?.date ?? this.day);
    return initialOwner ? recoveryKey : undefined;
  }
  private async persistInitialDevice() {
    try {
      const recoveryKey = await this.persistSecrets();
      await this.registerDevice();
      this.initialDevicePending = false;
      return recoveryKey;
    } catch (error) {
      this.lock();
      throw error;
    }
  }
  async registerDevice() {
    const session = this.secrets;
    if (!session || !this.space) return;
    await this.registerKeys(session);
    if (this.secrets === session && !session.sharedOnly) this.initialDevicePending = false;
  }
  private async registerKeys(secrets: Secrets, source?: { deviceId: string; signingSecret: string }) {
    return this.transport.call("registerDevice", await this.deviceRegistration(secrets, source));
  }
  private async deviceRegistration(secrets: Secrets, source?: { deviceId: string; signingSecret: string }) {
    const device: WebDevice = {
      spaceId: secrets.spaceId,
      id: secrets.deviceId,
      ...publicKeys(secrets),
      ...(secrets.sharedOnly ? { sharedOnly: true } : {}),
      label: "我的设备",
    };
    if (!this.transport.webDeviceChallenges) return device;
    const { nonce } = await this.transport.call<{ nonce: string }>("deviceChallenge", {
      spaceId: device.spaceId, id: device.id,
    });
    const recovery = !secrets.sharedOnly && secrets.recoveryKey
      ? { userId: secrets.userId, key: secrets.recoveryKey } : undefined;
    const proof = signWebDevice(device, nonce, secrets.signingSecret, recovery, source);
    return { ...device, proof };
  }
  async call<T>(action: string, data: Record<string, unknown> = {}) {
    if (!this.secrets || !this.space) throw new AppError("LOCKED", "请先解锁");
    return this.transport.call<T>(action, {
      ...data,
      apiProtocol: API_PROTOCOL,
      spaceId: this.space.id,
      deviceId: this.secrets.deviceId,
    });
  }
  get cipherCacheEnabled() {
    return !!this.features.cipherCache?.enabled;
  }
  async setCipherCacheEnabled(enabled: boolean) {
    const cache = this.features.cipherCache;
    if (!cache) return;
    this.storage.set("cipherCache", String(enabled));
    if (enabled) await this.refresh();
    else {
      await cache.clear();
      if (this.syncSnapshot) this.syncSnapshot.cachedAt = 0;
      this.syncStorageWarning = "";
    }
  }
  private async loadWebRows(session: Secrets, space: Space, current: () => boolean) {
    const scope = cipherSnapshotScope(session);
    const saved = this.syncSnapshot?.scope === scope ? this.syncSnapshot : undefined;
    const cache = this.features.cipherCache;
    let rows = saved?.rows ?? new Map<string, CipherRecord>();
    let cursor = saved?.cursor;
    let cachedAt = saved?.cachedAt ?? 0;
    const writeKeyVersion = space.status === "active" && session.spaceKeys[space.keyVersion] ? space.keyVersion : undefined;
    const binaryPhotos = this.binaryPhotos;
    let changed = writeKeyVersion !== saved?.writeKeyVersion || binaryPhotos !== saved?.binaryPhotos;
    if (!saved && cache?.enabled) {
      try {
        const persisted = await cache.read(scope);
        if (persisted) {
          rows = new Map(persisted.records.map((record) => [record.id, record]));
          cursor = persisted.cursor;
        }
      } catch { /* Server snapshot remains available with restricted browser storage. */ }
    }
    let reset = false;
    while (current()) {
      let page: SyncPage;
      try {
        page = await this.call<SyncPage>("syncRecords", cursor ? { cursor } : {});
      } catch (error) {
        if (!cursor || reset || !(error instanceof AppError) || error.code !== "SYNC_RESET") throw error;
        rows = new Map();
        cursor = undefined;
        reset = true;
        changed = true;
        continue;
      }
      if (!current()) return;
      if (rows === saved?.rows && (page.records.length > 0 || page.removed.length > 0)) rows = new Map(rows);
      for (const record of page.records) rows.set(record.id, record);
      for (const recordId of page.removed) rows.delete(recordId);
      changed ||= page.records.length > 0 || page.removed.length > 0;
      cursor = page.cursor;
      if (!page.more) {
        if (cache?.enabled && (changed || Date.now() - cachedAt > 3600000)) {
          try {
            await cache.write(scope, { records: [...rows.values()], cursor, writeKeyVersion, binaryPhotos });
            if (current()) this.syncStorageWarning = "";
          } catch {
            if (current()) this.syncStorageWarning = "无法保存回忆的浏览器密文缓存，联机同步仍可使用";
          }
          cachedAt = Date.now();
        }
        return { scope, rows, cursor, cachedAt, writeKeyVersion, binaryPhotos };
      }
    }
  }
  async refresh() {
    const session = this.secrets;
    const serial = ++this.refreshSerial;
    const startedAtMutation = this.mutationSerial;
    const profileGeneration = this.profileGeneration;
    const current = () => this.secrets === session && serial === this.refreshSerial;
    if (!session || !this.space) throw new AppError("LOCKED", "请先解锁");
    try {
      const { profiles, binaryPhotos, ...space } =
        await this.call<Space & { profiles?: WebProfile[]; binaryPhotos?: boolean }>("getSpace");
      if (this.secrets !== session || serial !== this.refreshSerial) return;
      this.binaryPhotos = this.transport.webDeviceChallenges === true && binaryPhotos === true;
      if (!this.space || JSON.stringify(this.space) !== JSON.stringify(space)) this.space = space;
      await this.verifyCurrentKey();
      if (this.secrets !== session || serial !== this.refreshSerial) return;
      if (profiles && profileGeneration === this.profileGeneration) {
        const displayNames = new Map<string, string>();
        for (const { userId, envelope } of profiles) {
          const key = session.spaceKeys[envelope.keyVersion];
          if (!key || !space.members.includes(userId)) continue;
          try {
            const name = open<unknown>(envelope, unb64(key), profileContext(space.id, userId));
            if (validDisplayName(name)) displayNames.set(userId, name);
          } catch { /* Skip a profile whose key is unavailable or envelope was replaced. */ }
        }
        if (this.displayNames.size !== displayNames.size || [...displayNames].some(([id, name]) => this.displayNames.get(id) !== name))
          this.displayNames = displayNames;
      }
      const rows: CipherRecord[] = [];
      const snapshot = this.transport.webRecordSync ? await this.loadWebRows(session, space, current) : undefined;
      if (!current()) return;
      const knownKeys = this.decodedKeys;
      const keyVersions = Object.keys(session.spaceKeys);
      if (snapshot && snapshot.rows === this.syncSnapshot?.rows && this.mutations.size === 0 &&
        knownKeys?.personalKey === session.personalKey && keyVersions.length === Object.keys(knownKeys.shared).length &&
        keyVersions.every((version) => knownKeys.shared[version] === session.spaceKeys[version])) {
        this.syncSnapshot = snapshot;
        this.lastSyncedAt = Date.now();
        this.lastSyncError = "";
        return;
      }
      if (snapshot) {
        for (const row of snapshot.rows.values()) rows.push(row);
      } else {
        let pageInput: { after: string } | { offset: number } | null =
          this.transport.webDeviceChallenges ? { after: "" } : { offset: 0 };
        while (pageInput) {
          const page: { records: CipherRecord[]; nextOffset?: number | null; nextAfter?: string | null } =
            await this.call("listRecords", pageInput);
          rows.push(...page.records);
          if ("after" in pageInput && typeof page.nextAfter === "string") {
            if (page.nextAfter <= pageInput.after)
              throw new AppError("INVALID_RESPONSE", "记录分页游标无效");
            pageInput = { after: page.nextAfter };
          } else pageInput = typeof page.nextOffset === "number" ? { offset: page.nextOffset } : null;
          if (!current()) return;
        }
      }
      const entries: Entry[] = [];
      const decoded = new Map<string, { row: CipherRecord; key: string | undefined; entry?: Entry }>();
      let unreadable = 0;
      let decrypted = 0;
      for (const r of rows) {
        if (session.sharedOnly && r.visibility === "private") continue;
        const key = r.visibility === "private" ? session.personalKey : session.spaceKeys[r.envelope.keyVersion];
        let cached = snapshot ? this.decodedRecords.get(r.id) : undefined;
        if (!cached || cached.row !== r || cached.key !== key) {
          if (snapshot && decrypted++ % 48 === 47) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (!current()) return;
          }
          cached = { row: r, key };
          try {
            cached.entry = { ...r, data: decryptRecord<Payload>(r, session) };
          } catch { /* Retry when either the ciphertext or its key changes. */ }
        }
        if (snapshot) decoded.set(r.id, cached);
        if (cached.entry) entries.push(cached.entry);
        else unreadable++;
      }
      const merged = new Map(entries.map((entry) => [entry.id, entry]));
      for (const [id, mutation] of this.mutations) {
        if (mutation.serial > startedAtMutation) {
          if (mutation.entry) merged.set(id, mutation.entry);
          else merged.delete(id);
        } else this.mutations.delete(id);
      }
      const ordered = [...merged.values()].sort(
        (a, b) =>
          b.data.date.localeCompare(a.data.date) || b.createdAt - a.createdAt,
      );
      if (ordered.length !== this.entries.length || ordered.some((entry, index) => entry !== this.entries[index]))
        this.entries = ordered;
      this.decodedRecords = decoded;
      this.decodedKeys = snapshot ? { personalKey: session.personalKey, shared: { ...session.spaceKeys } } : undefined;
      this.unreadable = unreadable;
      this.syncSnapshot = snapshot;
      this.lastSyncedAt = Date.now();
      this.lastSyncError = "";
    } catch (error) {
      if (this.secrets === session && serial === this.refreshSerial)
        this.lastSyncError =
          error instanceof Error ? error.message : "同步暂时不可用";
      throw error;
    }
  }
  async saveDisplayName(value: string) {
    const session = this.secrets;
    const space = this.space;
    const key = session && space && session.spaceKeys[space.keyVersion];
    if (!session || !space || !key) throw new AppError("LOCKED", "请先解锁共同空间");
    const name = value.trim();
    if (!validDisplayName(name))
      throw new AppError("INVALID_DISPLAY_NAME", "昵称最多 16 个字符，不能包含控制字符");
    const envelope = await seal(name, unb64(key), profileContext(space.id, session.userId), this.rng, space.keyVersion);
    if (this.secrets !== session) throw new AppError("LOCKED", "会话已改变，请重新解锁");
    await this.call("setSpaceProfile", { envelope });
    if (this.secrets !== session) return;
    this.profileGeneration++;
    this.displayNames = new Map(this.displayNames).set(session.userId, name);
  }
  async sendThought(date: string, replyTo?: string) {
    const space = this.space;
    const userId = this.userId;
    if (!space || !userId || space.members.length !== 2)
      throw new AppError("MEMBER_REQUIRED", "两位成员都加入后可以发送想你");
    if (replyTo && !this.active.some((entry) =>
      entry.id === replyTo && entry.creatorId !== userId && entry.visibility === "shared" &&
      entry.data.kind === "thought" && !entry.data.targetId,
    )) throw new AppError("THOUGHT_UNAVAILABLE", "这条想你已撤回或暂不可用");
    const id = thoughtId(space.id, userId, date, replyTo);
    const existing = this.entries.find((entry) => entry.id === id && entry.creatorId === userId);
    if (existing && !existing.deletedAt) return;
    if (existing) {
      await this.trash(existing, true);
      return;
    }
    try {
      await this.save({
        kind: "thought", title: replyTo ? "我也想你" : "想你", date,
        ...(replyTo ? { targetId: replyTo } : {}),
      }, "shared", undefined, id);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "REVISION_CONFLICT") throw error;
      await this.refresh();
      if (!this.active.some((entry) => entry.id === id && entry.creatorId === userId)) throw error;
    }
  }
  async withdrawThought(id: string) {
    const thought = this.active.find((entry) =>
      entry.id === id && entry.creatorId === this.userId && entry.data.kind === "thought",
    );
    if (!thought) throw new AppError("THOUGHT_UNAVAILABLE", "当前没有可撤回的想你");
    await this.trash(thought);
  }
  async checkConnection(): Promise<ConnectionStatus> {
    const status = await this.transport.call<ConnectionStatus>("health");
    if (status.protocol !== API_PROTOCOL)
      throw new AppError(
        "PROTOCOL_MISMATCH",
        this.transport.webDeviceChallenges ? "网站接口版本不匹配，请刷新后重试" : "云端接口版本不匹配，请更新小程序与云函数",
      );
    return status;
  }
  private rememberMutation(id: string, entry: Entry | null) {
    this.mutations.set(id, { serial: ++this.mutationSerial, entry });
  }
  private async mutationStatus<T>(action: string, operationId: string): Promise<T | null> {
    const receipt = await this.call<{ action: string; result: T } | null>("mutationStatus", { operationId });
    if (receipt && receipt.action !== action) throw new AppError("OPERATION_REUSED", "该保存编号已有其它用途");
    return receipt?.result ?? null;
  }
  private async submitMutation<T>(action: string, request: Record<string, unknown> & { operationId?: string }): Promise<T> {
    if (!request.operationId) return this.call<T>(action, request);
    const session = this.secrets;
    const confirm = () => this.mutationStatus<T>(action, request.operationId!).catch(() => {
      throw new AppError("WRITE_UNCONFIRMED", "暂时无法核对保存结果，请联网后重试核对");
    });
    try {
      return await this.call<T>(action, request);
    } catch (error) {
      if (!unconfirmedRecordWrite(error) || session !== this.secrets) throw error;
    }
    try {
      const saved = await confirm();
      if (saved) return saved;
      if (session !== this.secrets) throw new AppError("LOCKED", "会话已改变，请重新解锁后核对保存结果");
      return await this.call<T>(action, request);
    } catch (error) {
      if (!unconfirmedRecordWrite(error) || session !== this.secrets) throw error;
    }
    const saved = await confirm();
    if (saved) return saved;
    throw new AppError("WRITE_UNCONFIRMED", "保存结果仍未确认，请联网后核对");
  }
  private get pendingSave(): PendingSave | null {
    const raw = this.storage.get("pendingRecordSave");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  get hasPendingSave() {
    return !!this.space && this.pendingSave?.record?.spaceId === this.space.id;
  }
  private clearPendingSave(operationId: string) {
    if (this.pendingSave?.operationId === operationId) this.storage.remove("pendingRecordSave");
  }
  async resumePendingSave() {
    const pending = this.pendingSave;
    if (!pending || !this.hasPendingSave) return false;
    const session = this.secrets;
    if (!session) throw new AppError("LOCKED", "请先解锁");
    this.requirePrivateAccess(pending.record.visibility);
    const { submittedAt, ...request } = pending;
    try {
      const saved = await this.mutationStatus<RecordMeta>("putRecord", request.operationId);
      if (session !== this.secrets) throw new AppError("LOCKED", "会话已改变，请重新解锁后核对");
      if (!saved && Date.now() - submittedAt >= RECORD_RECEIPT_TTL_MS)
        throw new AppError("RECEIPT_EXPIRED", "确认期限已过，请刷新并核对记录后再决定是否重写");
      if (!saved) await this.submitMutation<RecordMeta>("putRecord", request);
    } catch (error) {
      if (error instanceof AppError && ["REVISION_CONFLICT", "KEY_VERSION_MISMATCH", "RECEIPT_EXPIRED"].includes(error.code))
        this.clearPendingSave(request.operationId);
      throw error;
    }
    if (session !== this.secrets) throw new AppError("LOCKED", "会话已改变，请重新解锁后核对");
    this.clearPendingSave(request.operationId);
    await this.refresh().catch(() => {});
    return { id: request.record.id, expectedRevision: request.expectedRevision };
  }
  private outboxScope() {
    const session = this.secrets;
    if (!session || this.space?.id !== session.spaceId) throw new AppError("LOCKED", "请先解锁");
    return recordOutboxScope(session);
  }
  get supportsOutbox() { return !!this.features.outbox; }
  get supportsManagedPhotos() { return !!this.features.managedPhotos; }
  async prepareQueuedPhoto(bytes: string | Uint8Array, mime: string, name: string, visibility: Visibility) {
    const session = this.secrets;
    const space = this.space;
    if (!session || !space || !this.ready) throw new AppError("LOCKED", "请先解锁");
    const prepared = await preparePhotoWrite(bytes, mime, name, visibility, session, space.keyVersion, this.rng, this.binaryPhotos);
    if (this.secrets !== session || this.space?.id !== space.id) throw new AppError("LOCKED", "请先解锁");
    return prepared;
  }
  async queueSave(data: Payload, visibility: Visibility, existing?: Entry, attachments: { fileId: string; envelope: Envelope }[] = []) {
    const outbox = this.features.outbox;
    if (!outbox) throw new AppError("OUTBOX_UNAVAILABLE", "当前入口无法保存待同步记录");
    const scope = this.outboxScope();
    const request = await this.prepareSave(data, visibility, existing);
    if (!request.operationId) throw new AppError("OUTBOX_UNAVAILABLE", "当前入口无法生成保存回执");
    await outbox.add({
      scope, operationId: request.operationId, queuedAt: Date.now(), record: request.record,
      expectedRevision: request.expectedRevision, photoRefs: request.photoRefs, state: "queued", attachments,
    });
  }
  async listOutbox() {
    const session = this.secrets;
    if (!session || !this.features.outbox) return [];
    const items = await this.features.outbox.read(this.outboxScope());
    if (this.secrets !== session) return [];
    return items.filter(({ record }) => record.visibility === "shared" ||
      (!session.sharedOnly && record.creatorId === session.userId)).map((item) => {
      let data: Payload | undefined;
      try { data = decryptRecord<Payload>(item.record, session); } catch { /* Key may be unavailable after recovery. */ }
      return {
        operationId: item.operationId, state: item.state, queuedAt: item.queuedAt, data,
        visibility: item.record.visibility, attachments: item.attachments,
      };
    });
  }
  async copyOutboxAsNew(operationId: string, edits?: { title: string; body: string; photoIds: string[] }) {
    const session = this.secrets;
    const item = (await this.listOutbox()).find((candidate) => candidate.operationId === operationId);
    if (!session || this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
    if (!item?.data || item.data.kind !== "memory")
      throw new AppError("OUTBOX_UNAVAILABLE", "此待同步日记暂时不能复制");
    const { data, visibility } = item;
    const copied = [];
    for (const photo of data.photos ?? []) {
      if (edits && !edits.photoIds.includes(photo.id)) continue;
      const pending = item.attachments?.find(({ fileId }) => fileId === photo.fileId);
      let bytes: Uint8Array;
      try {
        bytes = pending
          ? decryptPhotoBytes(pending.envelope, session, photo.id, visibility)
          : await this.readPhotoBytes(photo, visibility, () => this.secrets === session);
      } catch (error) {
        if (error instanceof AppError && ["FORBIDDEN", "DECRYPT_FAILED", "KEY_NOT_FOUND"].includes(error.code))
          throw new AppError("OUTBOX_PHOTO_UNAVAILABLE", `无法找回「${photo.name}」。可以取消勾选这张照片后再另存。`);
        throw error;
      }
      if (this.secrets !== session) throw new AppError("LOCKED", "会话已改变，请重新解锁");
      copied.push(await this.prepareQueuedPhoto(bytes, photo.mime, photo.name, visibility));
    }
    if (this.secrets !== session) throw new AppError("LOCKED", "会话已改变，请重新解锁");
    const { history: _history, favoriteBy: _favorites, ...draft } = data;
    const content = edits ? { title: edits.title, body: edits.body } : {};
    await this.queueSave({ ...draft, ...content, photos: copied.map(({ photo }) => photo) }, visibility, undefined,
      copied.map(({ photo, envelope }) => ({ fileId: photo.fileId, envelope })));
  }
  async discardOutbox(operationId: string) {
    const outbox = this.features.outbox;
    if (!outbox || !(await this.listOutbox()).some((item) => item.operationId === operationId)) return;
    const scope = this.outboxScope();
    const removed = await outbox.exclusive(scope, async () => {
      await outbox.remove(scope, operationId);
      return true;
    });
    if (!removed) throw new AppError("OUTBOX_BUSY", "另一个标签页正在同步，请稍后重试");
  }
  async flushOutbox(operationId?: string) {
    const outbox = this.features.outbox;
    const session = this.secrets;
    if (!outbox || !session || !this.ready) return 0;
    const scope = this.outboxScope();
    const sent = await outbox.exclusive(scope, async () => {
      if (this.secrets !== session) return 0;
      const items = (await outbox.read(scope)).filter((item) =>
        (operationId ? item.operationId === operationId : ["queued", "retry"].includes(item.state)) &&
        (item.record.visibility === "shared" || (!session.sharedOnly && item.record.creatorId === session.userId)),
      );
      if (!items.length || this.secrets !== session) return 0;
      const space = await this.call<Space>("getSpace");
      if (this.secrets !== session) return 0;
      if (space.status !== "active") throw new AppError("SPACE_CLOSING", "空间处于只读期，待同步日记保留在本机");
      let sent = 0;
      for (const item of items) {
        if (this.secrets !== session) break;
        const { record, expectedRevision, photoRefs, operationId: itemId } = item;
        let state: OutboxState = "retry";
        try {
          const saved = await this.mutationStatus<RecordMeta>("putRecord", itemId);
          if (this.secrets !== session) break;
          if (!saved) {
            if (Date.now() - item.queuedAt >= RECORD_RECEIPT_TTL_MS) {
              await outbox.set({ ...item, state: "expired" });
              continue;
            }
            if (item.attachments?.length && record.envelope.keyVersion !== space.keyVersion)
              throw new AppError("KEY_VERSION_MISMATCH", "空间密钥已更新，请核对待同步日记");
            for (const { fileId, envelope } of item.attachments ?? []) {
              const receipt = photoReceiptFor(record.visibility, envelope);
              if (photoFileId(space.id, session.userId, receipt) !== fileId || !photoRefs?.includes(fileId) ||
                envelope.keyVersion !== record.envelope.keyVersion)
                throw new AppError("INVALID_ATTACHMENT", "本机照片和待同步记录不匹配");
              const status = await this.call<{ id: string | null }>("fileUploadStatus", { receipt });
              if (this.secrets !== session) throw new AppError("LOCKED", "会话已改变，请重新解锁");
              const uploaded = status.id ?? await this.uploadPhotoEnvelope(envelope, record.visibility, undefined, true);
              if (uploaded !== fileId) throw new AppError("INVALID_ATTACHMENT", "照片回执不匹配，请保留本机日记");
            }
            if (this.secrets !== session) throw new AppError("LOCKED", "会话已改变，请重新解锁");
            await this.submitMutation<RecordMeta>("putRecord", { operationId: itemId, record, expectedRevision, photoRefs });
          }
          await outbox.remove(scope, itemId);
          sent++;
          continue;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          if (["AUTH_REQUIRED", "DEVICE_REVOKED", "DEVICE_UNBOUND", "MEMBER_REQUIRED"].includes(error.code)) {
            await outbox.set({ ...item, state: "blocked" });
            throw error;
          }
          if (error.code === "REVISION_CONFLICT") state = "conflict";
          else if (!unconfirmedRecordWrite(error) && !["PHOTO_PART_UNAVAILABLE", "PHOTO_PART_MISSING",
            "PHOTO_STATUS_UNAVAILABLE", "PHOTO_NOT_CONFIRMED", "PHOTO_STORAGE_LOW", "LOCKED"].includes(error.code)) state = "blocked";
        }
        await outbox.set({ ...item, state });
        if (state === "retry" || this.secrets !== session) break;
      }
      if (sent && this.secrets === session) await this.refresh().catch(() => {});
      return sent;
    });
    if (sent === undefined) throw new AppError("OUTBOX_BUSY", "另一个标签页正在同步，请稍后重试");
    return sent;
  }
  private async prepareSave(
    data: Payload,
    visibility: Visibility = "shared",
    existing?: Entry,
    fixedId?: string,
  ) {
    const session = this.secrets;
    const space = this.space;
    if (!session || !space) throw new AppError("LOCKED", "请先解锁");
    if (space.status !== "active")
      throw new AppError(
        "SPACE_CLOSING",
        "空间正在关闭冷静期，只能查看、导出或撤销关闭",
      );
    const prepared = await prepareRecordWrite(data, visibility, session, space.keyVersion, this.rng, existing, fixedId);
    const operationId = this.features.recordReceipts ? await randomId(this.rng) : undefined;
    if (this.secrets !== session || this.space?.id !== space.id)
      throw new AppError("LOCKED", "会话已改变，请重新解锁后保存记录");
    return { ...prepared, operationId, photoRefs: this.features.managedPhotos ? prepared.photoRefs : undefined, session };
  }
  async save(
    data: Payload,
    visibility: Visibility = "shared",
    existing?: Entry,
    fixedId?: string,
    keepPending = false,
  ) {
    const { data: preparedData, session, ...request } = await this.prepareSave(data, visibility, existing, fixedId);
    const { operationId } = request;
    const persist = keepPending && this.features.recordReceipts;
    if (persist) {
      if (this.hasPendingSave) throw new AppError("WRITE_UNCONFIRMED", "请先核对上一条未确认的保存");
      this.storage.set("pendingRecordSave", JSON.stringify({ ...request, submittedAt: Date.now() }));
    }
    let saved: RecordMeta;
    try {
      saved = await this.submitMutation<RecordMeta>("putRecord", request);
    } catch (error) {
      if (persist && operationId && this.secrets === session && !unconfirmedRecordWrite(error)) this.clearPendingSave(operationId);
      throw error;
    }
    if (this.secrets !== session)
      throw new AppError(
        "SESSION_CHANGED",
        "当前会话已锁定，记录未重新显示；解锁后请刷新查看云端保存结果",
      );
    if (persist && operationId) this.clearPendingSave(operationId);
    const entry = { ...saved, data: preparedData };
    const newer = this.entries.find((current) => current.id === entry.id && current.revision > entry.revision);
    if (newer) return newer;
    this.rememberMutation(entry.id, entry);
    this.entries = [
      entry,
      ...this.entries.filter((e) => e.id !== entry.id),
    ].sort(
      (a, b) =>
        b.data.date.localeCompare(a.data.date) || b.createdAt - a.createdAt,
    );
    return entry;
  }
  async trash(entry: Entry, restore = false) {
    this.requirePrivateAccess(entry.visibility);
    const session = this.secrets;
    const operationId = this.features.recordReceipts ? await randomId(this.rng) : undefined;
    if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
    const saved = await this.submitMutation<RecordMeta>(
      restore ? "restoreRecord" : "deleteRecord",
      {
        recordId: entry.id,
        expectedRevision: entry.revision,
        operationId,
      },
    );
    if (this.secrets !== session)
      throw new AppError("SESSION_CHANGED", "当前会话已锁定，请解锁后刷新");
    const updated = { ...saved, data: entry.data };
    this.rememberMutation(entry.id, updated);
    this.entries = this.entries.map((current) =>
      current.id === updated.id ? updated : current,
    );
    await this.refresh();
  }
  async purge(entry: Entry) {
    this.requirePrivateAccess(entry.visibility);
    const session = this.secrets;
    const operationId = this.features.recordReceipts ? await randomId(this.rng) : undefined;
    if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
    const { deletedFileIds } = await this.submitMutation<{ deletedFileIds?: string[] }>("purgeRecord", {
      recordId: entry.id,
      expectedRevision: entry.revision,
      operationId,
    });
    if (this.secrets !== session)
      throw new AppError("SESSION_CHANGED", "当前会话已锁定，请解锁后刷新");
    this.rememberMutation(entry.id, null);
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    for (const p of entry.data.photos || [])
      if (p.fileId && !deletedFileIds?.includes(p.fileId)) await this.call("fileDelete", { fileId: p.fileId });
    await this.refresh();
  }
  async favorite(entry: Entry) {
    const ids = entry.data.favoriteBy || [];
    return this.save(
      {
        ...entry.data,
        favoriteBy: ids.includes(this.userId)
          ? ids.filter((id) => id !== this.userId)
          : [...ids, this.userId],
      },
      entry.visibility,
      entry,
    );
  }
  async interact(action: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.refresh();
      const entry = this.active.find((e) => e.data.kind === "pet");
      if (!entry?.data.pet)
        throw new AppError("PET_NOT_FOUND", "小伙伴还没有安家");
      try {
        return await this.save(
          {
            ...entry.data,
            pet: petAction(entry.data.pet, action, this.userId),
          },
          "shared",
          entry,
        );
      } catch (e) {
        if (
          !(e instanceof AppError) ||
          e.code !== "REVISION_CONFLICT" ||
          attempt === 2
        )
          throw e;
      }
    }
  }
  async answer(
    title: string,
    answer: string,
    kind: "question" | "quiz" = "question",
    date = this.day,
  ) {
    dayNumber(date);
    if (!this.space || !this.secrets) throw new AppError("LOCKED", "请先解锁");
    if (!answer.trim()) throw new AppError("EMPTY_ANSWER", "先写下你的答案吧");
    const fixedId = hashText(
      this.space!.id + "/" + kind + "/" + date + "/" + hashText(title),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.refresh();
      const current = this.active.find((e) => e.id === fixedId);
      try {
        return await this.save(
          {
            ...current?.data,
            kind,
            title,
            date,
            answers: { ...current?.data.answers, [this.userId]: answer.trim() },
          },
          "shared",
          current,
          fixedId,
        );
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== "REVISION_CONFLICT" ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new AppError("REVISION_CONFLICT", "答案刚刚有更新，请刷新后再试");
  }
  async askQuestion(title: string, category = "自定义") {
    const text = title.trim();
    if (!text || text.length > 180)
      throw new AppError("INVALID_QUESTION", "请写下 1～180 字的问题");
    if (!this.space || !this.secrets) throw new AppError("LOCKED", "请先解锁");
    const date = this.day;
    const fixedId = hashText(
      this.space.id + "/question/" + date + "/" + hashText(text),
    );
    await this.refresh();
    const existing = this.active.find((entry) => entry.id === fixedId);
    if (existing) return existing;
    return this.save(
      { kind: "question", title: text, date, category, answers: {} },
      "shared",
      undefined,
      fixedId,
    );
  }
  async confirmCapsule(e: Entry) {
    return this.save(
      {
        ...e.data,
        confirmedBy: [...new Set([...(e.data.confirmedBy || []), this.userId])],
      },
      "shared",
      e,
    );
  }
  async openCapsule(e: Entry) {
    if (!canOpenCapsule(e, this.space!.members, this.day))
      throw new AppError(
        "CAPSULE_LOCKED",
        "还没到开启的时候，把期待留给未来吧",
      );
    return this.save({ ...e.data, openedAt: Date.now() }, "shared", e);
  }
  async addPhoto(
    bytes: string | Uint8Array,
    mime: string,
    name: string,
    visibility: Visibility,
    onUploadProgress?: (sent: number, total: number) => void,
  ): Promise<Attachment> {
    const session = this.secrets;
    const space = this.space;
    if (!session || !space) throw new AppError("LOCKED", "请先解锁");
    this.requirePrivateAccess(visibility);
    const { photo, envelope } = await preparePhotoWrite(bytes, mime, name, visibility, session, space.keyVersion, this.rng, this.binaryPhotos);
    if (this.secrets !== session || this.space?.id !== space.id) throw new AppError("LOCKED", "请先解锁");
    return { ...photo, fileId: await this.uploadPhotoEnvelope(envelope, visibility, onUploadProgress) };
  }
  private async uploadPhotoEnvelope(
    envelope: Envelope, visibility: Visibility, onUploadProgress?: (sent: number, total: number) => void,
    segmented = !!onUploadProgress,
  ) {
    const session = this.secrets;
    if (!session) throw new AppError("LOCKED", "请先解锁");
    const receipt = photoReceiptFor(visibility, envelope);
    const managed = this.features.managedPhotos ? { managed: true } : {};
    const upload = async () => {
      const { ciphertext, ...header } = envelope;
      if (segmented) {
        const total = Math.ceil(ciphertext.length / PHOTO_UPLOAD_PART_SIZE);
        for (let index = 0; index < total; index++) {
          if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
          const offset = index * PHOTO_UPLOAD_PART_SIZE;
          const part = { receipt, index, chunk: ciphertext.slice(offset, offset + PHOTO_UPLOAD_PART_SIZE) };
          try {
            await this.call("fileUploadPart", part);
          } catch (error) {
            // Older cloud functions reject this action before writing any data.
            if (index === 0 && error instanceof AppError && error.code === "UNKNOWN_ACTION")
              break;
            if (!unconfirmedPhotoRequest(error)) throw error;
            if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
            await this.call("fileUploadPart", part).catch((retryError) => {
              if (unconfirmedPhotoRequest(retryError))
                throw new AppError("PHOTO_PART_UNAVAILABLE", "P03 照片分段上传失败");
              throw retryError;
            });
          }
          onUploadProgress?.(index + 1, total);
          if (index + 1 === total) {
            if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
            const finalize = { receipt, visibility, header, ...managed };
            try {
              return await this.call<{ id: string }>("fileUploadCommit", finalize);
            } catch (error) {
              if (!unconfirmedPhotoRequest(error)) throw error;
              if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
              return this.call<{ id: string }>("fileUploadCommit", finalize);
            }
          }
        }
      }
      if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
      return this.call<{ id: string }>("filePut", { envelope, visibility, receipt, ...managed });
    };
    let fileId: string;
    try {
      ({ id: fileId } = await upload());
    } catch (error) {
      if (!unconfirmedPhotoRequest(error)) throw error;
      if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
      const status = await this.call<{ id: string | null }>("fileUploadStatus", { receipt })
        .catch(() => null);
      if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
      if (!status)
        throw new AppError("PHOTO_STATUS_UNAVAILABLE", "P02 云端状态查询失败");
      if (!status.id)
        throw new AppError("PHOTO_NOT_CONFIRMED", "P01 云端暂未查到照片");
      fileId = status.id;
    }
    return fileId;
  }
  async readPhoto(photo: Attachment, visibility: Visibility, active?: () => boolean): Promise<string> {
    if (photo.sample) return `/assets/${photo.sample}.svg`;
    return b64(await this.readPhotoBytes(photo, visibility, active));
  }
  async readPhotoBytes(photo: Attachment, visibility: Visibility, active?: () => boolean): Promise<Uint8Array> {
    const session = this.secrets;
    const space = this.space;
    if (!session || !space) throw new AppError("LOCKED", "请先解锁");
    this.requirePrivateAccess(visibility);
    const checkSession = () => {
      if (this.secrets !== session || this.space?.id !== space.id || (active && !active()))
        throw new AppError("PHOTO_CACHE_EXPIRED", "照片缓存已过期");
    };
    const fileId = photo.fileId;
    if (fileId && this.transport.webRecordSync) {
      const cache = this.features.cipherCache;
      const scope = cipherSnapshotScope(session);
      const requestKey = JSON.stringify([fileId, photo.id, visibility]);
      let request = this.photoRequests.get(requestKey);
      if (!request) {
        request = (async () => {
          const cached = cache?.enabled ? await cache.readPhoto?.(scope, fileId).catch(() => undefined) : undefined;
          const saved = cached ?? this.recentPhotoEnvelopes.get(fileId);
          if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
          if (saved) {
            const status = await this.call<{ unchanged?: boolean; envelope?: Envelope }>("fileGet", { fileId, cached: true });
            if (status.unchanged) {
              try {
                if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
                const content = decryptPhotoBytes(saved, session, photo.id, visibility);
                if (!cached && cache?.enabled) await cache.writePhoto(scope, fileId, saved).catch(() => {});
                return content;
              } catch { /* Replace a damaged cached envelope with the server copy. */ }
            }
            if (status.envelope) return decryptPhotoBytes(status.envelope, session, photo.id, visibility);
          }
          if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
          const { envelope } = await this.call<{ envelope: Envelope }>("fileGet", { fileId });
          if (this.secrets !== session) throw new AppError("LOCKED", "请先解锁");
          const content = decryptPhotoBytes(envelope, session, photo.id, visibility);
          this.recentPhotoEnvelopes.set(fileId, envelope);
          if (this.recentPhotoEnvelopes.size > 4)
            this.recentPhotoEnvelopes.delete(this.recentPhotoEnvelopes.keys().next().value!);
          if (cache?.enabled) await cache.writePhoto(scope, fileId, envelope).catch(() => {});
          return content;
        })();
        this.photoRequests.set(requestKey, request);
        const release = () => {
          if (this.photoRequests.get(requestKey) === request) this.photoRequests.delete(requestKey);
        };
        void request.then(release, release);
      }
      const content = await request;
      checkSession();
      return content;
    }
    const segmented = active && (!photo.bytes || photo.bytes * 16 / 9 + 64 > PHOTO_DOWNLOAD_PART_SIZE);
    const { envelope } = await this.call<{
      envelope: Envelope;
      parts?: number;
    }>("fileGet", { fileId, ...(segmented ? { part: 0 } : {}) }).then(async (first) => {
      checkSession();
      if (!segmented || first.parts === undefined) return first; // Older server.
      const count = first.parts;
      if (!Number.isSafeInteger(count) || count < 1 || count > Math.ceil(1500000 / PHOTO_DOWNLOAD_PART_SIZE))
        throw new AppError("INVALID_RESPONSE", "照片分段数量不正确");
      const chunks = [first.envelope.ciphertext];
      for (let part = 1; part < count; part++) {
        const next = await this.call<{ envelope: Envelope; parts: number }>("fileGet", { fileId, part });
        checkSession();
        if (next.parts !== count)
          throw new AppError("INVALID_RESPONSE", "照片分段不完整");
        chunks.push(next.envelope.ciphertext);
      }
      return { envelope: { ...first.envelope, ciphertext: chunks.join("") } };
    });
    checkSession();
    const content = decryptPhotoBytes(envelope, session, photo.id, visibility);
    const cache = this.features.cipherCache;
    if (fileId && cache?.enabled) {
      await cache.writePhoto(cipherSnapshotScope(session), fileId, envelope).catch(() => {});
      checkSession();
    }
    return content;
  }
  async saveDraft(data: unknown, slot = "draft") {
    const session = this.secrets;
    if (!session) throw new AppError("LOCKED", "请先解锁");
    const envelope = await seal(
      data,
      unb64(session.localDraftKey ?? session.personalKey),
      `Us/draft/${session.userId}${slot === "draft" ? "" : `/${slot}`}`,
      this.rng,
    );
    if (this.secrets !== session) throw new AppError("LOCKED", "草稿未保存，请重新解锁");
    this.storage.set(slot, JSON.stringify(envelope));
  }
  loadDraft<T>(slot = "draft"): T | null {
    const draft = this.storage.get(slot);
    return draft && this.secrets
      ? open<T>(
          JSON.parse(draft),
          unb64(this.secrets.localDraftKey ?? this.secrets.personalKey),
          `Us/draft/${this.userId}${slot === "draft" ? "" : `/${slot}`}`,
        )
      : null;
  }
  async devices() {
    return this.call<Device[]>("listDevices");
  }
  async transfer(to: Device, verifiedFingerprint: string) {
    if (
      fingerprint(to) !==
      verifiedFingerprint.trim().toUpperCase().replace(/\s+/g, " ")
    )
      throw new AppError(
        "FINGERPRINT_MISMATCH",
        "安全码不匹配，请与对方当面或通过可信渠道核对",
      );
    await this.call("putTransfer", {
      transfer: await createTransfer(
        this.secrets!,
        to.id,
        to.encryptionPublicKey,
        this.rng,
        this.space!.keyVersion,
      ),
    });
    this.secrets!.trustedDevices = {
      ...this.secrets!.trustedDevices,
      [to.id]: fingerprint(to),
    };
    await this.persistSecrets();
  }
  async receive(verifiedFingerprint: string) {
    const session = this.secrets;
    if (!session) throw new AppError("LOCKED", "请先解锁");
    const devices = await this.devices();
    const transfers = await this.call<KeyTransfer[]>("getTransfers");
    const t = transfers
      .sort((a, b) => b.keyVersion - a.keyVersion)
      .find((t) =>
        devices.some(
          (d) =>
            d.id === t.fromDevice &&
            fingerprint(d) ===
              verifiedFingerprint.trim().toUpperCase().replace(/\s+/g, " "),
        ),
      );
    if (!t) throw new AppError("KEY_NOT_FOUND", "尚未收到匹配此安全码的密钥包");
    if (this.secrets !== session)
      throw new AppError("LOCKED", "会话已改变，请重新解锁");
    const sender = devices.find((d) => d.id === t.fromDevice)!;
    this.secrets = acceptTransfer(t, this.secrets!, sender.signingPublicKey);
    this.secrets.trustedDevices = {
      ...this.secrets.trustedDevices,
      [sender.id]: fingerprint(sender),
    };
    await this.persistSecrets();
    await this.call("ackTransfer", { transferId: t.id });
    await this.refresh();
  }
  async rotateKey() {
    if (!this.secrets || !this.space) throw new AppError("LOCKED", "请先解锁");
    this.space = await this.call<Space>("getSpace");
    const previous = this.space.keyVersion;
    const version = previous + 1;
    const devices = (await this.devices()).filter(
      (d) =>
        d.id !== this.secrets!.deviceId &&
        this.secrets!.trustedDevices?.[d.id] === fingerprint(d),
    );
    this.secrets.spaceKeys[version] = b64(await this.rng(32));
    // Persist before committing a rotation, so a dropped response cannot lose the new key.
    await this.persistSecrets();
    const transfers = await Promise.all(
      devices.map((d) =>
        createTransfer(
          this.secrets!,
          d.id,
          d.encryptionPublicKey,
          this.rng,
          version,
        ),
      ),
    );
    const commitment = hashText(this.secrets.spaceKeys[version]);
    try {
      this.space = await this.call<Space>("rotateSpaceKey", {
        expectedVersion: previous,
        keyCommitment: commitment,
        transfers,
      });
    } catch (error) {
      this.space = await this.call<Space>("getSpace");
      await this.verifyCurrentKey();
      if (
        this.space.keyVersion !== version ||
        this.space.keyCommitment !== commitment
      )
        throw error;
    }
    return devices.length;
  }
  private async verifyCurrentKey() {
    if (!this.secrets || !this.space?.keyCommitment) return;
    const version = this.space.keyVersion;
    const key = this.secrets.spaceKeys[version];
    if (key && hashText(key) !== this.space.keyCommitment) {
      delete this.secrets.spaceKeys[version];
      await this.persistSecrets();
    }
  }
  async ai(selected: string[], consentAt: number, taskId: AiTaskId) {
    const entries = this.active.filter(
      (e) =>
        selected.includes(e.id) &&
        e.visibility === "shared" &&
        e.data.kind === "memory",
    );
    if (entries.length === 0 || entries.length !== selected.length)
      throw new AppError(
        "INVALID_SELECTION",
        "请选择共同回忆，私人日记不会发送",
      );
    const text = entries
      .map((e) => `${e.data.date} ${e.data.title}\n${e.data.body || ""}`)
      .join("\n\n");
    if (!Object.prototype.hasOwnProperty.call(AI_TASKS, taskId))
      throw new AppError("INVALID_TASK", "不支持的回忆整理方式");
    if (text.length > AI_TEXT_LIMIT)
      throw new AppError(
        "AI_TEXT_TOO_LONG",
        `选中的回忆超过 ${AI_TEXT_LIMIT} 字，请减少选择`,
      );
    return this.call<{ text: string }>("aiGenerate", {
      text,
      taskId,
      consent: true,
      consentAt,
    });
  }
  async closeSpace() {
    const session = this.secrets;
    const space = await this.call<Space>("closeSpace");
    if (!session || session !== this.secrets)
      throw new AppError("LOCKED", "会话已改变，请重新解锁");
    this.space = space;
    await this.refresh();
  }
  async cancelClose() {
    const session = this.secrets;
    const space = await this.call<Space>("cancelClose");
    if (!session || session !== this.secrets)
      throw new AppError("LOCKED", "会话已改变，请重新解锁");
    this.space = space;
    await this.refresh();
  }
  lock() {
    this.syncSnapshot = undefined;
    this.decodedRecords.clear();
    this.decodedKeys = undefined;
    this.photoRequests.clear();
    this.recentPhotoEnvelopes.clear();
    this.binaryPhotos = false;
    this.activeSource = undefined;
    this.activeEntries = [];
    this.initialDevicePending = false;
    this.displayNames = new Map();
    this.profileGeneration++;
    ++this.lockSerial;
    ++this.refreshSerial;
    this.mutations.clear();
    this.lastSyncedAt = 0;
    this.lastSyncError = "";
    this.syncStorageWarning = "";
    this.secrets = null;
    this.vaultKey?.key.fill(0);
    this.vaultKey = null;
    this.entries = [];
    this.unreadable = 0;
    this.space = null;
  }
  async seedDemo() {
    const day = today();
    const memories: Payload[] = [
      {
        kind: "memory",
        title: "把平凡的日子，过成喜欢的样子",
        body: "拐进街角那家小店，点了两杯热拿铁。阳光刚好落在你手边，连发呆都变得很美好。",
        date: addDays(day, -1),
        tags: ["日常", "咖啡约会"],
        mood: "很开心",
        photos: [
          {
            id: "sample-coffee",
            name: "咖啡时光",
            mime: "image/svg+xml",
            bytes: 0,
            sample: "coffee",
          },
        ],
      },
      {
        kind: "memory",
        title: "一起收集一场橘子味的日落",
        body: "没有什么特别的安排，只是牵着手一直走。原来和你在一起，普通的傍晚也会闪闪发光。",
        date: addDays(day, -4),
        tags: ["晚霞", "散步"],
        mood: "被治愈",
        photos: [
          {
            id: "sample-sunset",
            name: "湖边日落",
            mime: "image/svg+xml",
            bytes: 0,
            sample: "sunset",
          },
        ],
      },
      {
        kind: "memory",
        title: "下一次，还要和你一起看海",
        body: "把海风、浪花，还有你笑起来的样子，都好好存进今天。",
        date: addDays(day, -10),
        tags: ["旅行", "海边"],
        photos: [
          {
            id: "sample-sea",
            name: "看海",
            mime: "image/svg+xml",
            bytes: 0,
            sample: "sea",
          },
        ],
      },
    ];
    for (const data of memories) await this.save(data);
    await this.save({
      kind: "wish",
      title: "一起去看一场日出",
      body: "带上热咖啡和相机",
      date: day,
      priority: "很想实现",
      confirmedBy: [this.userId],
    });
    await this.save({
      kind: "wish",
      title: "做一顿只有我们知道的拿手菜",
      date: day,
      completedAt: day,
    });
    await this.save({
      kind: "anniversary",
      title: "第一次说喜欢你",
      date: addDays(day, 12),
      yearly: true,
    });
    await this.save({
      kind: "date",
      title: "周末的慢慢散步计划",
      date: addDays(day, 2),
      location: "公园与街角咖啡店",
      budget: "100",
      body: "先散步，再去吃那家一直想吃的小店。",
    });
    await this.save({
      kind: "capsule",
      title: "写给下一个冬天的我们",
      body: "希望到时候，我们还会为很多很小的事情开心。",
      date: day,
      unlockDate: addDays(day, 32),
      needsBoth: false,
      category: "未来信件",
    });
    await this.save({
      kind: "place",
      title: "五大道的慢时光",
      body: "走走停停，发现新的小店。",
      city: "天津",
      date: addDays(day, -1),
      category: "城市",
      latitude: 39.113,
      longitude: 117.204,
    });
    await this.save({
      kind: "place",
      title: "把海风留在这里",
      city: "青岛",
      body: "下次还想再来",
      date: addDays(day, -10),
      category: "旅行",
      latitude: 36.067,
      longitude: 120.382,
    });
    await this.save({
      kind: "mood",
      title: "今天想和你一起发呆",
      mood: "很开心",
      date: day,
    });
  }
}
