import { useEffect, useState } from "react";
import { addDays, spaceDay, today } from "../src/core/date";

export function useCalendarDay(hosted: boolean) {
  const calendar = hosted ? spaceDay : today;
  const [day, setDay] = useState(calendar);
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      const now = new Date();
      const date = calendar(now);
      setDay(date);
      const midnight = hosted
        ? Date.parse(`${addDays(date, 1)}T00:00:00+08:00`)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      // Recheck the wall clock even if the system time changed without a page event.
      timer = window.setTimeout(refresh, Math.min(60_000, Math.max(1, midnight - now.getTime())));
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [calendar, hosted]);
  return day;
}
