import {
  AppError,
  type Attachment,
  type CipherRecord,
  type Device,
  type Entry,
  type KeyTransfer,
  type Payload,
  type RandomSource,
  type Secrets,
  type Space,
  type StorageAdapter,
  type Transport,
  type Vault,
  type Visibility,
} from "./types";
import {
  acceptTransfer,
  b64,
  createTransfer,
  decryptRecord,
  encryptRecord,
  fingerprint,
  hashText,
  lockVault,
  newSecrets,
  open,
  publicKeys,
  randomId,
  recoverVault,
  seal,
  unb64,
  unlockVault,
} from "./crypto";
import { addDays, dayNumber, today } from "./date";
import { canOpenCapsule, newPet, petAction, QUESTIONS } from "./domain";
import { API_PROTOCOL, type ConnectionStatus } from "./protocol";
import { base64ByteLength, MAX_PHOTO_BYTES } from "./photos";

export class UsService {
  secrets: Secrets | null = null;
  space: Space | null = null;
  entries: Entry[] = [];
  unreadable = 0;
  lastSyncedAt = 0;
  lastSyncError = "";
  private refreshSerial = 0;
  private mutationSerial = 0;
  private mutations = new Map<
    string,
    { serial: number; entry: Entry | null }
  >();
  private password = "";
  constructor(
    public transport: Transport,
    public storage: StorageAdapter,
    public rng: RandomSource,
  ) {}
  get userId() {
    return this.secrets?.userId || "";
  }
  get ready() {
    return (
      !!this.secrets &&
      !!this.space &&
      !!this.secrets.spaceKeys[this.space.keyVersion]
    );
  }
  get active() {
    return this.entries.filter((e) => !e.deletedAt);
  }
  get vault(): Vault | null {
    const v = this.storage.get("vault");
    return v ? JSON.parse(v) : null;
  }
  async persistSecrets() {
    if (!this.secrets || !this.password)
      throw new AppError("LOCKED", "请先解锁");
    const { vault, recoveryKey } = await lockVault(
      this.secrets,
      this.password,
      this.rng,
    );
    this.storage.set("vault", JSON.stringify(vault));
    return recoveryKey;
  }
  async unlock(password: string) {
    if (!this.vault) throw new AppError("KEY_NOT_FOUND", "本机尚未建立密钥");
    this.secrets = await unlockVault(this.vault, password);
    this.password = password;
    await this.bootstrap();
  }
  async recover(vault: Vault, recoveryKey: string, password: string) {
    if (password.length < 10)
      throw new AppError("WEAK_PASSWORD", "解锁口令至少需要 10 位");
    const recovered = recoverVault(vault, recoveryKey);
    const boot = await this.transport.call<{
      userId: string;
      space: Space | null;
    }>("bootstrap");
    if (
      boot.userId !== recovered.userId ||
      boot.space?.id !== recovered.spaceId
    )
      throw new AppError("IDENTITY_MISMATCH", "备份不属于当前账号和空间");
    if (boot.space.status !== "active")
      throw new AppError("SPACE_CLOSED", "这个空间已经关闭，无法恢复云端访问");
    this.secrets = recovered;
    this.password = password;
    this.space = boot.space;
    this.secrets.deviceId = await randomId(this.rng); // A recovered device never reuses a revoked device ID.
    this.secrets.encryptionSecret = b64(await this.rng(32));
    this.secrets.signingSecret = b64(await this.rng(32));
    await this.registerDevice();
    await this.persistSecrets();
    if (this.ready) await this.refresh();
  }
  async bootstrap() {
    const boot = await this.transport.call<{
      userId: string;
      space: Space | null;
    }>("bootstrap");
    if (this.secrets && this.secrets.userId !== boot.userId) {
      this.lock();
      throw new AppError("IDENTITY_MISMATCH", "恢复包不属于当前微信账号");
    }
    this.space = boot.space;
    if (this.space?.status === "closed") {
      this.lock();
      throw new AppError("SPACE_CLOSED", "这个空间已经关闭，云端访问已停止");
    }
    if (this.secrets && this.space?.status === "active") {
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
    if (password.length < 10)
      throw new AppError("WEAK_PASSWORD", "解锁口令至少需要 10 位");
    const boot = await this.transport.call<{
      userId: string;
      space: Space | null;
    }>("bootstrap");
    if (boot.space)
      throw new AppError("ALREADY_BOUND", "当前账号已有空间，请恢复密钥");
    this.secrets = await newSecrets(this.rng, boot.userId);
    this.password = password;
    this.space = await this.transport.call<Space>("createSpace");
    this.secrets.spaceId = this.space.id;
    this.secrets.spaceKeys["1"] = b64(await this.rng(32));
    const recovery = await this.persistSecrets();
    await this.registerDevice();
    await this.save({
      kind: "anniversary",
      title,
      body: demo ? "小予 & 阿辰" : "我 & 你",
      date: startDate,
      category: "relationship",
      yearly: true,
    });
    await this.save(
      { kind: "pet", title: "糯米的小屋", date: today(), pet: newPet() },
      "shared",
      undefined,
      hashText(this.space.id + "/pet"),
    );
    if (demo) await this.seedDemo();
    return recovery;
  }
  async join(password: string, token: string) {
    if (password.length < 10)
      throw new AppError("WEAK_PASSWORD", "解锁口令至少需要 10 位");
    const { userId } = await this.transport.call<{ userId: string }>(
      "bootstrap",
    );
    this.secrets = await newSecrets(this.rng, userId);
    this.password = password;
    this.space = await this.transport.call<Space>("joinSpace", {
      token: token.trim(),
    });
    this.secrets.spaceId = this.space.id;
    const recoveryKey = await this.persistSecrets();
    await this.registerDevice();
    return recoveryKey;
  }
  async registerDevice() {
    if (!this.secrets || !this.space) return;
    await this.transport.call("registerDevice", {
      spaceId: this.space.id,
      id: this.secrets.deviceId,
      ...publicKeys(this.secrets),
      label: "我的设备",
    });
  }
  async call<T>(action: string, data: Record<string, unknown> = {}) {
    if (!this.secrets || !this.space) throw new AppError("LOCKED", "请先解锁");
    return this.transport.call<T>(action, {
      ...data,
      spaceId: this.space.id,
      deviceId: this.secrets.deviceId,
    });
  }
  async refresh() {
    const session = this.secrets;
    const serial = ++this.refreshSerial;
    const startedAtMutation = this.mutationSerial;
    if (!session || !this.space) throw new AppError("LOCKED", "请先解锁");
    try {
      const space = await this.call<Space>("getSpace");
      if (this.secrets !== session || serial !== this.refreshSerial) return;
      this.space = space;
      await this.verifyCurrentKey();
      if (this.secrets !== session || serial !== this.refreshSerial) return;
      let offset: number | null = 0;
      const rows: CipherRecord[] = [];
      do {
        const page: { records: CipherRecord[]; nextOffset: number | null } =
          await this.call("listRecords", { offset });
        rows.push(...page.records);
        offset = page.nextOffset;
        if (this.secrets !== session || serial !== this.refreshSerial) return;
      } while (offset !== null);
      const entries: Entry[] = [];
      let unreadable = 0;
      for (const r of rows) {
        try {
          entries.push({ ...r, data: decryptRecord<Payload>(r, session) });
        } catch {
          unreadable++;
        }
      }
      const merged = new Map(entries.map((entry) => [entry.id, entry]));
      for (const [id, mutation] of this.mutations) {
        if (mutation.serial > startedAtMutation) {
          if (mutation.entry) merged.set(id, mutation.entry);
          else merged.delete(id);
        } else this.mutations.delete(id);
      }
      this.entries = [...merged.values()].sort(
        (a, b) =>
          b.data.date.localeCompare(a.data.date) || b.createdAt - a.createdAt,
      );
      this.unreadable = unreadable;
      this.lastSyncedAt = Date.now();
      this.lastSyncError = "";
    } catch (error) {
      if (this.secrets === session && serial === this.refreshSerial)
        this.lastSyncError =
          error instanceof Error ? error.message : "同步暂时不可用";
      throw error;
    }
  }
  async checkConnection(): Promise<ConnectionStatus> {
    const status = await this.transport.call<ConnectionStatus>("health");
    if (status.protocol !== API_PROTOCOL)
      throw new AppError(
        "PROTOCOL_MISMATCH",
        "云端接口版本不匹配，请更新小程序与云函数",
      );
    return status;
  }
  private rememberMutation(id: string, entry: Entry | null) {
    this.mutations.set(id, { serial: ++this.mutationSerial, entry });
  }
  async save(
    data: Payload,
    visibility: Visibility = "shared",
    existing?: Entry,
    fixedId?: string,
  ) {
    if (!this.secrets || !this.space) throw new AppError("LOCKED", "请先解锁");
    const session = this.secrets;
    if (!data.title.trim())
      throw new AppError("TITLE_REQUIRED", "写个小标题吧");
    dayNumber(data.date);
    if (data.kind === "capsule") dayNumber(data.unlockDate || "");
    if (
      existing &&
      data.kind === "memory" &&
      (data.title !== existing.data.title || data.body !== existing.data.body)
    )
      data = {
        ...data,
        history: [
          ...(existing.data.history || []),
          {
            at: Date.now(),
            title: existing.data.title,
            body: existing.data.body || "",
          },
        ].slice(-10),
      };
    const meta = {
      id: existing?.id || fixedId || (await randomId(this.rng)),
      spaceId: this.space.id,
      creatorId: existing?.creatorId || this.userId,
      visibility: existing?.visibility || visibility,
      revision: existing?.revision || 0,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const record = await encryptRecord(
      meta,
      data,
      this.secrets,
      this.rng,
      this.space.keyVersion,
    );
    const saved = await this.call<CipherRecord>("putRecord", {
      record,
      expectedRevision: meta.revision,
    });
    if (this.secrets !== session)
      throw new AppError(
        "SESSION_CHANGED",
        "当前会话已锁定，记录未重新显示；解锁后请刷新查看云端保存结果",
      );
    const entry = { ...saved, data };
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
    const session = this.secrets;
    const saved = await this.call<CipherRecord>(
      restore ? "restoreRecord" : "deleteRecord",
      {
        recordId: entry.id,
        expectedRevision: entry.revision,
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
    const session = this.secrets;
    await this.call("purgeRecord", {
      recordId: entry.id,
      expectedRevision: entry.revision,
    });
    if (this.secrets !== session)
      throw new AppError("SESSION_CHANGED", "当前会话已锁定，请解锁后刷新");
    this.rememberMutation(entry.id, null);
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    for (const p of entry.data.photos || [])
      if (p.fileId) await this.call("fileDelete", { fileId: p.fileId });
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
    date = today(),
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
    const date = today();
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
    if (!canOpenCapsule(e, this.space!.members))
      throw new AppError(
        "CAPSULE_LOCKED",
        "还没到开启的时候，把期待留给未来吧",
      );
    return this.save({ ...e.data, openedAt: Date.now() }, "shared", e);
  }
  async addPhoto(
    bytes: string,
    mime: string,
    name: string,
    visibility: Visibility,
  ): Promise<Attachment> {
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
      throw new AppError("INVALID_IMAGE", "支持 JPG、PNG 和 WebP 图片");
    if (base64ByteLength(bytes) > MAX_PHOTO_BYTES)
      throw new AppError("FILE_TOO_LARGE", "请使用小于 500 KB 的照片");
    const photoId = await randomId(this.rng);
    const aad = `Us/file/1/${this.space!.id}/${photoId}/${visibility}`;
    const version = this.space!.keyVersion;
    const key = unb64(
      visibility === "private"
        ? this.secrets!.personalKey
        : this.secrets!.spaceKeys[version],
    );
    const envelope = await seal({ base64: bytes }, key, aad, this.rng, version);
    const { id: fileId } = await this.call<{ id: string }>("filePut", {
      envelope,
      visibility,
    });
    return {
      id: photoId,
      fileId,
      name,
      mime,
      bytes: base64ByteLength(bytes),
    };
  }
  async readPhoto(photo: Attachment, visibility: Visibility): Promise<string> {
    if (photo.sample) return `/assets/${photo.sample}.svg`;
    const { envelope } = await this.call<{
      envelope: import("./types").Envelope;
    }>("fileGet", { fileId: photo.fileId });
    const key = unb64(
      visibility === "private"
        ? this.secrets!.personalKey
        : this.secrets!.spaceKeys[envelope.keyVersion],
    );
    return open<{ base64: string }>(
      envelope,
      key,
      `Us/file/1/${this.space!.id}/${photo.id}/${visibility}`,
    ).base64;
  }
  async saveDraft(data: unknown) {
    if (!this.secrets) return;
    const envelope = await seal(
      data,
      unb64(this.secrets.personalKey),
      `Us/draft/${this.userId}`,
      this.rng,
    );
    this.storage.set("draft", JSON.stringify(envelope));
  }
  loadDraft<T>(): T | null {
    const draft = this.storage.get("draft");
    return draft && this.secrets
      ? open<T>(
          JSON.parse(draft),
          unb64(this.secrets.personalKey),
          `Us/draft/${this.userId}`,
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
    const sender = devices.find((d) => d.id === t.fromDevice)!;
    this.secrets = acceptTransfer(t, this.secrets!, sender.signingPublicKey);
    this.secrets.trustedDevices = {
      ...this.secrets.trustedDevices,
      [sender.id]: fingerprint(sender),
    };
    await this.persistSecrets();
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
  async ai(selected: string[], consentAt: number, task: string) {
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
    return this.call<{ text: string }>("aiGenerate", {
      text,
      task,
      consent: true,
      consentAt,
    });
  }
  lock() {
    ++this.refreshSerial;
    this.mutations.clear();
    this.lastSyncedAt = 0;
    this.lastSyncError = "";
    this.secrets = null;
    this.password = "";
    this.entries = [];
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
