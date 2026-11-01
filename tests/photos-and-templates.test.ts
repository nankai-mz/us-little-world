import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fitPhoto,
  fittedSize,
  base64ByteLength,
  MAX_PHOTO_BYTES,
} from "../src/core/photos";
import { prepareNativePhoto } from "../miniprogram/media";
import { entryView, navigationTitle } from "../miniprogram/presentation";
import { validateWxml } from "../scripts/wxml-check.mjs";
import type { Entry } from "../src/core/types";

afterEach(() => vi.unstubAllGlobals());
describe("照片压缩预算", () => {
  const source = {
    value: "original",
    size: 3 * 1024 * 1024,
    mime: "image/jpeg",
    width: 4000,
    height: 3000,
  };
  it("小图保留原内容，大图根据实际输出大小再决定是否上传", async () => {
    const small = { ...source, size: MAX_PHOTO_BYTES };
    const encode = vi.fn();
    expect(await fitPhoto(small, encode)).toBe(small);
    expect(encode).not.toHaveBeenCalled();
    const large = vi.fn(async (width, height) => ({
      ...source,
      value: "compressed",
      width,
      height,
      size: width > 1600 ? 600000 : 400000,
    }));
    expect((await fitPhoto(source, large)).size).toBeLessThanOrEqual(
      MAX_PHOTO_BYTES,
    );
    expect(large).toHaveBeenCalledTimes(2);
  });
  it("对忽略质量参数的 PNG 继续缩小尺寸，保持原比例且不放大", async () => {
    const sizes: number[] = [];
    const result = await fitPhoto(
      { ...source, mime: "image/png" },
      async (width, height) => {
        sizes.push(width);
        expect(width / height).toBeCloseTo(4 / 3, 1);
        return {
          ...source,
          mime: "image/png",
          width,
          height,
          size: width * height * 4,
        };
      },
    );
    expect(result.width).toBe(320);
    expect(result.size).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
    expect(
      sizes.every((size, index) => index === 0 || size < sizes[index - 1]),
    ).toBe(true);
    expect(fittedSize(100, 50, 1920)).toEqual({ width: 100, height: 50 });
  });
  it("压缩失败有界结束，不上传超限图片；超大源文件不进入编码", async () => {
    const encode = vi.fn(async () => source);
    await expect(fitPhoto(source, encode)).rejects.toMatchObject({
      code: "PHOTO_COMPRESSION_FAILED",
    });
    expect(encode).toHaveBeenCalledTimes(8);
    encode.mockClear();
    await expect(
      fitPhoto({ ...source, size: 26 * 1024 * 1024 }, encode),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    expect(encode).not.toHaveBeenCalled();
  });
  it("按 base64 实际字节数计入预算，包括末尾填充", () => {
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("YWI=")).toBe(2);
    expect(base64ByteLength("YWJj")).toBe(3);
    const bytes = Buffer.alloc(MAX_PHOTO_BYTES);
    expect(base64ByteLength(bytes.toString("base64"))).toBe(MAX_PHOTO_BYTES);
  });
  it("原生适配器检查实际文件类型和大小，清理压缩临时文件并保留原图", async () => {
    const files: Record<
      string,
      { size: number; width: number; height: number; type: string }
    > = {
      "source.png": {
        size: 4 * 1024 * 1024,
        width: 4000,
        height: 3000,
        type: "png",
      },
    };
    const deleted: string[] = [];
    const calls: any[] = [];
    vi.stubGlobal("wx", {
      getImageInfo: async ({ src }: any) => files[src],
      getFileSystemManager: () => ({
        getFileInfo: ({ filePath, success }: any) =>
          success({ size: files[filePath].size }),
        unlinkSync: (path: string) => {
          deleted.push(path);
          delete files[path];
        },
      }),
      compressImage: async (options: any) => {
        calls.push(options);
        const path = `compressed-${calls.length}.png`;
        files[path] = {
          size: calls.length === 1 ? 700000 : 400000,
          width: options.compressedWidth,
          height: options.compressedHeight,
          type: "png",
        };
        return { tempFilePath: path };
      },
    });
    const result = await prepareNativePhoto("source.png");
    expect(result.mime).toBe("image/png");
    expect(result.size).toBe(400000);
    expect(calls[0].compressedWidth).toBe(1920);
    result.cleanup();
    expect(deleted).toEqual(["compressed-1.png", "compressed-2.png"]);
    expect(files["source.png"]).toBeDefined();
  });
});
describe("原生模板与视图数据合同", () => {
  it("能识别本次缺失 Mustache 的缺陷，而不是把字符串条件判为通过", () => {
    expect(validateWxml('<view wx:if="!ready"></view>')).toHaveLength(1);
    expect(
      validateWxml("<block wx:if=\"screen === 'home'\"></block>"),
    ).toHaveLength(1);
    expect(
      validateWxml(
        '<view wx:if="{{!ready}}"><image wx:for="{{photos}}" src="{{item.url}}"/></view>',
      ),
    ).toEqual([]);
    expect(validateWxml("<view><text></view>")).not.toEqual([]);
    expect(validateWxml('<view hidden="false"/>')).not.toEqual([]);
  });
  it("封面路径和照片列表只进入视图，保持原加密载荷不被添加界面字段", () => {
    const entry = {
      id: "one",
      data: {
        kind: "memory",
        title: "test",
        date: "2026-11-01",
        photos: [{ id: "p", mime: "image/jpeg", name: "photo", bytes: 100 }],
      },
    } as Entry;
    const view = entryView(entry, { p: "/private-temp/p.jpg" });
    expect(view.coverPhotoUrl).toBe("/private-temp/p.jpg");
    expect(view.photos[0].url).toBe("/private-temp/p.jpg");
    expect(entry.data.photos![0]).not.toHaveProperty("url");
    expect(
      entryView({ ...entry, data: { ...entry.data, photos: [] } }, {})
        .coverPhotoUrl,
    ).toBe("");
  });
  it("二级页面按用途显示标题，恋爱日期入口保持明确", () => {
    expect(navigationTitle("editor", "relationship")).toBe("设置恋爱开始日期");
    expect(navigationTitle("editor", "anniversary", true)).toBe(
      "设置恋爱开始日期",
    );
    expect(navigationTitle("editor", "memory")).toBe("写一篇日记");
    expect(navigationTitle("pet")).toBe("糯米的小屋");
    expect(navigationTitle("questionBank")).toBe("话题小书架");
    expect(navigationTitle("security")).toBe("设备与安全");
  });
});
