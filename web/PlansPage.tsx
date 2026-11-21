import { CalendarDays, Check, Coffee, Flower2, Heart, MapPin, MoreHorizontal, Plus, Star } from "lucide-react";
import { dateLabel, daysBetween, nextAnniversary } from "../src/core/date";
import type { UsService } from "../src/core/service";
import type { Entry } from "../src/core/types";

export function PlansPage({ section, setSection, entries, day, service, edit, run }: {
  section: string;
  setSection: (section: string) => void;
  entries: Entry[];
  day: string;
  service: UsService;
  edit: (kind: string, entry?: Entry) => void;
  run: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const readOnly = service.space?.status !== "active";
  return (
    <>
        <div className="toolbar">
          <div className="pills">
            {[
              ["wishes", "愿望清单"],
              ["anniversaries", "特别的日子"],
              ["dates", "约会计划"],
            ].map(([id, name]) => (
              <button
                className={section === id ? "selected" : ""}
                onClick={() => setSection(id)}
                key={id}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            className="primary"
            disabled={readOnly}
            onClick={() =>
              edit(
                section === "anniversaries"
                  ? "anniversary"
                  : section === "dates"
                    ? "date"
                    : "wish",
              )
            }
          >
            <Plus size={16} /> 添加一份期待
          </button>
        </div>
        <div className="feature-banner plan-banner">
          <Flower2 size={54} />
          <div>
            <span className="eyebrow">ONE LITTLE WISH AT A TIME</span>
            <h2>慢慢来，我们还有好多以后</h2>
            <p>不必急着全部实现，一起期待的过程也很美好。</p>
          </div>
        </div>
        <div className="cards-grid">
          {entries
            .filter(
              (e) =>
                e.data.kind ===
                (section === "anniversaries"
                  ? "anniversary"
                  : section === "dates"
                    ? "date"
                    : "wish"),
            )
            .map((e) => (
              <article
                className={`plan-card ${e.data.completedAt ? "completed" : ""}`}
                key={e.id}
              >
                <div className="plan-card-top">
                  <span className="quick-icon tone-0">
                    {section === "anniversaries" ? (
                      <CalendarDays size={22} />
                    ) : section === "dates" ? (
                      <Coffee size={22} />
                    ) : (
                      <Star size={22} />
                    )}
                  </span>
                  <button
                    className="icon-button"
                  disabled={readOnly}
                    aria-label={
                      e.data.category === "relationship"
                        ? "修改恋爱开始日期"
                        : "编辑计划"
                    }
                    onClick={() => edit(e.data.kind, e)}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </div>
                <h3>
                  {e.data.category === "relationship"
                    ? "恋爱纪念日"
                    : e.data.title}
                </h3>
                <p>
                  {e.data.category === "relationship"
                    ? `恋爱开始日期：${dateLabel(e.data.date)} · 用于计算首页在一起天数`
                    : e.data.body ||
                      (section === "anniversaries"
                        ? "记得这些特别的小日子"
                        : "一起期待，也一起慢慢实现")}
                </p>
                {section === "anniversaries" ? (
                  <div className="plan-count">
                    <strong>
                      {Math.abs(daysBetween(day, nextAnniversary(e.data.date, e.data.yearly, day)))}
                    </strong>
                    <span>
                      {nextAnniversary(e.data.date, e.data.yearly, day) < day ? "天前" :
                        nextAnniversary(e.data.date, e.data.yearly, day) === day ? "天 · 就在今天" : "天后"} ·{" "}
                      {dateLabel(
                        nextAnniversary(e.data.date, e.data.yearly, day),
                      )}
                    </span>
                  </div>
                ) : section === "dates" ? (
                  <div className="date-details">
                    <span>
                      <CalendarDays size={14} />
                      {dateLabel(e.data.date)}
                    </span>
                    <span>
                      <MapPin size={14} />
                      {e.data.location || "地点慢慢商量"}
                    </span>
                    {e.data.budget && <span>预算 ¥{e.data.budget}</span>}
                  </div>
                ) : (
                  <>
                    <span className="wish-priority">
                      {e.data.priority || "小小期待"}
                    </span>
                    <div className="plan-card-bottom">
                      <button
                        className="text-button"
                        disabled={readOnly}
                        onClick={() =>
                          run(
                            () =>
                              service.save(
                                {
                                  ...e.data,
                                  confirmedBy: [
                                    ...new Set([
                                      ...(e.data.confirmedBy || []),
                                      service.userId,
                                    ]),
                                  ],
                                },
                                "shared",
                                e,
                              ),
                            "这份期待里，也有了你的确认",
                          )
                        }
                      >
                        <Heart size={14} />{" "}
                        {e.data.confirmedBy?.includes(service.userId)
                          ? "我也想去"
                          : "一起期待"}
                      </button>
                      <button
                        className="text-button"
                        disabled={readOnly}
                        onClick={() =>
                          run(
                            () =>
                              service.save(
                                {
                                  ...e.data,
                                  completedAt: e.data.completedAt
                                    ? undefined
                                    : day,
                                },
                                "shared",
                                e,
                              ),
                            e.data.completedAt
                              ? "已放回期待清单"
                              : "又多了一份美好回忆",
                          )
                        }
                      >
                        <Check size={14} />
                        {e.data.completedAt ? "已经实现" : "标记实现"}
                      </button>
                    </div>
                  </>
                )}
              </article>
            ))}
        </div>
      </>
  );
}
