import "./polyfill";
import { service, photoPath, clearDecryptedFiles } from "./platform";
import { config } from "./config";
import {
  AppError,
  type Attachment,
  type Device,
  type Entry,
  type Payload,
  type Visibility,
} from "../src/core/types";
import {
  addDays,
  today,
  togetherDays,
  daysBetween,
  nextAnniversary,
} from "../src/core/date";
import {
  canOpenCapsule,
  QUESTIONS,
  report,
  secureChoice,
} from "../src/core/domain";
import { fingerprint, publicKeys } from "../src/core/crypto";
import { prepareNativePhoto } from "./media";
import { entryView, navigationTitle } from "./presentation";
import {
  dailyQuestion,
  dailyQuiz,
  QUESTION_BANK,
  QUESTION_CATEGORIES,
  QUIZ_BANK,
  QUIZ_CATEGORIES,
} from "../src/core/questions";

const defaults: Record<string, string> = {
  home: "home",
  memories: "timeline",
  interaction: "games",
  plans: "wishes",
  profile: "profile",
  workspace: "editor",
};
const names: Record<string, string> = {
  feed: "喂食",
  pat: "摸摸",
  play: "玩耍",
  sleep: "休息",
};
function vm(page: any, patch: Record<string, unknown>) {
  if (page._unloaded) return;
  const next = { ...page.data.viewModel, ...patch };
  page.setData({ viewModel: next });
  const title = navigationTitle(
    next.screen,
    next.form?.kind || page._kind,
    next.form?.category === "relationship",
  );
  if (
    page._navTitle !== title &&
    typeof wx.setNavigationBarTitle === "function"
  ) {
    page._navTitle = title;
    wx.setNavigationBarTitle({ title });
  }
}
function feedback(page: any, text: string, type: string) {
  if (page._hidden || page._unloaded || !service.secrets) return;
  if (page._effectTimer) clearTimeout(page._effectTimer);
  vm(page, { effectText: text, effectType: type });
  page._effectTimer = setTimeout(() => {
    if (!page._hidden) vm(page, { effectText: "", effectType: "" });
  }, 1500);
}
async function work(page: any, fn: () => Promise<void>) {
  if (page.data.viewModel.busy) return;
  vm(page, { busy: true, error: "" });
  try {
    await fn();
  } catch (e: any) {
    if (page._unloaded) return;
    vm(page, { error: e.message || "暂时没有成功，请再试一次" });
    wx.showToast({ title: e.message || "请稍后再试", icon: "none" });
  } finally {
    if (!page._unloaded) vm(page, { busy: false });
  }
}
async function confirm(content: string, title = "温柔提醒") {
  return (
    await wx.showModal({
      title,
      content,
      confirmText: "确认",
      cancelText: "再等等",
    })
  ).confirm;
}
async function shareJson(name: string, value: unknown) {
  const filePath = `${wx.env.USER_DATA_PATH}/${name}.json`;
  wx.getFileSystemManager().writeFileSync(
    filePath,
    JSON.stringify(value, null, 2),
    "utf8",
  );
  await wx.shareFileMessage({ filePath, fileName: `${name}.json` });
}
export function pageFactory(
  pageName: string,
): WechatMiniprogram.Page.Options<Record<string, any>, Record<string, any>> {
  return {
    data: {
      viewModel: {
        page: pageName,
        screen: defaults[pageName],
        ready: false,
        authMode: "welcome",
        busy: false,
        error: "",
        configured: !!config.cloudEnv,
        day: today(),
        form: {},
        password: "",
        title: "我们的小世界",
        startDate: today(),
        invite: "",
        filter: "全部",
        search: "",
        answer: "",
        code: "",
        result: "",
        rouletteOptions: "去公园散步\n一起做晚饭\n看一部电影\n探索一家咖啡店",
        aiSelected: [],
        aiConsent: false,
        aiPreview: false,
        stats: {},
        reportMode: "month",
        mapConsent: false,
        currentDevice: "",
        recoveryKey: "",
        photoPaths: [],
        editorPhotos: [],
        reduceMotion: !!wx.getStorageSync("us.reduceMotion"),
        spinning: false,
        wheelRotation: 0,
        questionCategory: "全部",
        quizCategory: "全部",
        customQuestion: "",
      },
    },
    onLoad(this: any, query: Record<string, string>) {
      this._unloaded = false;
      this._page = pageName;
      this._entryId = query.id;
      this._kind = query.kind || "memory";
      vm(this, {
        screen: query.view || defaults[pageName],
        selectedQuestionId: query.view === "question" ? query.id || "" : "",
      });
    },
    async onShow(this: any) {
      this._hidden = false;
      if (service.ready)
        await work(this, async () => {
          await service.refresh();
        });
      await this.refresh();
    },
    async onPullDownRefresh(this: any) {
      await work(this, async () => {
        if (service.ready) await service.refresh();
        await this.refresh();
      });
      wx.stopPullDownRefresh();
    },
    onHide(this: any) {
      this._hidden = true;
      if (this._effectTimer) clearTimeout(this._effectTimer);
      if (this._spinTimer) {
        clearTimeout(this._spinTimer);
        this._finishSpin?.();
      }
      vm(this, { effectText: "", effectType: "", spinning: false });
    },
    onUnload(this: any) {
      this._unloaded = true;
      this._hidden = true;
      this._refreshEpoch = (this._refreshEpoch || 0) + 1;
      if (this._effectTimer) clearTimeout(this._effectTimer);
      if (this._spinTimer) {
        clearTimeout(this._spinTimer);
        this._finishSpin?.();
      }
      if (this._draftTimer) clearTimeout(this._draftTimer);
      clearDecryptedFiles();
    },
    async refresh(this: any) {
      const epoch = (this._refreshEpoch = (this._refreshEpoch || 0) + 1);
      const session = service.secrets;
      if (!service.secrets || !service.space) {
        this._editorLoaded = false;
        vm(this, {
          ready: false,
          authMode: service.vault ? "unlock" : "welcome",
          entries: [],
          memories: [],
          photoPaths: [],
          detail: null,
          recent: [],
          capsules: [],
          places: [],
          events: [],
          wishes: [],
          dates: [],
          comments: [],
          trash: [],
          aiMemories: [],
          form: {},
          editorPhotos: [],
          questionHistory: [],
          answerRows: [],
          pet: null,
          petEntry: null,
          effectText: "",
          effectType: "",
        });
        return;
      }
      const v = this.data.viewModel;
      const entries = service.active;
      const relationship = entries.find(
        (e: Entry) =>
          e.data.kind === "anniversary" && e.data.category === "relationship",
      );
      const memories = entries.filter(
        (e: Entry) =>
          e.data.kind === "memory" &&
          (!v.search ||
            `${e.data.date} ${e.data.title} ${e.data.body} ${e.data.tags?.join(" ")}`.includes(
              v.search,
            )) &&
          (v.filter === "全部" ||
            (v.filter === "共同回忆" && e.visibility === "shared") ||
            (v.filter === "私人日记" && e.visibility === "private") ||
            (v.filter === "收藏" &&
              e.data.favoriteBy?.includes(service.userId))),
      );
      const detail = service.entries.find((e) => e.id === this._entryId);
      const month = today().slice(0, 7);
      const from =
        v.reportMode === "year"
          ? `${today().slice(0, 4)}-01-01`
          : `${month}-01`;
      const petEntry = entries.find((e: Entry) => e.data.kind === "pet");
      const moodSymbols: Record<string, string> = {
        很开心: "☀",
        被治愈: "☁",
        想你了: "💌",
        有点累: "☾",
        想聊聊天: "☕",
        需要独处: "🌿",
      };
      const myMood = entries.find(
        (entry) =>
          entry.data.kind === "mood" && entry.creatorId === service.userId,
      )?.data.mood;
      const partnerMood = entries.find(
        (entry) =>
          entry.data.kind === "mood" && entry.creatorId !== service.userId,
      )?.data.mood;
      const moodText = (mood: string | undefined, fallback: string) =>
        mood ? `${moodSymbols[mood] || "☁"} ${mood}` : fallback;
      const selectedQuestion = entries.find(
        (entry) => entry.id === v.selectedQuestionId,
      );
      const selectedQuiz =
        QUIZ_BANK.find((quiz) => quiz.id === v.selectedQuizId) || dailyQuiz();
      const q = dailyQuestion().text;
      const currentQuestion =
        v.screen === "quiz"
          ? selectedQuestion?.data.kind === "quiz"
            ? selectedQuestion.data.title
            : selectedQuiz.title
          : v.screen === "truth"
            ? v.question || q
            : selectedQuestion?.data.title || q;
      const questionDate = selectedQuestion?.data.date || today();
      const answerEntry = entries.find(
        (e: Entry) =>
          e.data.kind === (v.screen === "quiz" ? "quiz" : "question") &&
          e.data.date === questionDate &&
          e.data.title === currentQuestion,
      );
      const answerRows = Object.entries(answerEntry?.data.answers || {})
        .filter(
          ([u]) =>
            u === service.userId ||
            Object.keys(answerEntry?.data.answers || {}).length === 2,
        )
        .map(([u, a]) => ({
          user: u === service.userId ? "我" : "对方",
          answer: a,
        }));
      const events = entries
        .filter((e) => e.data.kind === "anniversary")
        .map((e) => ({
          ...e,
          countdown: Math.max(
            0,
            daysBetween(today(), nextAnniversary(e.data.date, e.data.yearly)),
          ),
        }));
      vm(this, {
        ready: true,
        hasSharedKey: service.ready,
        currentDevice: service.secrets.deviceId,
        userId: service.userId,
        spaceMembers: service.space.members.length,
        unreadable: service.unreadable,
        name: relationship?.data.title || "我们的小世界",
        relationshipId: relationship?.id || "",
        startDate: relationship?.data.date || today(),
        together: togetherDays(relationship?.data.date || today()),
        entries,
        memories,
        recent: memories.filter((e) => e.visibility === "shared").slice(0, 5),
        capsules: entries
          .filter((e) => e.data.kind === "capsule")
          .map((e) => ({
            ...e,
            remaining: Math.max(
              0,
              daysBetween(today(), e.data.unlockDate || today()),
            ),
            canOpen: canOpenCapsule(e, service.space!.members),
            confirmed: e.data.confirmedBy?.includes(service.userId),
          })),
        places: entries.filter((e) => e.data.kind === "place"),
        events,
        wishes: entries.filter((e) => e.data.kind === "wish"),
        dates: entries.filter((e) => e.data.kind === "date"),
        petEntry,
        pet: petEntry?.data.pet,
        petLevel: Math.floor((petEntry?.data.pet?.exp || 0) / 80) + 1,
        question: currentQuestion,
        questionDate,
        quizOptions: selectedQuiz.options,
        questionCategories: ["全部", ...QUESTION_CATEGORIES],
        questionBank: QUESTION_BANK.filter(
          (question) =>
            !v.questionCategory ||
            v.questionCategory === "全部" ||
            question.category === v.questionCategory,
        ),
        quizCategories: ["全部", ...QUIZ_CATEGORIES],
        quizBank: QUIZ_BANK.filter(
          (quiz) =>
            !v.quizCategory ||
            v.quizCategory === "全部" ||
            quiz.category === v.quizCategory,
        ),
        selectedQuizId: selectedQuiz.id,
        questionHistory: entries
          .filter((entry) => ["question", "quiz"].includes(entry.data.kind))
          .map((entry) => ({
            ...entry,
            answerCount: Object.keys(entry.data.answers || {}).length,
          })),
        moods: ["很开心", "被治愈", "想你了", "有点累", "想聊聊天", "需要独处"],
        myMood: moodText(myMood, "今天感觉怎么样？"),
        partnerMood: moodText(partnerMood, "还没有分享"),
        stats: report(entries, from, today()),
        lastSynced: service.lastSyncedAt
          ? new Date(service.lastSyncedAt).toLocaleString()
          : "尚未刷新",
        syncError: service.lastSyncError,
        answerRows,
        answerCount: Object.keys(answerEntry?.data.answers || {}).length,
        history:
          detail?.data.history?.map((h) => ({
            ...h,
            time: new Date(h.at).toLocaleString(),
          })) || [],
        detail:
          detail && detail.data.kind === "capsule" && !detail.data.openedAt
            ? null
            : detail,
        comments: entries.filter(
          (e) => e.data.kind === "comment" && e.data.targetId === detail?.id,
        ),
        trash: service.entries.filter((e) => e.deletedAt),
        aiMemories: entries
          .filter((e) => e.data.kind === "memory" && e.visibility === "shared")
          .map((e) => ({ ...e, selected: v.aiSelected.includes(e.id) })),
        fingerprint: fingerprint(publicKeys(service.secrets)),
      });
      if (v.screen === "editor" && !this._editorLoaded) {
        this._editorLoaded = true;
        const draft =
          !detail && this._kind === "memory" ? service.loadDraft<any>() : null;
        vm(this, {
          form: detail?.data ||
            draft?.form || {
              kind: this._kind === "relationship" ? "anniversary" : this._kind,
              ...(this._kind === "relationship"
                ? { category: "relationship" }
                : {}),
              title: this._kind === "relationship" ? "我们的小世界" : "",
              body: "",
              date: today(),
              unlockDate: addDays(today(), 30),
              photos: [],
              tags: [],
              yearly: true,
            },
          visibility: detail?.visibility || draft?.visibility || "shared",
          editing: !!detail,
          tagsText: (detail?.data.tags || draft?.form?.tags || []).join("，"),
        });
      }
      if (v.screen === "security") {
        try {
          vm(this, {
            devices: (await service.devices()).map((d) => ({
              ...d,
              fingerprint: fingerprint(d),
            })),
          });
        } catch {}
      }
      // Decrypted photo paths are temporary and removed on hide/unload/lock.
      const shown =
        detail && v.screen === "detail"
          ? [detail]
          : v.screen === "home"
            ? memories
                .filter((entry) => entry.visibility === "shared")
                .slice(0, 5)
            : ["timeline", "album"].includes(v.screen)
              ? memories
              : [];
      const form = this.data.viewModel.form;
      const photoEntries =
        v.screen === "editor"
          ? [
              {
                data: form,
                visibility: this.data.viewModel.visibility,
              } as Entry,
            ]
          : shown;
      const paths: Record<string, string> = {};
      for (const e of photoEntries)
        for (const p of e.data.photos || []) {
          if (
            this._hidden ||
            service.secrets !== session ||
            epoch !== this._refreshEpoch
          )
            break;
          try {
            paths[p.id] = await photoPath(e, p);
          } catch {}
        }
      if (this._hidden || service.secrets !== session) clearDecryptedFiles();
      else if (epoch === this._refreshEpoch)
        vm(this, {
          photoPaths: paths,
          memories: memories.map((entry) => entryView(entry, paths)),
          recent: memories
            .filter((entry) => entry.visibility === "shared")
            .slice(0, 5)
            .map((entry) => entryView(entry, paths)),
          detail:
            detail && (detail.data.kind !== "capsule" || detail.data.openedAt)
              ? entryView(detail, paths)
              : null,
          editorPhotos: (form?.photos || []).map((photo: Attachment) => ({
            ...photo,
            url: paths[photo.id] || "",
          })),
        });
    },
    input(this: any, e: any) {
      const field = e.currentTarget.dataset.field;
      vm(this, { [field]: e.detail.value });
      if (field === "search") this.refresh();
    },
    formInput(this: any, e: any) {
      const field = e.currentTarget.dataset.field;
      const value = e.detail.value;
      const form = { ...this.data.viewModel.form, [field]: value };
      vm(this, { form });
      if (this._kind === "memory" && !this._entryId) {
        if (this._draftTimer) clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(
          () =>
            service
              .saveDraft({
                form: this.data.viewModel.form,
                visibility: this.data.viewModel.visibility,
              })
              .catch(() => {}),
          600,
        );
      }
    },
    toggle(this: any, e: any) {
      const field = e.currentTarget.dataset.field;
      vm(this, { [field]: e.detail.value });
    },
    formToggle(this: any, e: any) {
      const field = e.currentTarget.dataset.field;
      vm(this, {
        form: { ...this.data.viewModel.form, [field]: e.detail.value },
      });
    },
    visibility(this: any, e: any) {
      if (
        this.data.viewModel.busy ||
        this._entryId ||
        this.data.viewModel.form.photos?.length
      )
        return;
      vm(this, { visibility: e.detail.value ? "private" : "shared" });
    },
    authMode(this: any, e: any) {
      vm(this, { authMode: e.currentTarget.dataset.mode, error: "" });
    },
    async authenticate(this: any) {
      await work(this, async () => {
        const v = this.data.viewModel;
        let recoveryKey = "";
        if (v.authMode === "unlock") await service.unlock(v.password);
        else if (v.authMode === "join")
          recoveryKey = await service.join(v.password, v.invite);
        else
          recoveryKey = await service.create(v.password, v.title, v.startDate);
        vm(this, { password: "", recoveryKey });
        if (recoveryKey) {
          await wx.showModal({
            title: "请离线备份恢复密钥",
            content: recoveryKey + "\n恢复时需要备份文件和这把密钥。",
            showCancel: false,
            confirmText: "我已记下",
          });
        }
        await this.refresh();
      });
    },
    navigate(this: any, e: any) {
      const { view, page, id, kind } = e.currentTarget.dataset;
      if (page) wx.switchTab({ url: `/pages/${page}/index` });
      else
        wx.navigateTo({
          url: `/pages/workspace/index?view=${view || "editor"}${id ? `&id=${id}` : ""}${kind ? `&kind=${kind}` : ""}`,
        });
    },
    section(this: any, e: any) {
      if (this.data.viewModel.busy) return;
      vm(this, {
        screen: e.currentTarget.dataset.view,
        result: "",
        answer: "",
        aiPreview: false,
        aiConsent: false,
        selectedQuestionId: "",
      });
      this.refresh();
    },
    filter(this: any, e: any) {
      vm(this, { filter: e.currentTarget.dataset.filter });
      this.refresh();
    },
    async save(this: any) {
      await work(this, async () => {
        if (this._draftTimer) {
          clearTimeout(this._draftTimer);
          this._draftTimer = null;
        }
        const v = this.data.viewModel;
        const form = { ...v.form };
        if (form.kind === "capsule" && form.unlockDate < today())
          throw new Error("请选择今天或之后的开启日期");
        if (form.latitude !== undefined && form.latitude !== "")
          form.latitude = Number(form.latitude);
        else delete form.latitude;
        if (form.longitude !== undefined && form.longitude !== "")
          form.longitude = Number(form.longitude);
        else delete form.longitude;
        if (
          (form.latitude !== undefined &&
            (!Number.isFinite(form.latitude) ||
              Math.abs(form.latitude) > 90)) ||
          (form.longitude !== undefined &&
            (!Number.isFinite(form.longitude) ||
              Math.abs(form.longitude) > 180))
        )
          throw new Error("坐标范围不正确");
        if (v.tagsText)
          form.tags = v.tagsText.split(/[,，]/).filter(Boolean).slice(0, 8);
        const existing = service.entries.find((e) => e.id === this._entryId);
        await service.save(form, v.visibility, existing);
        if (!existing && this._kind === "memory")
          service.storage.remove("draft");
        wx.showToast({
          title:
            form.category === "relationship"
              ? "恋爱开始日期已更新"
              : "已经好好收藏",
          icon: "success",
        });
        wx.navigateBack();
      });
    },
    async addPhoto(this: any) {
      await work(this, async () => {
        const session = service.secrets;
        const slots = 6 - (this.data.viewModel.form.photos?.length || 0);
        if (slots <= 0)
          throw new AppError("PHOTO_LIMIT", "每页最多收藏 6 张照片");
        if (typeof wx.requirePrivacyAuthorize === "function")
          await wx.requirePrivacyAuthorize({});
        const selected = await wx.chooseMedia({
          count: slots,
          mediaType: ["image"],
          sizeType: ["compressed"],
          sourceType: ["album", "camera"],
        });
        for (const f of selected.tempFiles.slice(0, slots)) {
          if (!session || service.secrets !== session || this._hidden)
            throw new Error("当前会话已锁定，请解锁后再添加照片");
          vm(this, { photoStatus: "正在整理照片，随后加密上传…" });
          const prepared = await prepareNativePhoto(f.tempFilePath);
          try {
            const bytes = wx
              .getFileSystemManager()
              .readFileSync(prepared.value, "base64") as string;
            if (service.secrets !== session) throw new Error("当前会话已锁定");
            const photo = await service.addPhoto(
              bytes,
              prepared.mime,
              "照片",
              this.data.viewModel.visibility,
            );
            if (service.secrets !== session || this._hidden)
              throw new Error("请解锁后重新查看照片");
            const form = {
              ...this.data.viewModel.form,
              photos: [...(this.data.viewModel.form.photos || []), photo],
            };
            vm(this, { form, photoStatus: "" });
            if (!this._entryId)
              await service.saveDraft({
                form,
                visibility: this.data.viewModel.visibility,
              });
            await this.refresh();
          } finally {
            prepared.cleanup();
            vm(this, { photoStatus: "" });
          }
        }
      });
    },
    async removePhoto(this: any, e: any) {
      if (this.data.viewModel.busy) return;
      const form = {
        ...this.data.viewModel.form,
        photos: (this.data.viewModel.form.photos || []).filter(
          (photo: Attachment) => photo.id !== e.currentTarget.dataset.photo,
        ),
      };
      vm(this, { form });
      if (!this._entryId)
        await service.saveDraft({
          form,
          visibility: this.data.viewModel.visibility,
        });
      await this.refresh();
    },
    async previewPhoto(this: any, e: any) {
      const path =
        this.data.viewModel.photoPaths[e.currentTarget.dataset.photo];
      if (path)
        await wx.previewImage({
          current: path,
          urls: Object.values(this.data.viewModel.photoPaths) as string[],
        });
    },
    async favorite(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (entry)
        await work(this, async () => {
          await service.favorite(entry);
          await this.refresh();
        });
    },
    async trash(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === (e.currentTarget.dataset.id || this._entryId),
      );
      if (
        !entry ||
        !(await confirm("暂时收起这条记录？之后可以从回收站恢复。"))
      )
        return;
      await work(this, async () => {
        await service.trash(entry);
        if (this._entryId) wx.navigateBack();
        else await this.refresh();
      });
    },
    async restoreEntry(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (entry)
        await work(this, async () => {
          await service.trash(entry, true);
          await this.refresh();
        });
    },
    async petAction(this: any, e: any) {
      const action = e.currentTarget.dataset.action;
      await work(this, async () => {
        await service.interact(action);
        await this.refresh();
        feedback(
          this,
          (
            {
              feed: "🥕 吃饱饱，好开心",
              pat: "♡ 收到你的摸摸",
              play: "✧ 一起玩了一小会",
              sleep: "☾ 做一个软软的梦",
            } as Record<string, string>
          )[action],
          action,
        );
        wx.showToast({ title: `${names[action]}好开心！`, icon: "none" });
      });
    },
    async renamePet(this: any) {
      const v = this.data.viewModel;
      await work(this, async () => {
        const p = v.petEntry;
        await service.save(
          {
            ...p.data,
            pet: { ...p.data.pet, name: v.petName?.trim() || "糯米" },
          },
          "shared",
          p,
        );
        await this.refresh();
      });
    },
    async decoration(this: any, e: any) {
      const id = e.currentTarget.dataset.decoration;
      await work(this, async () => {
        const p = this.data.viewModel.petEntry;
        const ds = p.data.pet.decorations;
        await service.save(
          {
            ...p.data,
            pet: {
              ...p.data.pet,
              decorations: ds.includes(id)
                ? ds.filter((d: string) => d !== id)
                : [...ds, id],
            },
          },
          "shared",
          p,
        );
        await this.refresh();
      });
    },
    async mood(this: any, e: any) {
      const mood = e.currentTarget.dataset.mood;
      await work(this, async () => {
        const old = service.active.find(
          (e) => e.data.kind === "mood" && e.creatorId === service.userId,
        );
        await service.save(
          { kind: "mood", title: mood, mood, date: today() },
          "shared",
          old,
        );
        await this.refresh();
      });
    },
    async answer(this: any) {
      await work(this, async () => {
        await service.answer(
          this.data.viewModel.question,
          this.data.viewModel.answer,
          this.data.viewModel.screen === "quiz" ? "quiz" : "question",
          this.data.viewModel.questionDate || today(),
        );
        vm(this, { answer: "" });
        await this.refresh();
      });
    },
    option(this: any, e: any) {
      vm(this, { answer: e.currentTarget.dataset.option });
    },
    async skipQuestion(this: any) {
      await work(this, async () => {
        const session = service.secrets;
        const bytes = await service.rng(64);
        if (!session || service.secrets !== session || this._hidden) return;
        vm(this, {
          question: secureChoice(QUESTIONS, bytes),
          answer: "",
          selectedQuestionId: "",
          answerRows: [],
          answerCount: 0,
          questionDate: today(),
        });
      });
    },
    async spin(this: any) {
      await work(this, async () => {
        const session = service.secrets;
        if (!session) return;
        vm(this, { result: "" });
        const options = [
          ...new Set<string>(
            this.data.viewModel.rouletteOptions
              .split("\n")
              .map((s: string) => s.trim())
              .filter(Boolean),
          ),
        ];
        const choice = secureChoice(options, await service.rng(64));
        if (service.secrets !== session || this._hidden) return;
        vm(this, {
          result: "",
          spinning: true,
          wheelRotation:
            this.data.viewModel.wheelRotation +
            1440 +
            options.indexOf(choice) * (360 / options.length),
        });
        if (
          !this.data.viewModel.reduceMotion &&
          typeof wx.vibrateShort === "function"
        )
          wx.vibrateShort({ type: "light", fail() {} });
        await new Promise<void>((resolve) => {
          this._finishSpin = resolve;
          this._spinTimer = setTimeout(
            resolve,
            this.data.viewModel.reduceMotion ? 0 : 1500,
          );
        });
        if (!this._hidden && service.secrets === session)
          vm(this, {
            spinning: false,
            ...(this.data.viewModel.screen === "roulette"
              ? { result: choice }
              : {}),
          });
      });
    },
    motionPreference(this: any, e: any) {
      wx.setStorageSync("us.reduceMotion", e.detail.value);
      vm(this, { reduceMotion: e.detail.value });
    },
    questionCategory(this: any, e: any) {
      vm(this, { questionCategory: e.currentTarget.dataset.category });
      this.refresh();
    },
    quizCategory(this: any, e: any) {
      vm(this, { quizCategory: e.currentTarget.dataset.category });
      this.refresh();
    },
    chooseQuiz(this: any, e: any) {
      vm(this, {
        selectedQuizId: e.currentTarget.dataset.id,
        selectedQuestionId: "",
        screen: "quiz",
        answer: "",
      });
      this.refresh();
    },
    quizPicker(this: any, e: any) {
      const quiz = this.data.viewModel.quizBank[Number(e.detail.value)];
      if (quiz) {
        vm(this, {
          selectedQuizId: quiz.id,
          selectedQuestionId: "",
          answer: "",
        });
        this.refresh();
      }
    },
    async chooseQuestion(this: any, e: any) {
      const question = QUESTION_BANK.find(
        (item) => item.id === e.currentTarget.dataset.id,
      );
      if (!question) return;
      await work(this, async () => {
        const entry = await service.askQuestion(
          question.text,
          question.category,
        );
        vm(this, {
          screen: "question",
          selectedQuestionId: entry.id,
          answer: "",
        });
        await this.refresh();
      });
    },
    async askCustomQuestion(this: any) {
      await work(this, async () => {
        const entry = await service.askQuestion(
          this.data.viewModel.customQuestion,
        );
        vm(this, {
          screen: "question",
          selectedQuestionId: entry.id,
          customQuestion: "",
          answer: "",
        });
        await this.refresh();
      });
    },
    openQuestion(this: any, e: any) {
      const entry = service.active.find(
        (item) => item.id === e.currentTarget.dataset.id,
      );
      if (!entry) return;
      vm(this, {
        screen: entry.data.kind === "quiz" ? "quiz" : "question",
        selectedQuestionId: entry.id,
        selectedQuizId: QUIZ_BANK.find(
          (quiz) => quiz.title === entry.data.title,
        )?.id,
        answer: "",
      });
      this.refresh();
    },
    async wishAction(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (!entry) return;
      await work(this, async () => {
        const complete = e.currentTarget.dataset.action === "complete";
        await service.save(
          {
            ...entry.data,
            ...(complete
              ? { completedAt: entry.data.completedAt ? undefined : today() }
              : {
                  confirmedBy: [
                    ...new Set([
                      ...(entry.data.confirmedBy || []),
                      service.userId,
                    ]),
                  ],
                }),
          },
          "shared",
          entry,
        );
        await this.refresh();
      });
    },
    async capsuleAction(this: any, e: any) {
      const session = service.secrets;
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (!entry) return;
      await work(this, async () => {
        if (e.currentTarget.dataset.action === "confirm")
          await service.confirmCapsule(entry);
        else {
          const opened = entry.data.openedAt
            ? entry
            : await service.openCapsule(entry);
          if (!entry.data.openedAt && !this.data.viewModel.reduceMotion) {
            feedback(this, "✉ 这份温柔，终于抵达", "capsule");
            await new Promise<void>((resolve) => setTimeout(resolve, 650));
          }
          if (this._hidden || !session || service.secrets !== session) return;
          wx.navigateTo({
            url: `/pages/workspace/index?view=detail&id=${opened.id}`,
          });
        }
        await this.refresh();
      });
    },
    async comment(this: any) {
      const entry = service.entries.find((e) => e.id === this._entryId);
      if (!entry || !this.data.viewModel.comment?.trim()) return;
      await work(this, async () => {
        await service.save(
          {
            kind: "comment",
            title: "回忆留言",
            body: this.data.viewModel.comment.trim(),
            date: today(),
            targetId: entry.id,
          },
          entry.visibility,
        );
        vm(this, { comment: "" });
        await this.refresh();
      });
    },
    async randomMemory(this: any) {
      const memories = service.active.filter(
        (e) => e.data.kind === "memory" && e.visibility === "shared",
      );
      if (!memories.length)
        return wx.showToast({ title: "先留下一条回忆吧", icon: "none" });
      const random = await service.rng(1);
      wx.navigateTo({
        url: `/pages/workspace/index?view=detail&id=${memories[random[0] % memories.length].id}`,
      });
    },
    async map(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (
        entry?.data.latitude === undefined ||
        entry?.data.longitude === undefined
      )
        return wx.showToast({ title: "这是一个文字地点", icon: "none" });
      if (
        !(await confirm(
          "地图服务会处理该地点的名称与坐标。是否继续？",
          "打开外部地图",
        ))
      )
        return;
      await wx.openLocation({
        latitude: entry.data.latitude,
        longitude: entry.data.longitude,
        name: entry.data.title,
        scale: 14,
      });
    },
    async chooseLocation(this: any) {
      if (
        !(await confirm(
          "选点会调用微信地图服务，相关位置数据会交给地图服务处理。你也可以只填写文字地点。",
          "主动选择地点",
        ))
      )
        return;
      await work(this, async () => {
        if (typeof wx.requirePrivacyAuthorize === "function")
          await wx.requirePrivacyAuthorize({});
        const place = await wx.chooseLocation({});
        vm(this, {
          form: {
            ...this.data.viewModel.form,
            title: place.name,
            body: place.address,
            latitude: place.latitude,
            longitude: place.longitude,
          },
        });
      });
    },
    reportMode(this: any, e: any) {
      vm(this, { reportMode: e.currentTarget.dataset.mode });
      this.refresh();
    },
    async exportReport(this: any) {
      if (
        !(await confirm(
          "报告会导出为可直接阅读的 JSON，文件包含共同回忆文字，请妥善保存。",
        ))
      )
        return;
      await work(this, async () =>
        shareJson(`Us-回忆报告-${today()}`, this.data.viewModel.stats),
      );
    },
    aiSelect(this: any, e: any) {
      vm(this, {
        aiSelected: e.detail.value,
        aiPreview: false,
        aiConsent: false,
      });
      this.refresh();
    },
    aiPreview(this: any) {
      const ids = this.data.viewModel.aiSelected;
      vm(this, {
        aiText: service.active
          .filter(
            (e) =>
              ids.includes(e.id) &&
              e.visibility === "shared" &&
              e.data.kind === "memory",
          )
          .map((e) => `${e.data.date} ${e.data.title}\n${e.data.body || ""}`)
          .join("\n\n"),
        aiPreview: true,
        aiConsent: false,
      });
    },
    async aiGenerate(this: any) {
      await work(this, async () => {
        const v = this.data.viewModel;
        if (!v.aiConsent) throw new Error("请先预览并确认本次授权");
        vm(this, { aiConsent: false });
        const r = await service.ai(
          v.aiSelected,
          Date.now(),
          "根据选中的回忆整理自然温柔的故事，不评价关系，不捏造经历",
        );
        vm(this, { result: r.text });
      });
    },
    async aiSave(this: any) {
      await work(this, async () => {
        await service.save({
          kind: "memory",
          title: "我们的回忆故事",
          body: this.data.viewModel.result,
          date: today(),
          tags: ["AI 整理", "已审核"],
        });
        vm(this, { result: "" });
        await this.refresh();
      });
    },
    async checkConnection(this: any) {
      vm(this, { connectionChecked: false });
      await work(this, async () => {
        const status = await service.checkConnection();
        vm(this, {
          connectionChecked: true,
          connectionTitle:
            status.mode === "cloud" ? "云端连接正常" : "本机存储可用",
        });
        wx.showToast({ title: "连接检查通过", icon: "success" });
      });
    },
    async syncNow(this: any) {
      vm(this, { connectionChecked: false });
      await work(this, async () => {
        await service.checkConnection();
        await service.refresh();
        await this.refresh();
        vm(this, { connectionChecked: true, connectionTitle: "云端连接正常" });
      });
    },
    async createInvite(this: any) {
      await work(this, async () => {
        const r = await service.call<{ token: string }>("createInvitation");
        vm(this, { invite: r.token });
      });
    },
    async copyInvite(this: any) {
      await wx.setClipboardData({ data: this.data.viewModel.invite });
    },
    async sendKey(this: any, e: any) {
      const device = this.data.viewModel.devices.find(
        (d: Device) => d.id === e.currentTarget.dataset.id,
      );
      if (device)
        await work(this, async () => {
          await service.transfer(device, this.data.viewModel.code);
          wx.showToast({ title: "加密密钥包已送达", icon: "none" });
        });
    },
    async receiveKey(this: any) {
      await work(this, async () => {
        await service.receive(this.data.viewModel.code);
        await this.refresh();
        wx.showToast({ title: "空间已安全解锁", icon: "success" });
      });
    },
    async revokeDevice(this: any, e: any) {
      if (
        !(await confirm(
          "撤销会阻止这台设备继续云访问，无法撤回之前已经解密的内容。",
        ))
      )
        return;
      await work(this, async () => {
        await service.call("revokeDevice", {
          targetDeviceId: e.currentTarget.dataset.id,
        });
        await this.refresh();
      });
    },
    async rotateKey(this: any) {
      if (
        !(await confirm(
          "新内容将使用新密钥。只向本机已核对安全码的设备发送密钥包，未核对的设备需要重新验证。旧密钥保留用于读取历史。",
          "轮换未来记录密钥",
        ))
      )
        return;
      await work(this, async () => {
        const count = await service.rotateKey();
        await this.refresh();
        wx.showToast({
          title: `已轮换，通知 ${count} 台设备接收`,
          icon: "none",
        });
      });
    },
    async purgeEntry(this: any, e: any) {
      const entry = service.entries.find(
        (x) => x.id === e.currentTarget.dataset.id,
      );
      if (
        !entry ||
        !(await confirm(
          "这会永久删除自己创建的这条记录及它引用的照片密文，无法从回收站恢复。对方已经下载的副本不受影响。",
          "永久删除这条记录",
        ))
      )
        return;
      await work(this, async () => {
        await service.purge(entry);
        await this.refresh();
      });
    },
    async backup(this: any) {
      await work(this, async () => {
        vm(this, { recoveryKey: service.secrets?.recoveryKey || "" });
        await shareJson(`Us-加密密钥备份-${today()}`, {
          format: "UsCloudKeyBackup",
          version: 1,
          vault: service.vault,
        });
      });
    },
    async exportRecords(this: any) {
      if (
        !(await confirm(
          "即将导出你可见的文字记录和照片说明，明文文件不再受应用加密保护。照片仍保存在加密云存储中。",
          "导出明文记录",
        ))
      )
        return;
      await work(this, async () =>
        shareJson(`Us-明文记录-${today()}`, service.entries),
      );
    },
    async restoreVault(this: any) {
      await work(this, async () => {
        const file = await wx.chooseMessageFile({
          count: 1,
          type: "file",
          extension: ["json"],
        });
        const raw = wx
          .getFileSystemManager()
          .readFileSync(file.tempFiles[0].path, "utf8") as string;
        const backup = JSON.parse(raw);
        if (backup.format !== "UsCloudKeyBackup" || backup.version !== 1)
          throw new Error("请选择 Us 云端密钥备份文件");
        const v = this.data.viewModel;
        await service.recover(backup.vault, v.code, v.password);
        vm(this, {
          password: "",
          code: "",
          recoveryKey: service.secrets?.recoveryKey,
        });
        await this.refresh();
      });
    },
    async lock(this: any) {
      service.lock();
      clearDecryptedFiles();
      await this.refresh();
    },
    async closeSpace(this: any) {
      if (
        !(await confirm(
          "关闭后双方均无法继续访问云空间，无法在应用内撤销。记录不会自动删除。请先导出备份。",
          "关闭双人空间",
        ))
      )
        return;
      await work(this, async () => {
        await service.call("closeSpace");
        service.lock();
        clearDecryptedFiles();
        await this.refresh();
      });
    },
  };
}
