import { useEffect, useState } from "react";
import type { UsService } from "../../../src/core/service";
import { playRoute, type PlayTarget } from "../../routes";
import { PlayClient } from "./client";

export function GalaxyWorks({ service, navigate }: { service: UsService; navigate: (target: PlayTarget) => void }) {
  const [titles, setTitles] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    const client = new PlayClient(service);
    void (async () => {
      const config = await client.config();
      if (!config.stages.includes("creative_worlds")) return;
      const works: { id: string; title: string }[] = [];
      let after: string | undefined;
      do {
        const page = await client.workList(after);
        for (const { header, data } of page.items) if (header.visibility === "shared" && data?.activityId === "c18")
          works.push({ id: header.id, title: data.title });
        after = page.next ?? undefined;
      } while (live && after);
      if (live) setTitles(works);
    })().catch(() => {});
    return () => { live = false; };
  }, [service, service.space?.id]);
  if (!titles) return null;
  const make = { kind: "activity", id: "c18" } as const;
  return <section className="card">
    <h2>我们连出的星座</h2>
    <button onClick={() => navigate(make)}>编辑共同星座</button>
    {titles.length > 0 && <ul>{titles.map(({ id, title }) => {
      const target = { kind: "work", id } as const;
      return <li key={id}><a href={playRoute(target).pathname} onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(target);
      }}>{title}</a></li>;
    })}</ul>}
  </section>;
}
