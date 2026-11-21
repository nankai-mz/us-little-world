export type BookDraft = {
  period: "month" | "year" | "custom";
  month: string;
  year: string;
  from: string;
  to: string;
  title: string;
  note: string;
  selected: string[];
};

export function newBookDraft(day: string): BookDraft {
  return { period: "month", month: day.slice(0, 7), year: day.slice(0, 4), from: `${day.slice(0, 7)}-01`, to: day,
    title: "我们的回忆纪念册", note: "", selected: [] };
}
