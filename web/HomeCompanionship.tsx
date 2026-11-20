import { Heart } from "lucide-react";
import { onThisDay, thoughtId } from "../src/core/companionship";
import { dateLabel } from "../src/core/date";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";

export function HomeCompanionship({ service, day, busy, run, open }: {
  service: UsService;
  day: string;
  busy: boolean;
  run: (action: () => Promise<unknown>, success: string) => void;
  open: (entry: Entry) => void;
}) {
  const space = service.space!;
  const me = service.userId;
  const thoughts = service.active.filter((entry) => entry.visibility === "shared" && entry.data.kind === "thought");
  const own = thoughts.find((entry) => entry.id === thoughtId(space.id, me, day));
  const received = thoughts.filter((entry) => entry.creatorId !== me && !entry.data.targetId).slice(0, 3);
  const replied = own && thoughts.some((entry) => entry.creatorId !== me && entry.data.targetId === own.id);
  const memories = onThisDay(service.active, day).slice(0, 3);
  const writable = space.status === "active" && !busy;

  return (
    <>
      {space.members.length === 2 && (
        <section className="card companionship" aria-label="站内想你">
          <h2><Heart size={17} /> 想你</h2>
          <div className="inline-form">
            {own ? (
              <>
                <span>{replied ? "对方已回送" : "今天的想你已发送"}</span>
                <button className="text-button" disabled={!writable} onClick={() =>
                  run(() => service.withdrawThought(own.id), "已撤回今天的想你")
                }>撤回想你</button>
              </>
            ) : (
              <button className="secondary" disabled={!writable} onClick={() =>
                run(() => service.sendThought(day), "想你已发送")
              }>发送想你</button>
            )}
          </div>
          {received.map((entry) => {
            const reply = thoughts.find((item) => item.creatorId === me && item.data.targetId === entry.id);
            return (
              <div className="inline-form" key={entry.id}>
                <span>{dateLabel(entry.data.date)} · 对方想你</span>
                {reply ? (
                  <button className="text-button" disabled={!writable} onClick={() =>
                    run(() => service.withdrawThought(reply.id), "已撤回回送")
                  }>撤回回送</button>
                ) : (
                  <button className="text-button" disabled={!writable} onClick={() =>
                    run(() => service.sendThought(day, entry.id), "已回送一条想你")
                  }>回送</button>
                )}
              </div>
            );
          })}
        </section>
      )}
      {memories.length > 0 && (
        <section className="card companionship" aria-label="那年今日">
          <h2>那年今日</h2>
          {memories.map((entry) => (
            <button key={entry.id} className="text-button" onClick={() => open(entry)}>
              {dateLabel(entry.data.date)} · {entry.data.title}
            </button>
          ))}
        </section>
      )}
    </>
  );
}
