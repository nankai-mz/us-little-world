import { hashText } from "./crypto";
import type { Entry } from "./types";

export function thoughtId(spaceId: string, userId: string, date: string, replyTo?: string) {
  return hashText(JSON.stringify(["Us/companionship/1", spaceId, userId, replyTo ? ["reply", replyTo] : ["thought", date]]));
}

export function onThisDay(entries: Entry[], date: string) {
  return entries.filter(({ deletedAt, visibility, data }) =>
    !deletedAt && visibility === "shared" && data.kind === "memory" &&
    data.date < date && data.date.slice(5) === date.slice(5),
  );
}
