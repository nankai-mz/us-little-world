import { fitPhoto, type PreparedPhoto } from "../src/core/photos";

function fileSize(path: string): Promise<number> {
  return new Promise((resolve, reject) =>
    wx
      .getFileSystemManager()
      .getFileInfo({
        filePath: path,
        success: (result) => resolve(result.size),
        fail: reject,
      }),
  );
}
function imageMime(type: string) {
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      } as Record<string, string>
    )[type.toLowerCase()] || ""
  );
}
async function inspect(path: string): Promise<PreparedPhoto<string>> {
  const [info, size] = await Promise.all([
    wx.getImageInfo({ src: path }),
    fileSize(path),
  ]);
  return {
    value: path,
    size,
    width: info.width,
    height: info.height,
    mime: imageMime(info.type),
  };
}
export async function prepareNativePhoto(path: string) {
  const generated = new Set<string>();
  const cleanup = () => {
    for (const file of generated)
      try {
        wx.getFileSystemManager().unlinkSync(file);
      } catch {}
  };
  try {
    const source = await inspect(path);
    const image = await fitPhoto(source, async (width, height, quality) => {
      const result = await wx.compressImage({
        src: path,
        quality,
        compressedWidth: width,
        compressedHeight: height,
      });
      if (result.tempFilePath !== path) generated.add(result.tempFilePath);
      return inspect(result.tempFilePath);
    });
    return { ...image, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
