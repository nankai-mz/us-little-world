import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { gsap } from "gsap";
import { ArrowRight, Camera, ImagePlus, LockKeyhole, RotateCcw, Ticket } from "lucide-react";
import { dateLabel } from "../src/core/date";
import { canReplyToPhoto } from "../src/core/keepsakes";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";

export function CoverCredits() {
  return <details className="cover-credits"><summary>封面摄影</summary>
    <p><a href="https://www.flickr.com/photos/vultilion/6056698931/" target="_blank" rel="noreferrer">花朵 · vultilion</a>
      {" / "}<a href="https://www.flickr.com/photos/danielbuechele/6061409035/" target="_blank" rel="noreferrer">湖畔 · Daniel Büchele</a>
      {" / "}<a href="https://creativecommons.org/licenses/by/2.0/" target="_blank" rel="noreferrer">CC BY 2.0</a>，画面已裁切。</p>
  </details>;
}

export function WelcomeCover() {
  return <section className="journal-jacket" aria-label="双人生活收集册封面" data-enter>
    <div className="jacket-brand"><b>Us<span>.</span></b><span>我们的小世界</span></div>
    <div className="jacket-page">
      <div className="jacket-print"><img src="/assets/journal-flower.jpg" alt="绿叶间盛开的一朵橘色花" fetchPriority="high" width="640" height="427" /></div>
      <h1>两个人的<br/><em>生活收集册</em></h1>
    </div>
    <div className="jacket-footer"><span><LockKeyhole size={14}/> 双人私密手账</span><CoverCredits/></div>
  </section>;
}

// A pointer hotspot is purely decorative. The card itself is an ordinary focusable button.
function PhotoCard({ front, back, label, reduced }: { front: ReactNode; back: ReactNode; label: string; reduced: boolean }) {
  const [flipped, setFlipped] = useState(false);
  const face = useRef<HTMLSpanElement>(null);
  const previousSide = useRef(flipped);
  useLayoutEffect(() => {
    if (flipped === previousSide.current) return;
    previousSide.current = flipped;
    if (reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.timeline({ defaults: { ease: "power2.out" } })
        .from(face.current, { transformPerspective: 900, rotationY: -14, y: 5, opacity: 0.84, duration: 0.32, clearProps: "transform,opacity" });
    }, face);
    return () => context.revert();
  }, [flipped, reduced]);
  return <button type="button" className="journal-photo-card" aria-label={flipped ? "翻回正面" : label}
    aria-pressed={flipped} onClick={() => setFlipped(value => !value)}
    onPointerMove={event => {
      if (reduced || event.pointerType !== "mouse") return;
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.style.setProperty("--spot-x", (event.clientX - rect.left) + "px");
      event.currentTarget.style.setProperty("--spot-y", (event.clientY - rect.top) + "px");
    }}>
    <span ref={face} className={flipped ? "journal-photo-face reverse" : "journal-photo-face"}>{flipped ? back : front}</span>
    <span className="turn-label"><RotateCcw size={15}/>{flipped ? "看正面" : "翻到背面"}</span>
  </button>;
}

export function JournalCover({ day, shared, dates, service, reduced, readOnly, open, compose }: {
  day: string; shared: Entry[]; dates: Entry[]; service: UsService; reduced: boolean; readOnly: boolean;
  open: (entry: Entry) => void; compose: () => void;
}) {
  const waiting = !readOnly && shared.find(entry => canReplyToPhoto(entry, service.userId));
  const upcoming = dates.filter(e => e.visibility === "shared" && e.data.kind === "date" && !e.data.completedAt && e.data.date >= day)
    .sort((a, b) => a.data.date.localeCompare(b.data.date))[0];
  const photo = waiting || (!upcoming ? shared.find(e => e.data.photos?.length) : undefined);
  const appointment = !photo && upcoming;
  const picture = photo?.data.photos?.[0];
  const title = photo?.data.title || (appointment ? appointment.data.title : "");
  const date = photo?.data.date || (appointment ? appointment.data.date : day);
  const body = photo ? photo.data.body || (photo.data.replyPhotoId ? "两个人的照片，收在了同一页。" : "翻到背面，看看它是哪天留下的。")
    : appointment ? appointment.data.location || "地点待商量" : "用一张照片开启今天这一页。";
  const kind = waiting ? "对方留给你的相纸" : appointment ? "下一场约会" : photo ? "从收藏册翻到" : "今天的相纸";
  return <section className="journal-cover" data-enter aria-label="今天的封面">
    <div className="journal-lead">
      <p className="journal-kicker">{appointment ? <Ticket size={16}/> : <Camera size={16}/>} {kind}</p>
      <h1>{title || <>今天，<br/>想给你<em>看这张。</em></>}</h1>
      <p className="journal-deck">{waiting ? "翻到相纸的另一面，接上你此刻看到的画面。" : body}</p>
      <button type="button" className="primary journal-cta" disabled={!photo && !appointment && readOnly}
        onClick={() => photo ? open(photo) : appointment ? open(appointment) : compose()}>
        {photo ? (waiting ? "接上我的半张" : "翻开这页回忆") : appointment ? "打开约会票" : "选一张照片"} <ArrowRight size={17}/>
      </button>
    </div>
    <div className="journal-stage">
      <PhotoCard key={photo?.id ?? (appointment ? appointment.id : "cover")} reduced={reduced} label="翻看封面背面"
        front={picture ? <SharedMemoryPhoto photo={picture} service={service} title={title}/> :
          <img src={appointment ? "/assets/journal-lake.jpg" : "/assets/journal-flower.jpg"} alt={appointment ? "湖畔楼阁的封面摄影" : "橘色花朵的封面摄影"} width="640" height="427"/>}
        back={<><span className="print-date">{dateLabel(date)}</span><strong>{title || "留给今天的你"}</strong><span>{body}</span></>}/>
    </div>
  </section>;
}

export function PhotoReplyButton({ disabled, onFile }: { disabled: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="photo-reply">
    <button type="button" className="secondary" disabled={disabled} onClick={() => input.current?.click()}><ImagePlus size={17}/> 接上我的半张</button>
    <input hidden ref={input} aria-label="选择要接上的照片" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file);
    }}/>
  </div>;
}
