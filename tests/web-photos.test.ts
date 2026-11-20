import { afterEach, expect, it, vi } from "vitest";
import { prepareBrowserPhoto } from "../web/photos";

afterEach(() => vi.unstubAllGlobals());

it("由文件内容识别照片，小图也重编码且释放位图和画布", async () => {
  const file = new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xe1)], "phone.jpg");
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 120, height: 80, close }));
  const encoded = new Blob(["encoded"], { type: "image/jpeg" });
  const drawImage = vi.fn();
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (callback: (blob: Blob) => void) => callback(encoded),
  };
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("document", { createElement: () => canvas });

  expect(await prepareBrowserPhoto(file)).toBe(encoded);
  expect(decode).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }), { imageOrientation: "from-image" });
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 120, 80);
  expect(close).toHaveBeenCalledOnce();
  expect(canvas).toMatchObject({ width: 0, height: 0 });
});

it("不接受改名成 JPG 的其他格式", async () => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  const file = new File(["GIF89a"], "renamed.jpg", { type: "image/jpeg" });
  await expect(prepareBrowserPhoto(file)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  expect(decode).not.toHaveBeenCalled();
});
