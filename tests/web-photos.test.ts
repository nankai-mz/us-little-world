import { afterEach, expect, it, vi } from "vitest";
import { prepareBrowserPhoto } from "../web/photos";
import { randomBytes } from "node:crypto";
import { decryptPhotoBytes, newSecrets } from "../src/core/crypto";
import { preparePhotoWrite } from "../src/core/photo-write";
import { MAX_PHOTO_BYTES } from "../src/core/photos";

afterEach(() => vi.unstubAllGlobals());

it("照片二进制密文减少 Base64 开销，并兼容旧照片及保持授权绑定", async () => {
  const rng = async (size: number) => randomBytes(size);
  const secrets = await newSecrets(rng, "fixture", "fixture-space");
  const bytes = new Uint8Array(await rng(MAX_PHOTO_BYTES));
  const old = await preparePhotoWrite(bytes, "image/png", "旧照片", "private", secrets, 1, rng);
  const next = await preparePhotoWrite(bytes, "image/png", "新照片", "private", secrets, 1, rng, true);
  expect(next.envelope).toMatchObject({ encoding: "bytes" });
  expect(next.envelope.ciphertext.length).toBe(4 * Math.ceil((MAX_PHOTO_BYTES + 16) / 3));
  expect(next.envelope.ciphertext.length / old.envelope.ciphertext.length).toBeLessThan(0.76);
  for (const { envelope, photo } of [old, next]) {
    expect(Buffer.from(decryptPhotoBytes(envelope, secrets, photo.id, "private")).equals(bytes)).toBe(true);
    expect(() => decryptPhotoBytes(envelope, { ...secrets, sharedOnly: true }, photo.id, "private")).toThrow();
  }
  const { encoding: _encoding, ...unmarked } = next.envelope;
  expect(() => decryptPhotoBytes(unmarked, secrets, next.photo.id, "private")).toThrow();
});

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

it.each([true, false])("大 PNG 优先保留分辨率，无 WebP 编码时继续使用 PNG（支持 WebP：%s）", async (supportsWebp) => {
  const file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)], "screen.png");
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: vi.fn((callback: (blob: Blob) => void, type: string, quality: number) => {
      const mime = supportsWebp ? type : "image/png";
      const fits = mime === "image/webp" ? quality < 0.82 : canvas.width < 1920;
      callback(new Blob([new Uint8Array(fits ? 100 : MAX_PHOTO_BYTES + 1)], { type: mime }));
    }),
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1920, height: 1080, close: vi.fn() }));
  const image = await prepareBrowserPhoto(file);
  expect(image.type).toBe(supportsWebp ? "image/webp" : "image/png");
  expect(canvas.toBlob.mock.calls.map(([, type, quality]) => [type, quality])).toEqual([
    ["image/png", 0.82], ["image/webp", 0.82], supportsWebp ? ["image/webp", 0.66] : ["image/png", 0.72],
  ]);
});
