import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pageFactory } from "../miniprogram/controller";
import { service } from "../miniprogram/platform";
import { prepareNativePhoto } from "../miniprogram/media";
import type { Attachment, Secrets } from "../src/core/types";

vi.mock("../miniprogram/platform", () => ({
  service: { secrets: null, ready: false, addPhoto: vi.fn(), saveDraft: vi.fn() },
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
