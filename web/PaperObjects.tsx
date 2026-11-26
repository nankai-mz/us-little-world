import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { CalendarDays, Mail, MapPin, ReceiptText, Ticket } from "lucide-react";
import { dateLabel } from "../src/core/date";
import { stampNames } from "../src/core/keepsakes";
import type { Payload } from "../src/core/types";

export function MealSlip({ receipt, date, names, userId }: {
  receipt: NonNullable<Payload["mealReceipt"]>; date: string; names?: ReadonlyMap<string, string>; userId?: string;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const impression = JSON.stringify(receipt.stamps ?? {});
  useLayoutEffect(() => {
    if (!sheet.current?.querySelector(".ink-stamp") || document.documentElement.dataset.motion === "reduced" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.from(".ink-stamp", { scale: 1.14, y: -3, duration: .2, ease: "power2.out", clearProps: "transform" });
    }, sheet);
    return () => context.revert();
  }, [impression]);
  return <div ref={sheet} className="meal-slip" aria-label="餐桌小票">
    <div className="slip-line"><span><ReceiptText size={15}/> 双人餐桌</span><time>{dateLabel(date)}</time></div>
    <strong className="slip-dish">{receipt.dish}</strong>
    <div className="slip-line slip-total"><span>{receipt.meal}</span><span>两位</span></div>
    {Object.entries(receipt.stamps ?? {}).map(([id, stamp]) => <span className="ink-stamp" key={id}>{names?.get(id) || (id === userId ? "我" : "对方")} · {stampNames[stamp]}</span>)}
  </div>;
}

export function RecordPaper({ data, reveal = false }: { data: Payload; reveal?: boolean }) {
  const ticket = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!reveal || !ticket.current || document.documentElement.dataset.motion === "reduced" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.from(".ticket-counter", { x: -10, opacity: .5, duration: .28, ease: "power2.out", clearProps: "transform,opacity" });
    }, ticket);
    return () => context.revert();
  }, [data.kind, reveal]);
  if (data.kind === "date") return <div ref={ticket} className="date-ticket paper-preview">
    <div><span><Ticket size={15}/> 双人约会票</span><strong>{data.title.trim() || "想约你去……"}</strong>
      <small>{data.location?.trim() || "地点待定"}</small></div>
    <div className="ticket-counter"><time>{data.date.slice(5).replace("-", ".")}</time><small>{data.completedAt ? "已赴约" : "入场联"}</small></div>
  </div>;
  if (data.kind === "capsule") return <div className="letter-paper paper-preview">
    <Mail size={25}/><div><span>寄给未来的我们</span><strong>{data.title || "一封未寄的信"}</strong></div>
    <time>{data.unlockDate ? dateLabel(data.unlockDate) + " 开启" : "待写收信日"}</time>
  </div>;
  if (data.kind === "place") return <div className="postcard-paper paper-preview">
    <div><span><MapPin size={15}/> 足迹明信片</span><strong>{data.title || "从这里寄出"}</strong></div>
    <div className="postmark">{data.city || "城市"}<small>{dateLabel(data.date)}</small></div>
  </div>;
  if (data.kind === "wish" || data.kind === "anniversary") return <div className="list-paper paper-preview">
    <CalendarDays size={21}/><div><span>{data.kind === "wish" ? "我们的愿望笺" : "纪念日历"}</span><strong>{data.title || (data.kind === "wish" ? "有件事想和你一起做" : "圈出特别的一天")}</strong></div>
    <time>{dateLabel(data.date)}</time></div>;
  return null;
}
