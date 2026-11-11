import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pageFactory } from "../miniprogram/controller";
import { clearDecryptedFiles, photoPath, service } from "../miniprogram/platform";
import { prepareNativePhoto } from "../miniprogram/media";
import { newSecrets } from "../src/core/crypto";
import type { Attachment, Entry, Secrets } from "../src/core/types";

vi.mock("../miniprogram/platform", () => ({
  service: { secrets: null, ready: false, addPhoto: vi.fn(), saveDraft: vi.fn() },
  photoPath: vi.fn().mockResolvedValue("cached.jpg"),
  cachedPhotoPath: vi.fn(() => ""),
  clearDecryptedFiles: vi.fn(),
  isTestSpace: true,
}));
vi.mock("../miniprogram/media", () => ({ prepareNativePhoto: vi.fn() }));

const photo = { id: "photo", fileId: "file", mime: "image/jpeg" } as Attachment;
const cleanup = vi.fn();
const chooseMedia = vi.fn();
const showToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  service.secrets = {} as Secrets;
  vi.mocked(service.addPhoto).mockResolvedValue(photo);
  vi.mocked(prepareNativePhoto).mockResolvedValue({
    value: "compressed.jpg", mime: "image/jpeg", size: 3, width: 1, height: 1, cleanup,
  });
  vi.stubGlobal("wx", {
    getStorageSync: () => "",
    chooseMedia,
    showToast,
    getFileSystemManager: () => ({ readFileSync: () => "YWJj" }),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function selectWhileHidden() {
  const page = pageFactory("workspace") as any;
  page.setData = (patch: object) => Object.assign(page.data, patch);
  page.refresh = vi.fn(async () => {});
  page.onLoad({ view: "editor", kind: "memory" });
  page.data.viewModel.form = { kind: "memory", body: "draft", photos: [] };
  page.data.viewModel.visibility = "shared";
  type Selection = { tempFiles: { tempFilePath: string }[] };
  let finishSelection!: (value: Selection) => void;
  const selected = new Promise<Selection>((resolve) => {
    finishSelection = resolve;
  });
  chooseMedia.mockReturnValueOnce(selected);
  const adding = page.addPhoto();
  await vi.waitFor(() => expect(chooseMedia).toHaveBeenCalledOnce());
  page.onHide();
  finishSelection({ tempFiles: [{ tempFilePath: "selected.jpg" }] });
  await Promise.resolve();
  return { page, adding };
}

it("相册先返回选图结果、页面后触发 onShow 时，继续加密上传并更新草稿", async () => {
  const { page, adding } = await selectWhileHidden();
  expect(prepareNativePhoto).not.toHaveBeenCalled();
  expect(showToast).not.toHaveBeenCalled();
  await page.onShow();
  await adding;
  expect(service.addPhoto).toHaveBeenCalledWith("YWJj", "image/jpeg", "照片", "shared", expect.any(Function));
  expect(page.data.viewModel.form).toMatchObject({ body: "draft", photos: [photo] });
  expect(service.saveDraft).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(page.data.viewModel.busy).toBe(false);
});

it("相册返回时若会话已锁定，或页面已卸载，就丢弃选图结果", async () => {
  const locked = await selectWhileHidden();
  service.secrets = null;
  await locked.page.onShow();
  await locked.adding;
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("会话已锁定") }));
  expect(service.addPhoto).not.toHaveBeenCalled();

  chooseMedia.mockClear();
  showToast.mockClear();
  service.secrets = {} as Secrets;
  const exited = await selectWhileHidden();
  exited.page.onUnload();
  await exited.adding;
  expect(service.addPhoto).not.toHaveBeenCalled();
  expect(showToast).not.toHaveBeenCalled();
});

it("首页只读取封面，较慢的封面不会阻挡另一篇日记的封面", async () => {
  service.secrets = await newSecrets(async (size) => new Uint8Array(size).fill(7), "user", "space");
  const entries = ["first", "second"].map((id) => ({
    id, visibility: "shared", creatorId: "user",
    data: { kind: "memory", date: "2026-11-11", title: id, photos: [
      { ...photo, id: id + "-cover" }, { ...photo, id: id + "-extra" },
    ] },
  })) as Entry[];
  Object.assign(service, { entries, active: entries, space: { id: "space", members: ["user"] }, userId: "user" });
  let finishFirst!: (url: string) => void;
  vi.mocked(photoPath).mockReturnValueOnce(new Promise<string>((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce("second.jpg");
  const page = pageFactory("home") as any;
  page.setData = vi.fn((patch: object) => Object.assign(page.data, patch));
  page.onLoad();
  await page.refresh();
  await vi.waitFor(() => expect(page.setData).toHaveBeenCalledWith(expect.objectContaining({
    "viewModel.recent[1].coverPhotoUrl": "second.jpg",
  })));
  expect(vi.mocked(photoPath).mock.calls.map((call) => call[1].id)).toEqual(["first-cover", "second-cover"]);
  page.onUnload();
  finishFirst("first.jpg");
  await Promise.resolve();
  expect(page.setData).not.toHaveBeenCalledWith(expect.objectContaining({
    "viewModel.recent[0].coverPhotoUrl": "first.jpg",
  }));
  expect(clearDecryptedFiles).not.toHaveBeenCalled();
});
