import { useEffect, useState } from "react";
import { unb64 } from "../src/core/crypto";
import { PHOTO_MIMES } from "../src/core/photos";
import type { UsService } from "../src/core/service";
import type { Attachment } from "../src/core/types";

export function SharedMemoryPhoto({ photo, service, title, onSettled }: {
  photo: Attachment;
  service: UsService;
  title: string;
  onSettled?: (id: string) => void;
}) {
  const { id, fileId, sample, mime } = photo;
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setSrc(undefined);
    setFailed(false);
    const read = async () => {
      try {
        if (sample) {
          setSrc(`/assets/${sample}.svg`);
          return;
        }
        if (!PHOTO_MIMES.includes(mime)) throw new Error("无法显示照片");
        const bytes = await service.readPhoto(photo, "shared", () => active);
        if (!active) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(unb64(bytes))], { type: mime }));
        setSrc(url);
      } catch {
        if (active) setFailed(true);
      }
    };
    void read();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [service, id, fileId, sample, mime]);
  useEffect(() => { if (failed) onSettled?.(id); }, [failed, id, onSettled]);
  if (failed) return <p className="photo-placeholder" role="status">照片暂时无法读取</p>;
  return src ? <img src={src} alt={photo.name || title} onLoad={() => onSettled?.(id)} onError={() => setFailed(true)} />
    : <p role="status">正在读取照片</p>;
}
