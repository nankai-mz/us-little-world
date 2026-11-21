export function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
let spaceCalendar: Intl.DateTimeFormat | undefined;
export function spaceDay(now = new Date()): string {
  spaceCalendar ??= new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = spaceCalendar.formatToParts(now);
  const value = (part: string) => parts.find(({ type }) => type === part)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function dayNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("日期格式应为 YYYY-MM-DD");
  const [y, m, d] = date.split("-").map(Number);
  const n = Date.UTC(y, m - 1, d);
  const v = new Date(n);
  if (
    v.getUTCFullYear() !== y ||
    v.getUTCMonth() !== m - 1 ||
    v.getUTCDate() !== d
  )
    throw new Error("无效的日历日期");
  return n / 86400000;
}
export function daysBetween(from: string, to: string = today()): number {
  return dayNumber(to) - dayNumber(from);
}
export function togetherDays(start: string, end = today()): number {
  return Math.max(0, daysBetween(start, end) + 1);
}
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function nextAnniversary(
  date: string,
  yearly = true,
  now = today(),
): string {
  dayNumber(date);
  if (!yearly) return date;
  const monthDay = date.slice(5);
  let year = Number(now.slice(0, 4));
  function occurrence(y: number) {
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return `${y}-${monthDay === "02-29" && !leap ? "02-28" : monthDay}`;
  }
  if (occurrence(year) < now) year++;
  return occurrence(year);
}
export function dateLabel(date: string) {
  return date.replace(/-/g, ".");
}
