import { useEffect, useRef, useState } from "react";
import type { UsService } from "../../../src/core/service";
import { activities } from "../../../src/features/play-core/catalog";
import type { PhotoReference } from "../../../src/features/play-core/media-games";
import { withWorkCover, type WorkContent } from "../../../src/features/play-core/works";
import { CanvasWorkCover } from "./CanvasBoard";
import { usePlayPhoto } from "./MediaRoom";

function PhotoCover({ service, reference, symbol }: { service: UsService; reference: PhotoReference; symbol: string }) {
  const allowed = service.active.some((entry) => entry.visibility === "shared" && entry.id === reference.recordId &&
    entry.data.photos?.some(({ fileId }) => fileId === reference.fileId));
  const src = usePlayPhoto(service, allowed ? reference : null);
  return src ? <img src={src} alt="" decoding="async" /> : <span>{symbol}</span>;
}

export function WorkCover({ service, data }: { service: UsService; data: WorkContent | null }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    if (typeof IntersectionObserver !== "function") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const symbol = data ? activities[data.activityId].icon : "·";
  const cover = visible && data ? withWorkCover(data).cover : undefined;
  return <div ref={element} className="play-work-cover" data-section={data ? activities[data.activityId].section : undefined} aria-hidden="true">
    {cover?.kind === "photo" ? <PhotoCover service={service} reference={cover} symbol={symbol} /> :
      cover?.kind === "canvas" && data?.canvas ? <CanvasWorkCover service={service} work={data.canvas} panel={cover.panel} /> :
        <span>{symbol}</span>}
  </div>;
}
