import { activities, isActivityId, type ActivityId } from "../src/features/play-core/catalog";
import { playIdPattern } from "../src/features/play-core/protocol";

const pages = {
  home: { path: "/app/home", sections: [] },
  memories: { path: "/app/memories", sections: ["timeline", "album", "galaxy", "book", "capsules", "map", "report", "ai"] },
  interaction: { path: "/app/play", sections: ["games", "pet", "question", "quiz", "roulette", "truth", "food", "wardrobe"] },
  plans: { path: "/app/plans", sections: ["wishes", "anniversaries", "dates"] },
  profile: { path: "/app/settings", sections: ["overview", "devices", "backup"] },
} as const;

export type WebPage = keyof typeof pages;
type RecordTarget = { kind: "new"; photo?: boolean } | { kind: "detail" | "edit"; id: string };
export type PairingStep = "create" | "join" | "keys";
export type PlayTarget =
  | { kind: "games" | "create" | "world" | "gallery" }
  | { kind: "activity"; id: ActivityId }
  | { kind: "room" | "work"; id: string };
export type WebRoute = { page: WebPage; section: string; pathname: string; record?: RecordTarget; pairing?: PairingStep; play?: PlayTarget };
const worldRoutes = { house: "w23", planet: "c17", garden: "g14" } as const;

export function playRoute(play: PlayTarget): WebRoute {
  let suffix: string = play.kind;
  if (play.kind === "room" || play.kind === "work") suffix = `${play.kind}s/${play.id}`;
  if (play.kind === "activity") {
    const alias = Object.entries(worldRoutes).find(([, activity]) => activity === play.id)?.[0];
    suffix = `${activities[play.id].section}/${alias ?? play.id}`;
  }
  return { page: "interaction", section: "games", pathname: "/app/play/" + suffix, play };
}

export function webRoute(page: WebPage, section?: string): WebRoute {
  const { path, sections } = pages[page];
  const selected = sections.find((item) => item === section) ?? sections[0] ?? "";
  const pathname = page === "memories" && selected === "album"
    ? "/app/album"
    : selected && selected !== sections[0] ? `${path}/${selected}` : path;
  return { page, section: selected, pathname };
}

export function recordRoute(record: RecordTarget, background = webRoute("memories")): WebRoute {
  const suffix = record.kind === "new" ? "new" : record.id + (record.kind === "edit" ? "/edit" : "");
  return { ...background, pathname: `/app/memories/${suffix}`, record };
}

export function pairingRoute(step: PairingStep): WebRoute {
  return { ...webRoute("home"), pathname: `/app/pair/${step}`, pairing: step };
}

const routePaths = new Map(
  (Object.keys(pages) as WebPage[]).flatMap((page) =>
    (pages[page].sections.length ? pages[page].sections.map((section) => webRoute(page, section)) : [webRoute(page)])
      .map((route) => [route.pathname, route] as const),
  ),
);

export function parseWebRoute(pathname: string) {
  const path = pathname.replace(/\/$/, "");
  if (path === "" || path === "/app") return webRoute("home");
  if (path === "/app/memories/new") return recordRoute({ kind: "new" });
  const pairing = /^\/app\/pair\/(create|join|keys)$/.exec(path);
  if (pairing) return pairingRoute(pairing[1] as PairingStep);
  const record = /^\/app\/memories\/([a-f0-9]{32,64})(\/edit)?$/.exec(path);
  if (record) return recordRoute({ kind: record[2] ? "edit" : "detail", id: record[1] });
  const play = /^\/app\/play\/(games|create|world|gallery|rooms|works)(?:\/([a-z0-9-]+))?$/.exec(path);
  if (play) {
    const [, group, id] = play;
    if (!id && (group === "games" || group === "create" || group === "world" || group === "gallery"))
      return playRoute({ kind: group });
    if (id && (group === "rooms" || group === "works") && playIdPattern.test(id))
      return playRoute({ kind: group === "rooms" ? "room" : "work", id });
    if (group === "world" && Object.hasOwn(worldRoutes, id))
      return playRoute({ kind: "activity", id: worldRoutes[id as keyof typeof worldRoutes] });
    if (isActivityId(id) && activities[id].section === group) return playRoute({ kind: "activity", id });
    return undefined;
  }
  return routePaths.get(path);
}
