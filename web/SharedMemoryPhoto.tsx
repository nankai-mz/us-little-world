import { useEffect, useState } from "react";
import { PHOTO_MIMES } from "../src/core/photos";
import type { UsService } from "../src/core/service";
import type { Attachment, Visibility } from "../src/core/types";
import { acquirePhotoUrl } from "./photoUrls";

export function SharedMemoryPhoto({ photo, service, title, onSettled, visibility = "shared", className = "" }: {
  photo: Attachment;
  service: UsService;
  title: string;
  onSettled?: (id: string) => void;
  visibility?: Visibility;
  className?: string;
}) {
  const { id, fileId, sample, mime } = photo;
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setSrc(undefined);
    setFailed(false);
    const read = async () => {
      try {
        if (sample) {
          setSrc(`/assets/${sample}.svg`);
          return;
        }
        if (!PHOTO_MIMES.includes(mime)) throw new Error("无法显示照片");
        const request = acquirePhotoUrl(service, photo, visibility);
        release = request.release;
        const url = await request.loaded;
        if (active) setSrc(url);
      } catch {
        if (active) setFailed(true);
      }
    };
    void read();
    return () => {
      active = false;
      release?.();
    };
  }, [service, id, fileId, sample, mime, visibility]);
  useEffect(() => { if (failed) onSettled?.(id); }, [failed, id, onSettled]);
  if (failed) return <p className={`photo-placeholder ${className}`}>照片暂时无法读取</p>;
  return src ? <img src={src} alt={photo.name || title} className={className} onLoad={() => onSettled?.(id)} onError={() => setFailed(true)} />
    : <p className={`photo-placeholder ${className}`}>正在读取照片</p>;
}
