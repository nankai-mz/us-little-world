import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const listener = (e: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog || [...document.querySelectorAll('[aria-modal="true"]')].at(-1) !== dialog) return;
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const focusables = [...dialog.querySelectorAll<HTMLElement>(
          'button,input,textarea,select,details > summary:first-of-type,[tabindex],a[href]',
        )].filter((element) => !element.matches(":disabled") && !element.closest("[inert]") &&
          (element.tabIndex >= 0 || (element.tagName === "SUMMARY" && !element.hasAttribute("tabindex"))) &&
          element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible");
        if (!focusables.length) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!active || !dialog.contains(active) || active === dialog || (e.shiftKey ? active === first : active === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <button className="icon-button close" onClick={close} aria-label="关闭">
          <X size={20} />
        </button>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
