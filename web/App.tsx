import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Coffee,
  Compass,
  Feather,
  Flower2,
  Gamepad2,
  Heart,
  Home,
  ImagePlus,
  KeyRound,
  Leaf,
  LockKeyhole,
  Mail,
  MapPin,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  UserRound,
  Utensils,
  WandSparkles,
  X,
} from "lucide-react";
import { UsService } from "../src/core/service";
import { prepareBrowserPhoto } from "./photos";
import { QuestionRoom } from "./QuestionRoom";
import { dailyQuestion } from "../src/core/questions";
import { type ConnectionStatus } from "../src/core/protocol";
import {
  AppError,
  type Attachment,
  type Device,
  type Entry,
  type Payload,
  type Visibility,
} from "../src/core/types";
import {
  addDays,
  dateLabel,
  daysBetween,
  nextAnniversary,
  today,
  togetherDays,
} from "../src/core/date";
import { canOpenCapsule, report, secureChoice } from "../src/core/domain";
import { fingerprint, publicKeys } from "../src/core/crypto";
import {
  createBrowserService,
  download,
  stageBackup,
  commitBackup,
} from "./platform";

const tabs = [
  { id: "home", label: "我们的小窝", sub: "首页", icon: Home },
  { id: "memories", label: "时光手账", sub: "时光", icon: Feather },
  { id: "interaction", label: "一起玩耍", sub: "互动", icon: Gamepad2 },
  { id: "plans", label: "未来清单", sub: "计划", icon: CalendarDays },
  { id: "profile", label: "我的空间", sub: "我的", icon: UserRound },
];
const moodOptions = [
  "很开心",
  "被治愈",
  "想你了",
  "有点累",
  "想聊聊天",
  "需要独处",
];
const kindNames: Record<string, string> = {
  memory: "一页日记",
  capsule: "一封未来的信",
  place: "一处共同足迹",
  wish: "一个小愿望",
  anniversary: "一个特别日子",
  relationship: "设置恋爱开始日期",
  date: "一场约会",
};
const petActionLabels: Record<string, string> = {
  feed: "喂点好吃的",
  pat: "摸摸小脑袋",
  play: "陪它玩一会",
  sleep: "睡个好觉",
};

function Photo({
  photo,
  visibility = "shared",
  service,
  className = "",
}: {
  photo: Attachment;
  visibility?: Visibility;
  service: UsService;
  className?: string;
}) {
  const [src, setSrc] = useState(
    photo.sample ? `/assets/${photo.sample}.svg` : "",
  );
  useEffect(() => {
    let alive = true;
    if (!photo.sample)
      service
        .readPhoto(photo, visibility)
        .then((bytes) => {
          if (alive) setSrc(`data:${photo.mime};base64,${bytes}`);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [photo.id, service, visibility]);
  return src ? (
    <img src={src} alt={photo.name} className={className} />
  ) : (
    <div className={`photo-placeholder ${className}`}>
      <Camera size={28} />
      <span>照片暂时无法读取</span>
    </div>
  );
}
function Modal({
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
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const focusables = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,textarea,select,[tabindex="0"],a[href]',
        );
        if (!focusables?.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, [close]);
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
        <span className="eyebrow">A LITTLE SOMETHING FOR US</span>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function App() {
  const [service, setService] = useState<UsService | null>(null);
  const [mode, setMode] = useState<"demo" | "personal">("demo");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState("home");
  const [section, setSection] = useState("timeline");
  const [modal, setModal] = useState("");
  const [editing, setEditing] = useState<Entry | undefined>();
  const [detail, setDetail] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [password, setPassword] = useState("");
  const [spaceName, setSpaceName] = useState("我们的小世界");
  const [startDate, setStartDate] = useState(today());
  const [welcomeMode, setWelcomeMode] = useState("welcome");
  const [recovery, setRecovery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部");
  const [monthFilter, setMonthFilter] = useState("");
  const [authorFilter, setAuthorFilter] = useState("全部");
  const [tagFilter, setTagFilter] = useState("");
  const [rouletteOptions, setRouletteOptions] = useState(
    "去公园散步\n一起做晚饭\n看一部电影\n探索一家咖啡店\n窝在家里听歌\n逛逛花店",
  );
  const [roulette, setRoulette] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [wheelRotation, setWheelRotation] = useState(0);
  const [petEffect, setPetEffect] = useState("");
  const [openingCapsule, setOpeningCapsule] = useState("");
  const [reduceMotion, setReduceMotion] = useState(() =>
    localStorage.getItem("us.reduceMotion") === null
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : localStorage.getItem("us.reduceMotion") === "true",
  );
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinPending = useRef(false);
  const [aiSelected, setAiSelected] = useState<string[]>([]);
  const [aiPreview, setAiPreview] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiResult, setAiResult] = useState("");
  const [reportRange, setReportRange] = useState("month");
  const [devices, setDevices] = useState<Device[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [safetyCode, setSafetyCode] = useState("");
  const [invitation, setInvitation] = useState("");
  const [comment, setComment] = useState("");
  const [dark, setDark] = useState(localStorage.getItem("us.theme") === "dark");
  const [mapConsent, setMapConsent] = useState(false);
  const close = useCallback(() => {
    setModal("");
    setDetail(null);
    setAiPreview(false);
    setAiConsent(false);
  }, []);
  const notify = useCallback((message: string) => setToast(message), []);
  const update = () => setRevision((v) => v + 1);
  const run = async <T,>(
    fn: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> => {
    setBusy(true);
    try {
      const value = await fn();
      update();
      if (success) notify(success);
      return value;
    } catch (e) {
      notify(e instanceof Error ? e.message : "暂时没有成功，请再试一次");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("us.theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    document.documentElement.dataset.motion = reduceMotion ? "reduced" : "full";
  }, [reduceMotion]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => {
      if (localStorage.getItem("us.reduceMotion") === null)
        setReduceMotion(media.matches);
    };
    media.addEventListener("change", changed);
    return () => {
      media.removeEventListener("change", changed);
      if (spinTimer.current) clearTimeout(spinTimer.current);
      if (effectTimer.current) clearTimeout(effectTimer.current);
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    const selected = localStorage.getItem("us.mode") as
      | "demo"
      | "personal"
      | null;
    if (selected) {
      const s = createBrowserService(selected);
      setMode(selected);
      setService(s);
      const pass = sessionStorage.getItem("us.demo.password");
      if (selected === "demo" && pass && s.vault) {
        s.unlock(pass)
          .then(() => {
            if (!canceled) update();
          })
          .catch((e) => {
            if (!canceled) notify(e.message);
          });
      } else if (s.vault) setWelcomeMode("unlock");
    }
    return () => {
      canceled = true;
    };
  }, [notify]);
  useEffect(() => {
    if (!service?.ready) return;
    const id = setInterval(() => {
      service
        .refresh()
        .then(update)
        .catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [service, revision > 0]);
  useEffect(() => {
    if (!service?.ready) return;
    let hiddenAt = 0;
    const change = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 300000) {
        service.lock();
        setPassword("");
        setWelcomeMode("unlock");
        sessionStorage.removeItem("us.demo.password");
        update();
      }
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [service, revision > 0]);
  async function enterDemo() {
    await run(async () => {
      const s = createBrowserService("demo");
      const savedPassword = sessionStorage.getItem("us.demo.password");
      if (s.vault && savedPassword) await s.unlock(savedPassword);
      else {
        const all = Object.keys(localStorage).filter((k) =>
          k.startsWith("us.demo."),
        );
        all.forEach((k) => localStorage.removeItem(k));
        const fresh = createBrowserService("demo");
        const pass = crypto.randomUUID() + crypto.randomUUID();
        sessionStorage.setItem("us.demo.password", pass);
        await fresh.create(pass, "我们的小世界", addDays(today(), -519), true);
        setService(fresh);
      }
      if (s.ready) setService(s);
      setMode("demo");
      localStorage.setItem("us.mode", "demo");
      setWelcomeMode("welcome");
    });
  }
  async function createPersonal() {
    await run(async () => {
      const s = createBrowserService("personal");
      const key = await s.create(password, spaceName, startDate);
      setService(s);
      setMode("personal");
      localStorage.setItem("us.mode", "personal");
      setRecovery(key);
      setModal("recovery");
      setPassword("");
    });
  }
  const entries = service?.active || [];
  const relationship = entries.find(
    (e) => e.data.kind === "anniversary" && e.data.category === "relationship",
  );
  const memories = entries.filter((e) => e.data.kind === "memory");
  const sharedMemories = memories.filter((e) => e.visibility === "shared");
  const petEntry = entries.find((e) => e.data.kind === "pet");
  const pet = petEntry?.data.pet;
  const day = today();
  const nextEvent = entries
    .filter((e) => e.data.kind === "anniversary")
    .map((e) => ({
      ...e,
      next: nextAnniversary(e.data.date, e.data.yearly, day),
    }))
    .filter((e) => e.next >= day)
    .sort((a, b) => a.next.localeCompare(b.next))[0];
  const mood = entries.find(
    (e) => e.data.kind === "mood" && e.creatorId === service?.userId,
  );
  const partnerMood = entries.find(
    (e) => e.data.kind === "mood" && e.creatorId !== service?.userId,
  );
  const reportFrom =
    reportRange === "year"
      ? `${day.slice(0, 4)}-01-01`
      : `${day.slice(0, 7)}-01`;
  const stats = report(entries, reportFrom, day);
  function go(nextPage: string, nextSection?: string) {
    setPage(nextPage);
    if (nextSection) setSection(nextSection);
    setSearch("");
    setFilter("全部");
    setAiConsent(false);
    setAiPreview(false);
    window.scrollTo(0, 0);
  }
  function edit(kind: string, entry?: Entry) {
    setEditing(entry);
    setModal(`edit:${kind}`);
  }
  const viewEntry = (e: Entry) => {
    setDetail(e);
    setModal("detail");
  };
  async function randomMemory() {
    if (!sharedMemories.length) return notify("先留下一条回忆吧");
    const r = await service!.rng(1);
    viewEntry(sharedMemories[r[0] % sharedMemories.length]);
  }
  async function spin() {
    if (spinPending.current) return;
    spinPending.current = true;
    setSpinning(true);
    setRoulette("");
    const opts = [
      ...new Set(
        rouletteOptions
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    try {
      const session = service!.secrets;
      const choice = secureChoice(opts, await service!.rng(64));
      setRoulette("");
      setWheelRotation(
        (rotation) =>
          rotation + 1440 + (opts.indexOf(choice) * 360) / opts.length,
      );
      spinTimer.current = setTimeout(
        () => {
          setSpinning(false);
          spinPending.current = false;
          if (session && service!.secrets === session) setRoulette(choice);
        },
        reduceMotion ? 0 : 1500,
      );
    } catch (e) {
      setSpinning(false);
      spinPending.current = false;
      notify((e as Error).message);
    }
  }
  function petFeedback(action: string) {
    if (effectTimer.current) clearTimeout(effectTimer.current);
    setPetEffect(action);
    effectTimer.current = setTimeout(() => setPetEffect(""), 1500);
  }

  if (!service?.secrets || !service.space)
    return (
      <div className="welcome">
        <div className="welcome-art">
          <div className="brand">
            <span className="brand-mark">
              u<span>s</span>
              <i>✳</i>
            </span>
            <div>
              我们的小世界<small>Two people. One little universe.</small>
            </div>
          </div>
          <div className="welcome-copy">
            <span className="eyebrow">A PRIVATE LITTLE PLACE FOR TWO</span>
            <h1>
              把日子过成
              <br />
              我们喜欢的样子<span>。</span>
            </h1>
            <p>
              收藏平凡的瞬间，也期待未来的每一天。
              <br />
              一个只属于两个人的，温柔的小世界。
            </p>
            <img src="/assets/pet-room.svg" alt="糯米在阳光下的小屋" />
          </div>
          <p className="welcome-foot">
            <LockKeyhole size={14} /> 私密记录 · 自愿互动 · 没有打卡压力
          </p>
        </div>
        <div className="welcome-form">
          <Flower2 className="flower" size={40} />
          <h2>
            {welcomeMode === "unlock"
              ? "欢迎回到我们的小世界"
              : welcomeMode === "create"
                ? "故事，从今天开始"
                : "很高兴，在这里遇见你"}
          </h2>
          <p className="muted">
            {welcomeMode === "unlock"
              ? "输入本机解锁口令，打开你的加密手账。"
              : "微信版是我们的目的地，这里可以先体验。"}
          </p>
          {welcomeMode === "welcome" ? (
            <>
              <button
                className="primary full"
                onClick={enterDemo}
                disabled={busy}
              >
                {busy ? "正在准备我们的时光…" : "逛逛示例小世界"}
                <ArrowRight size={17} />
              </button>
              <button
                className="secondary full"
                onClick={() => {
                  const s = createBrowserService("personal");
                  setService(s);
                  setMode("personal");
                  setWelcomeMode(s.vault ? "unlock" : "create");
                }}
              >
                建立本机加密空间
              </button>
              <p className="fineprint">
                示例数据仅用于体验。本机空间不会同步至微信；
                <br />
                正式双人同步请使用项目中的微信小程序。
              </p>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (welcomeMode === "unlock")
                  run(async () => {
                    await service!.unlock(password);
                    setPassword("");
                  });
                else createPersonal();
              }}
            >
              {welcomeMode === "create" && (
                <>
                  <Field label="给我们的空间起个名字">
                    <input
                      value={spaceName}
                      maxLength={30}
                      onChange={(e) => setSpaceName(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="恋爱开始日期">
                    <input
                      type="date"
                      value={startDate}
                      max={day}
                      onChange={(e) => setStartDate(e.target.value)}
                      required
                    />
                  </Field>
                </>
              )}
              <Field label="本机解锁口令（至少 10 位）">
                <input
                  type="password"
                  value={password}
                  autoComplete={
                    welcomeMode === "create"
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={10}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <button className="primary full" disabled={busy}>
                {busy
                  ? "正在打开…"
                  : welcomeMode === "unlock"
                    ? "打开小世界"
                    : "创建我们的空间"}
              </button>
              <button
                className="text-button full"
                type="button"
                onClick={() => setWelcomeMode("welcome")}
              >
                返回
              </button>
              {welcomeMode === "unlock" && (
                <button
                  className="text-button full"
                  type="button"
                  onClick={() => setModal("restore")}
                >
                  使用备份恢复
                </button>
              )}
            </form>
          )}
          <div className="welcome-note">
            <Leaf size={20} />
            <span>
              不用每天来，也不用完成什么。
              <br />
              想记录的时候，我们就在这里。
            </span>
          </div>
        </div>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        {modal === "restore" && (
          <Modal title="恢复加密备份" close={close}>
            <RestoreForm
              service={service}
              mode={mode}
              run={run}
              done={() => {
                close();
                update();
              }}
            />
          </Modal>
        )}
      </div>
    );

  const filteredMemories = memories.filter(
    (e) =>
      (!search ||
        `${e.data.title} ${e.data.body} ${e.data.tags?.join(" ")}`.includes(
          search,
        )) &&
      (filter === "全部" ||
        (filter === "共同回忆" && e.visibility === "shared") ||
        (filter === "私人日记" && e.visibility === "private") ||
        (filter === "收藏" && e.data.favoriteBy?.includes(service.userId))) &&
      (!monthFilter || e.data.date.startsWith(monthFilter)) &&
      (authorFilter === "全部" ||
        (e.creatorId === service.userId) === (authorFilter === "我")) &&
      (!tagFilter || e.data.tags?.some((t) => t.includes(tagFilter))),
  );
  const showMemories = (rows: Entry[], compact = false) =>
    rows.length ? (
      <div className={compact ? "memory-grid" : "timeline-grid"}>
        {rows.map((e) => (
          <article className="memory-card" key={e.id}>
            <button className="memory-open" onClick={() => viewEntry(e)}>
              {e.data.photos?.[0] ? (
                <Photo
                  photo={e.data.photos[0]}
                  visibility={e.visibility}
                  service={service}
                />
              ) : (
                <div className="text-cover">
                  <Feather size={34} />
                  <p>{e.data.body?.slice(0, 50)}</p>
                </div>
              )}
              <div className="memory-copy">
                <span className="meta">
                  <span>{dateLabel(e.data.date)}</span>
                  <span>
                    {e.visibility === "private" ? (
                      <>
                        <LockKeyhole size={11} /> 私人日记
                      </>
                    ) : (
                      "共同回忆"
                    )}
                  </span>
                </span>
                <h3>{e.data.title}</h3>
                <p>{e.data.body}</p>
                <div className="tags">
                  {e.data.tags?.map((t) => (
                    <span key={t}># {t}</span>
                  ))}
                </div>
              </div>
            </button>
            <button
              className={`memory-heart ${e.data.favoriteBy?.includes(service.userId) ? "liked" : ""}`}
              aria-label="收藏回忆"
              onClick={() => run(() => service.favorite(e))}
            >
              <Heart
                size={16}
                fill={
                  e.data.favoriteBy?.includes(service.userId)
                    ? "currentColor"
                    : "none"
                }
              />
            </button>
          </article>
        ))}
      </div>
    ) : (
      <Empty
        icon={<Feather />}
        title="空白的一页，也有无限可能"
        text="记下今天的小事，故事就从这里开始。"
        action={() => edit("memory")}
        label="写下第一条回忆"
      />
    );

  return (
    <div className="app-shell" data-revision={revision}>
      <aside className="sidebar">
        <button className="brand" onClick={() => go("home")}>
          <span className="brand-mark">
            u<span>s</span>
            <i>✳</i>
          </span>
          <div>
            我们的小世界<small>OUR LITTLE WORLD</small>
          </div>
        </button>
        <div className="side-space">
          <div className="avatar-pair">
            <span className="avatar a">予</span>
            <span className="avatar b">辰</span>
            <i>
              <Heart size={10} fill="currentColor" />
            </i>
          </div>
          <strong>
            {mode === "demo"
              ? "小予 & 阿辰"
              : relationship?.data.body || "我 & 你"}
          </strong>
          <span className="tiny">
            {mode === "demo" ? "我们的示例空间" : "我们的本机空间"}
          </span>
        </div>
        <span className="nav-label">我们的每一天</span>
        <nav>
          {tabs.map((t) => (
            <button
              className={`nav-item ${page === t.id ? "active" : ""}`}
              key={t.id}
              onClick={() =>
                go(
                  t.id,
                  t.id === "memories"
                    ? "timeline"
                    : t.id === "interaction"
                      ? "games"
                      : t.id === "plans"
                        ? "wishes"
                        : undefined,
                )
              }
            >
              <t.icon size={20} />
              <span>{t.label}</span>
              {page === t.id && <i />}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="side-quote">
            <Flower2 size={28} />
            <p>
              有你在的日常，
              <br />
              每一页都值得珍藏。
            </p>
            <span>little things, big love.</span>
          </div>
          <button
            className="side-security"
            onClick={() => {
              go("profile");
              setModal("security");
            }}
          >
            <ShieldCheck size={16} />
            <span>隐私与安全</span>
            <ChevronRight size={14} />
          </button>
          <div className="local-mode">
            <span /> 本机{mode === "demo" ? "示例" : "加密"}模式
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            我们的小世界 <ChevronRight size={12} />{" "}
            <strong>{tabs.find((t) => t.id === page)?.sub || "时光"}</strong>
          </div>
          <div className="top-actions">
            <span className="private-label">
              <LockKeyhole size={13} /> 只属于我们
            </span>
            <button
              className="icon-button"
              onClick={() => setDark((v) => !v)}
              aria-label="切换深浅主题"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="icon-button"
              onClick={() => run(() => service.refresh(), "已经是最新的时光了")}
              aria-label="刷新"
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button className="avatar small a" onClick={() => go("profile")}>
              予
            </button>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "home"
                  ? "LIFE IS BETTER WITH YOU"
                  : page === "memories"
                    ? "LITTLE MOMENTS, FOREVER MEMORIES"
                    : page === "interaction"
                      ? "A LITTLE JOY FOR TWO"
                      : page === "plans"
                        ? "GOOD THINGS ARE ON THEIR WAY"
                        : "YOUR OWN LITTLE CORNER"}
              </span>
              <h1>
                {page === "home"
                  ? "把今天，写进我们的故事"
                  : page === "memories"
                    ? "时光慢慢，回忆满满"
                    : page === "interaction"
                      ? "和你一起，浪费一点时间"
                      : page === "plans"
                        ? "未来，有好多想和你做的事"
                        : "给自己，留一处温柔角落"}
                <span className="heading-flower">✳</span>
              </h1>
              <p>
                {page === "home"
                  ? "平凡日子里的小小幸福，都值得被好好收藏。"
                  : page === "memories"
                    ? "那些一起走过的日子，都在这里闪着光。"
                    : page === "interaction"
                      ? "没有任务，没有打卡。今天想玩什么，就玩什么。"
                      : page === "plans"
                        ? "把小小的期待，慢慢变成共同的回忆。"
                        : "照顾好自己的心情，也照顾好我们的回忆。"}
              </p>
            </div>
            <span className="date-pill">
              <CalendarDays size={15} />
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
          </div>
          {service.unreadable > 0 && (
            <div className="notice">
              有 {service.unreadable} 条记录暂时无法解密，请检查密钥备份。
            </div>
          )}
          {!service.ready && (
            <div className="notice">
              等待接收空间密钥，请先到「我的空间 → 设备与安全」核对安全码。
            </div>
          )}
          {page === "home" && (
            <>
              <div className="home-top">
                <section className="together-card">
                  <div className="hero-doodle">
                    <img src="/assets/flower.svg" alt="" />
                  </div>
                  <span className="tiny hero-label">
                    <Heart size={12} /> TWO OF US
                  </span>
                  <div className="hero-avatars">
                    <span className="avatar a large">予</span>
                    <span className="heart-thread">♡</span>
                    <span className="avatar b large">辰</span>
                  </div>
                  <p className="together-caption">不知不觉，我们已经一起走过</p>
                  <div className="together-number">
                    {togetherDays(relationship?.data.date || day)}
                    <span>天</span>
                    <i>and counting…</i>
                  </div>
                  <span className="hero-since">
                    从 {dateLabel(relationship?.data.date || day)}{" "}
                    开始，每天都多一点喜欢。
                  </span>
                  <button
                    className="relationship-settings"
                    onClick={() => edit("relationship", relationship)}
                  >
                    <CalendarDays size={13} />
                    设置恋爱开始日期
                    <ChevronRight size={12} />
                  </button>
                  <div className="hero-bottom">
                    <span>
                      <span className="dot" /> 故事还在继续
                    </span>
                    <span>
                      {nextEvent
                        ? `距离「${nextEvent.data.title}」还有 ${daysBetween(day, nextEvent.next)} 天`
                        : "下一页，等我们一起写"}
                      <ChevronRight size={12} />
                    </span>
                  </div>
                </section>
                <section className="mood-card">
                  <div className="section-title">
                    <h2>
                      <Sun size={18} /> 今日小心情
                    </h2>
                    <span className="tiny">轻轻告诉对方</span>
                  </div>
                  <div className="mood-row">
                    <span className="avatar a">予</span>
                    <div>
                      <strong>
                        我今天<span className="tiny"> · 主动分享</span>
                      </strong>
                      <button
                        className="mood-bubble"
                        onClick={() => setModal("mood")}
                      >
                        {mood?.data.mood || "今天，感觉怎么样？"}
                        <ChevronDown size={13} />
                      </button>
                    </div>
                    <span className="mood-sun">☀</span>
                  </div>
                  <div className="mood-row">
                    <span className="avatar b">辰</span>
                    <div>
                      <strong>
                        {mode === "demo" ? "阿辰" : "对方"}
                        <span className="tiny"> · 只展示分享的心情</span>
                      </strong>
                      <span className="mood-bubble lavender">
                        {partnerMood?.data.mood || "还没有分享心情"}
                      </span>
                    </div>
                    <span className="mood-cloud">☁</span>
                  </div>
                  <div className="soft-note">
                    <Leaf size={14} /> 每一种心情，都可以被温柔接住。
                  </div>
                </section>
              </div>
              <div className="quick-actions">
                {[
                  {
                    icon: Feather,
                    title: "写一篇日记",
                    subtitle: "留住今天的小美好",
                    action: () => edit("memory"),
                  },
                  {
                    icon: ImagePlus,
                    title: "收藏新照片",
                    subtitle: "把瞬间变成永远",
                    action: () => {
                      edit("memory");
                    },
                  },
                  {
                    icon: Mail,
                    title: "给未来的信",
                    subtitle: "寄一份温柔的期待",
                    action: () => edit("capsule"),
                  },
                  {
                    icon: Sparkles,
                    title: "随机一段回忆",
                    subtitle: "重逢过去的某一天",
                    action: randomMemory,
                  },
                ].map((q, i) => (
                  <button key={q.title} onClick={q.action}>
                    <span className={`quick-icon tone-${i}`}>
                      <q.icon size={21} />
                    </span>
                    <span>
                      <strong>{q.title}</strong>
                      <small>{q.subtitle}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
              <div className="home-bottom">
                <section>
                  <div className="section-title">
                    <h2>
                      最近的温柔时光
                      <span className="title-note">OUR MEMORIES</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => go("memories", "timeline")}
                    >
                      翻翻全部回忆
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {showMemories(sharedMemories.slice(0, 2), true)}
                  <div className="home-tip">
                    <span>✧</span> 不一定要很特别。和你一起，就是值得记录的事。
                  </div>
                </section>
                <section className="pet-card">
                  <div className="section-title">
                    <h2>我们的小伙伴</h2>
                    <button
                      className="text-button"
                      onClick={() => go("interaction", "pet")}
                    >
                      去小屋
                      <ChevronRight size={13} />
                    </button>
                  </div>
                  <div
                    className="pet-illustration"
                    onClick={() => go("interaction", "pet")}
                  >
                    <img
                      src="/assets/pet-room.svg"
                      alt="奶油色小兔糯米在温馨的小屋里"
                    />
                    <span className="pet-speech">
                      {pet?.energy && pet.energy < 50
                        ? "想睡个好觉…"
                        : "今天也想和你们贴贴～"}
                    </span>
                    <span className="pet-name">
                      {pet?.name || "糯米"}{" "}
                      <small>Lv.{Math.floor((pet?.exp || 0) / 80) + 1}</small>
                    </span>
                  </div>
                  <div className="pet-bottom">
                    <span>
                      <span className="dot green" />{" "}
                      {pet?.mood && pet.mood > 70
                        ? "正在快乐地发呆"
                        : "期待你来陪它"}
                    </span>
                    <button
                      className="pet-feed"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => service.interact("feed"),
                          "糯米吃得很开心，想和你贴贴！",
                        )
                      }
                    >
                      <Utensils size={13} /> 喂一喂
                    </button>
                  </div>
                </section>
              </div>
              <div className="daily-prompt">
                <span className="daily-icon">
                  <CircleHelp size={23} />
                </span>
                <div>
                  <span className="eyebrow">A QUESTION FOR TODAY</span>
                  <p>{dailyQuestion(day).text}</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => go("interaction", "question")}
                >
                  留下我的答案
                  <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}

          {page === "memories" && (
            <>
              <div className="toolbar">
                <div className="pills">
                  {[
                    ["timeline", "时间轴"],
                    ["album", "相册"],
                    ["capsules", "时光胶囊"],
                    ["map", "共同足迹"],
                    ["report", "回忆报告"],
                    ["ai", "AI 回忆助手"],
                  ].map(([id, name]) => (
                    <button
                      className={section === id ? "selected" : ""}
                      onClick={() => {
                        setSection(id);
                        setAiPreview(false);
                      }}
                      key={id}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <button
                  className="primary"
                  onClick={() =>
                    edit(
                      section === "capsules"
                        ? "capsule"
                        : section === "map"
                          ? "place"
                          : "memory",
                    )
                  }
                >
                  <Plus size={16} />
                  {section === "capsules"
                    ? "封存一份期待"
                    : section === "map"
                      ? "留下新足迹"
                      : "记一笔"}
                </button>
              </div>
              {["timeline", "album"].includes(section) && (
                <>
                  <div className="filter-row">
                    <div className="pills small">
                      {["全部", "共同回忆", "私人日记", "收藏"].map((f) => (
                        <button
                          className={filter === f ? "selected" : ""}
                          key={f}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <div className="search">
                      <Search size={15} />
                      <input
                        aria-label="搜索回忆"
                        placeholder="在回忆里找一找"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="filter-detail">
                    <label>
                      月份{" "}
                      <input
                        aria-label="筛选月份"
                        type="month"
                        value={monthFilter}
                        onChange={(e) => setMonthFilter(e.target.value)}
                      />
                    </label>
                    <label>
                      作者{" "}
                      <select
                        value={authorFilter}
                        onChange={(e) => setAuthorFilter(e.target.value)}
                      >
                        <option>全部</option>
                        <option>我</option>
                        <option>对方</option>
                      </select>
                    </label>
                    <label>
                      标签{" "}
                      <input
                        placeholder="输入标签"
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                      />
                    </label>
                    <button
                      className="text-button"
                      onClick={() => {
                        setMonthFilter("");
                        setAuthorFilter("全部");
                        setTagFilter("");
                      }}
                    >
                      重置
                    </button>
                  </div>
                  {section === "timeline" ? (
                    showMemories(filteredMemories)
                  ) : (
                    <div className="album-grid">
                      {filteredMemories.flatMap((e) =>
                        (e.data.photos || []).map((p) => (
                          <button
                            key={p.id}
                            className="polaroid"
                            onClick={() => viewEntry(e)}
                          >
                            <Photo
                              photo={p}
                              visibility={e.visibility}
                              service={service}
                            />
                            <span>{e.data.title}</span>
                            <small>{dateLabel(e.data.date)}</small>
                          </button>
                        )),
                      )}
                      {!filteredMemories.some((e) => e.data.photos?.length) && (
                        <Empty
                          icon={<Camera />}
                          title="相册的第一页，留给你"
                          text="在日记中添加照片，就会出现在这里。"
                          action={() => edit("memory")}
                          label="收藏照片"
                        />
                      )}
                    </div>
                  )}
                </>
              )}
              {section === "capsules" && (
                <>
                  <div className="feature-banner capsule-banner">
                    <Mail size={58} />
                    <div>
                      <span className="eyebrow">
                        LET TIME KEEP A LITTLE SECRET
                      </span>
                      <h2>把现在，寄给未来的我们</h2>
                      <p>有些话，等到那个特别的日子再慢慢读。</p>
                    </div>
                  </div>
                  <div className="cards-grid">
                    {entries
                      .filter((e) => e.data.kind === "capsule")
                      .map((e) => (
                        <article
                          className={`capsule-card ${openingCapsule === e.id ? "capsule-opening" : ""}`}
                          key={e.id}
                        >
                          <span className="capsule-stamp">
                            {e.data.openedAt ||
                            canOpenCapsule(e, service.space!.members) ? (
                              <Mail size={28} />
                            ) : (
                              <LockKeyhole size={28} />
                            )}
                          </span>
                          <span className="eyebrow">
                            {e.data.category || "TIME CAPSULE"}
                          </span>
                          <h3>{e.data.title}</h3>
                          <p>
                            {e.data.openedAt
                              ? "已经开启，可以随时重读"
                              : `约定在 ${dateLabel(e.data.unlockDate || day)} 开启`}
                          </p>
                          <strong className="countdown">
                            {e.data.openedAt
                              ? "一份珍藏的温柔"
                              : daysBetween(day, e.data.unlockDate || day) > 0
                                ? `还有 ${daysBetween(day, e.data.unlockDate!)} 天`
                                : e.data.needsBoth
                                  ? "等待我们的共同确认"
                                  : "到了打开的时候"}
                          </strong>
                          {e.data.needsBoth &&
                            !e.data.confirmedBy?.includes(service.userId) && (
                              <button
                                className="secondary"
                                onClick={() =>
                                  run(
                                    () => service.confirmCapsule(e),
                                    "已留下你的开启确认",
                                  )
                                }
                              >
                                我准备好了
                              </button>
                            )}
                          <button
                            className="text-button"
                            onClick={() => {
                              if (e.data.openedAt) viewEntry(e);
                              else
                                run(async () => {
                                  const opened = await service.openCapsule(e);
                                  const session = service.secrets;
                                  setOpeningCapsule(e.id);
                                  if (!reduceMotion)
                                    await new Promise<void>((resolve) =>
                                      setTimeout(resolve, 650),
                                    );
                                  setOpeningCapsule("");
                                  if (session && service.secrets === session)
                                    viewEntry(opened);
                                });
                            }}
                          >
                            {e.data.openedAt ? "重读这封信" : "开启胶囊"}
                            <ArrowRight size={14} />
                          </button>
                          <button
                            className="text-button faint"
                            onClick={() => {
                              setDetail(e);
                              setModal("delete-capsule");
                            }}
                          >
                            移入回收站
                          </button>
                        </article>
                      ))}
                  </div>
                  <p className="fineprint centered">
                    <LockKeyhole size={12} />{" "}
                    定时开启是一份约定，由应用控制；拥有密钥的人可在应用外解密。
                  </p>
                </>
              )}
              {section === "map" && (
                <>
                  <div className="feature-banner map-banner">
                    <MapPin size={48} />
                    <div>
                      <span className="eyebrow">OUR LITTLE FOOTPRINTS</span>
                      <h2>世界很大，想和你慢慢走</h2>
                      <p>只记录我们主动留下的足迹，文字地点也很美好。</p>
                    </div>
                    <span className="map-count">
                      {entries.filter((e) => e.data.kind === "place").length}
                      <small>处共同记忆</small>
                    </span>
                  </div>
                  <div className="map-layout">
                    <div className="illustrated-map">
                      <div className="map-river" />
                      <span className="map-land land-a" />
                      <span className="map-land land-b" />
                      <span className="map-label">OUR MEMORY MAP</span>
                      {entries
                        .filter((e) => e.data.kind === "place")
                        .map((e, i) => (
                          <button
                            style={{
                              left: `${22 + (i % 3) * 24}%`,
                              top: `${25 + Math.floor(i / 3) * 18 + (i % 2) * 20}%`,
                            }}
                            key={e.id}
                            className="map-pin"
                            onClick={() => viewEntry(e)}
                          >
                            <MapPin size={26} fill="currentColor" />
                            <span>{e.data.city || e.data.title}</span>
                          </button>
                        ))}
                      <span className="map-disclaimer">
                        足迹手绘示意 · 点按标记回看故事
                      </span>
                    </div>
                    <div>
                      <div className="section-title">
                        <h2>一起去过的地方</h2>
                      </div>
                      {entries
                        .filter((e) => e.data.kind === "place")
                        .map((e) => (
                          <button
                            className="place-row"
                            key={e.id}
                            onClick={() => viewEntry(e)}
                          >
                            <span className="place-icon">
                              <MapPin size={18} />
                            </span>
                            <span>
                              <strong>{e.data.title}</strong>
                              <small>
                                {e.data.city} · {dateLabel(e.data.date)}
                              </small>
                            </span>
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      <button
                        className="secondary full"
                        onClick={() => setMapConsent((v) => !v)}
                      >
                        {mapConsent ? "收起外部地图链接" : "查看坐标地图选项"}
                      </button>
                      {mapConsent && (
                        <div className="map-privacy">
                          <p>
                            打开外部地图会把选中坐标发送给地图服务。这里不采集实时位置。
                          </p>
                          {entries
                            .filter(
                              (e) =>
                                e.data.kind === "place" &&
                                e.data.latitude !== undefined,
                            )
                            .map((e) => (
                              <a
                                href={`https://uri.amap.com/marker?position=${e.data.longitude},${e.data.latitude}&name=${encodeURIComponent(e.data.title)}`}
                                target="_blank"
                                rel="noreferrer"
                                key={e.id}
                              >
                                {e.data.title} ↗
                              </a>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
              {section === "report" && (
                <div className="report-page">
                  <div className="report-cover">
                    <span className="eyebrow">
                      OUR DAYS, BEAUTIFULLY COLLECTED
                    </span>
                    <h2>
                      {day.slice(0, 4)}
                      <span>
                        我们的{reportRange === "year" ? "这一年" : "这个月"}
                      </span>
                    </h2>
                    <p>生活里的小小片刻，原来已经攒了这么多。</p>
                    <div className="pills">
                      <button
                        className={reportRange === "month" ? "selected" : ""}
                        onClick={() => setReportRange("month")}
                      >
                        月度回忆
                      </button>
                      <button
                        className={reportRange === "year" ? "selected" : ""}
                        onClick={() => setReportRange("year")}
                      >
                        年度回忆
                      </button>
                    </div>
                  </div>
                  <div className="stats-grid">
                    {[
                      [stats.memories, "条共同回忆"],
                      [stats.photos, "张珍藏照片"],
                      [stats.places, "处共同足迹"],
                      [stats.wishes, "个已实现愿望"],
                      [stats.pet, "次陪伴小伙伴"],
                      [stats.games, "次双人问答"],
                    ].map(([n, label]) => (
                      <div key={label}>
                        <strong>{n}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="section-title">
                    <h2>值得再看一眼的瞬间</h2>
                    <span className="tiny">
                      {dateLabel(reportFrom)} — {dateLabel(day)}
                    </span>
                  </div>
                  {showMemories(stats.highlights, true)}
                  <div className="report-actions">
                    <button className="primary" onClick={() => window.print()}>
                      <ArrowDownToLine size={16} /> 打印 / 保存 PDF
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        download(
                          `Us-回忆报告-${day}.json`,
                          JSON.stringify(
                            { from: reportFrom, to: day, ...stats },
                            null,
                            2,
                          ),
                        );
                        notify("已导出明文报告，请妥善保存");
                      }}
                    >
                      导出报告数据
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setSection("ai")}
                    >
                      <WandSparkles size={16} /> 为回忆写段话
                    </button>
                  </div>
                  <p className="fineprint">
                    统计在本机计算，仅包括所选日期内的共同内容。PDF
                    通过浏览器打印窗口保存。
                  </p>
                </div>
              )}
              {section === "ai" && (
                <div className="ai-layout">
                  <section className="card">
                    <WandSparkles className="rose" size={32} />
                    <h2>让零散的回忆，连成一段故事</h2>
                    <p className="muted">
                      先选几条共同回忆，再预览本次要发送的文字。
                    </p>
                    <div className="ai-selector">
                      {sharedMemories.map((e) => (
                        <label key={e.id}>
                          <input
                            type="checkbox"
                            checked={aiSelected.includes(e.id)}
                            onChange={(ev) => {
                              setAiSelected((ids) =>
                                ev.target.checked
                                  ? [...ids, e.id]
                                  : ids.filter((id) => id !== e.id),
                              );
                              setAiPreview(false);
                              setAiConsent(false);
                            }}
                          />
                          <span>
                            <strong>{e.data.title}</strong>
                            <small>{dateLabel(e.data.date)}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    <button
                      className="primary"
                      disabled={!aiSelected.length}
                      onClick={() => {
                        setAiPreview(true);
                        setAiConsent(false);
                      }}
                    >
                      预览将发送的内容
                      <ArrowRight size={16} />
                    </button>
                    <p className="fineprint">
                      <ShieldCheck size={13} />{" "}
                      私人日记不会列出，照片原图不会发送。
                    </p>
                  </section>
                  <section className="card ai-result">
                    {aiPreview ? (
                      <>
                        <span className="eyebrow">REVIEW BEFORE SHARING</span>
                        <h3>这一次，只发送这些文字</h3>
                        <pre>
                          {sharedMemories
                            .filter((e) => aiSelected.includes(e.id))
                            .map(
                              (e) =>
                                `${e.data.date} ${e.data.title}\n${e.data.body || ""}`,
                            )
                            .join("\n\n")}
                        </pre>
                        <label className="check-line">
                          <input
                            type="checkbox"
                            checked={aiConsent}
                            onChange={(e) => setAiConsent(e.target.checked)}
                          />
                          <span>
                            我同意将以上文字发送给已配置的 AI
                            服务，仅授权本次请求。
                          </span>
                        </label>
                        <button
                          className="primary"
                          disabled={!aiConsent || busy}
                          onClick={() =>
                            run(async () => {
                              setAiConsent(false);
                              const result = await service.ai(
                                aiSelected,
                                Date.now(),
                                "整理为一段温柔自然的回忆文字，不评价关系，不捏造经历",
                              );
                              setAiResult(result.text);
                            }, "回忆文案已经生成")
                          }
                        >
                          确认并生成
                        </button>
                        <p className="fineprint">
                          本机预览未连接 AI 服务。微信版需配置服务地址、模型与
                          API 密钥。
                        </p>
                      </>
                    ) : (
                      <div className="empty-ai">
                        <Sparkles size={42} />
                        <h3>每次授权，都由你决定</h3>
                        <p>你们的故事，始终握在自己手中。</p>
                      </div>
                    )}
                    {aiResult && (
                      <>
                        <Field label="审核、修改这段文字">
                          <textarea
                            value={aiResult}
                            rows={8}
                            onChange={(e) => setAiResult(e.target.value)}
                          />
                        </Field>
                        <button
                          className="secondary"
                          onClick={() =>
                            run(async () => {
                              await service.save({
                                kind: "memory",
                                title: "我们的回忆故事",
                                body: aiResult,
                                date: day,
                                tags: ["AI 整理", "已审核"],
                              });
                              setAiResult("");
                            }, "已作为新的加密回忆保存")
                          }
                        >
                          确认保存到时光
                        </button>
                      </>
                    )}
                  </section>
                </div>
              )}
            </>
          )}

          {page === "interaction" && (
            <>
              <div className="toolbar">
                <div className="pills">
                  {[
                    ["games", "一起玩耍"],
                    ["pet", "糯米的小屋"],
                    ["question", "每日问答"],
                    ["quiz", "默契小问答"],
                    ["roulette", "约会转盘"],
                    ["truth", "真心话"],
                  ].map(([id, name]) => (
                    <button
                      className={section === id ? "selected" : ""}
                      key={id}
                      onClick={() => {
                        setSection(id);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              {section === "games" && (
                <>
                  <div className="feature-banner play-banner">
                    <Gamepad2 size={55} />
                    <div>
                      <span className="eyebrow">
                        SOME QUALITY TIME TOGETHER
                      </span>
                      <h2>和你一起，普通小事也很好玩</h2>
                      <p>对方不在线也没关系，答案会好好等着。</p>
                    </div>
                  </div>
                  <div className="game-grid">
                    {[
                      {
                        id: "pet",
                        icon: Heart,
                        title: "糯米的小屋",
                        text: "一起照顾一位毛茸茸的小伙伴",
                        note: "陪伴慢慢长大",
                      },
                      {
                        id: "question",
                        icon: Coffee,
                        title: "今日的小话题",
                        text: dailyQuestion(day).text,
                        note: "每天一问，自愿回答",
                      },
                      {
                        id: "quiz",
                        icon: Sparkles,
                        title: "原来你也这样想",
                        text: "各自选一个答案，等彼此都准备好再揭晓",
                        note: "异步双人问答",
                      },
                      {
                        id: "roulette",
                        icon: Compass,
                        title: "今天约点什么",
                        text: "把选择困难，交给一点点小惊喜",
                        note: "自定义约会转盘",
                      },
                      {
                        id: "truth",
                        icon: Mail,
                        title: "慢慢靠近一点点",
                        text: "从一个真心的小问题，开始聊天",
                        note: "随时可以跳过",
                      },
                      {
                        id: "challenge",
                        icon: Star,
                        title: "一起做件小事",
                        text: "这周一起拍一张窗外的天空吧",
                        note: "完成后收藏成回忆",
                      },
                    ].map((g, i) => (
                      <button
                        className={`game-card game-${i}`}
                        key={g.id}
                        onClick={() =>
                          g.id === "challenge" ? edit("wish") : setSection(g.id)
                        }
                      >
                        <span className="game-icon">
                          <g.icon size={26} />
                        </span>
                        <h3>{g.title}</h3>
                        <p>{g.text}</p>
                        <span>
                          {g.note}
                          <ArrowRight size={15} />
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {section === "pet" && (
                <div className="pet-page">
                  <div
                    className={`pet-room-large ${petEffect ? `pet-effect-${petEffect}` : ""}`}
                  >
                    <img src="/assets/pet-room.svg" alt="小兔糯米的温馨小屋" />
                    {petEffect && (
                      <span className="pet-floating" role="status">
                        {petEffect === "feed"
                          ? "🥕 吃饱饱，好开心"
                          : petEffect === "pat"
                            ? "♡ ♡ 收到你的摸摸"
                            : petEffect === "play"
                              ? "✧ 一起玩了一小会"
                              : "☾ 做一个软软的梦"}
                      </span>
                    )}
                    <div className="pet-page-heading">
                      <span className="eyebrow">OUR COZY LITTLE ROOM</span>
                      <h2>{pet?.name}的小屋</h2>
                      <p>在这里，慢慢长大就很好。</p>
                    </div>
                    <span className="pet-level">
                      Lv.{Math.floor((pet?.exp || 0) / 80) + 1} ·{" "}
                      {pet?.exp || 0} 点共同回忆
                    </span>
                  </div>
                  <section className="card">
                    <h2>今天，怎么陪陪它？</h2>
                    <div className="pet-stats">
                      {[
                        [pet?.hunger, "吃饱饱"],
                        [pet?.mood, "心情"],
                        [pet?.energy, "精力"],
                      ].map(([value, label]) => (
                        <div key={label}>
                          <span>
                            {label}
                            <small>{value}/100</small>
                          </span>
                          <div className="progress">
                            <i style={{ width: `${value}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="pet-action-grid">
                      {Object.entries(petActionLabels).map(([a, name]) => (
                        <button
                          className="secondary"
                          key={a}
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await service.interact(a);
                              petFeedback(a);
                            }, `${pet?.name}很喜欢你的陪伴`)
                          }
                        >
                          {a === "feed"
                            ? "🥕"
                            : a === "pat"
                              ? "☁"
                              : a === "play"
                                ? "🎾"
                                : "☾"}{" "}
                          {name}
                        </button>
                      ))}
                    </div>
                    <Field label="给小伙伴起个名字">
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = new FormData(e.currentTarget).get(
                            "petName",
                          ) as string;
                          if (petEntry && pet)
                            run(
                              () =>
                                service.save(
                                  {
                                    ...petEntry.data,
                                    pet: {
                                      ...pet,
                                      name: name.trim() || "糯米",
                                    },
                                  },
                                  "shared",
                                  petEntry,
                                ),
                              "新名字真好听",
                            );
                        }}
                      >
                        <input
                          name="petName"
                          defaultValue={pet?.name}
                          maxLength={12}
                        />
                        <button className="primary">保存</button>
                      </form>
                    </Field>
                    <h3 className="subheading">给小屋换一点心情</h3>
                    <div className="pills">
                      {[
                        ["plant", "窗边绿植"],
                        ["flower", "桌上一束花"],
                        ["blanket", "软软小毯子"],
                      ].map(([id, name]) => (
                        <button
                          className={
                            pet?.decorations.includes(id) ? "selected" : ""
                          }
                          key={id}
                          onClick={() =>
                            petEntry &&
                            pet &&
                            run(
                              () =>
                                service.save(
                                  {
                                    ...petEntry.data,
                                    pet: {
                                      ...pet,
                                      decorations: pet.decorations.includes(id)
                                        ? pet.decorations.filter(
                                            (x) => x !== id,
                                          )
                                        : [...pet.decorations, id],
                                    },
                                  },
                                  "shared",
                                  petEntry,
                                ),
                              "小屋的装饰已更新",
                            )
                          }
                        >
                          {name}
                          {pet?.decorations.includes(id) && <Check size={12} />}
                        </button>
                      ))}
                    </div>
                    <p className="fineprint">
                      装饰收藏：
                      {pet?.decorations
                        .map(
                          (d) =>
                            ({
                              plant: "绿植",
                              flower: "花束",
                              blanket: "小毯子",
                            })[d],
                        )
                        .join("、") || "简简单单也很好看"}
                    </p>
                    <p className="soft-note">
                      不来照顾也不会扣分，小伙伴会一直等你。
                    </p>
                  </section>
                  <section className="card pet-history">
                    <h3>陪伴的痕迹</h3>
                    {pet?.history
                      .slice(-6)
                      .reverse()
                      .map((h, i) => (
                        <p key={i}>
                          <Heart size={13} />
                          {h.userId === service.userId ? "我" : "对方"} ·{" "}
                          {petActionLabels[h.action]}
                          <small>{dateLabel(h.day)}</small>
                        </p>
                      ))}
                    {!pet?.history.length && (
                      <p className="muted">第一份陪伴，等你轻轻留下。</p>
                    )}
                  </section>
                </div>
              )}
              {["question", "quiz", "truth"].includes(section) && (
                <QuestionRoom
                  service={service}
                  entries={entries}
                  mode={section}
                  busy={busy}
                  perform={run}
                />
              )}
              {section === "roulette" && (
                <div className="roulette-layout">
                  <section className="card roulette-card">
                    <span className="eyebrow">
                      LEAVE IT TO A LITTLE SURPRISE
                    </span>
                    <h2>下一场约会，就这么决定</h2>
                    <div
                      className={`wheel ${spinning ? "spinning" : ""}`}
                      style={{ transform: `rotate(${wheelRotation}deg)` }}
                    >
                      <div
                        style={{ transform: `rotate(${-wheelRotation}deg)` }}
                      >
                        <Heart size={32} />
                        <span>和你一起</span>
                      </div>
                    </div>
                    <span className="wheel-pointer">▼</span>
                    <button
                      className="primary"
                      onClick={spin}
                      disabled={spinning}
                    >
                      {spinning ? "小惊喜正在路上…" : "转一转，出发！"}
                    </button>
                    {roulette && !spinning && (
                      <div className="roulette-result">
                        <Sparkles size={20} />
                        <strong>{roulette}</strong>
                        <button
                          className="text-button"
                          onClick={() => {
                            edit("date");
                          }}
                        >
                          记进约会计划
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  </section>
                  <section className="card">
                    <h3>把想做的小事放进去</h3>
                    <p className="muted">
                      每行一个选项，至少两项。双方都能决定今天怎么过。
                    </p>
                    <textarea
                      rows={9}
                      disabled={spinning}
                      value={rouletteOptions}
                      onChange={(e) => setRouletteOptions(e.target.value)}
                    />
                    <p className="fineprint">
                      使用系统安全随机数公平抽取，每个选项机会相同。
                    </p>
                  </section>
                </div>
              )}
            </>
          )}

          {page === "plans" && (
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
                            {Math.max(
                              0,
                              daysBetween(
                                day,
                                nextAnniversary(e.data.date, e.data.yearly),
                              ),
                            )}
                          </strong>
                          <span>
                            天后 ·{" "}
                            {dateLabel(
                              nextAnniversary(e.data.date, e.data.yearly),
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
          )}

          {page === "profile" && (
            <div className="profile-layout">
              <section className="card profile-card">
                <label className="motion-preference">
                  <span>
                    减少动态效果<small>保留操作反馈，减少旋转与跳动</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={reduceMotion}
                    onChange={(event) => {
                      setReduceMotion(event.target.checked);
                      localStorage.setItem(
                        "us.reduceMotion",
                        String(event.target.checked),
                      );
                    }}
                  />
                </label>
                <span className="avatar a xlarge">予</span>
                <h2>{mode === "demo" ? "小予" : "我的小角落"}</h2>
                <p className="muted">愿每个平凡的日子，都有小小的喜欢。</p>
                <span className="private-badge">
                  <LockKeyhole size={13} />{" "}
                  {mode === "demo" ? "本机示例空间" : "本机加密空间"}
                </span>
                <div className="profile-counts">
                  <div>
                    <strong>{memories.length}</strong>
                    <span>页手账</span>
                  </div>
                  <div>
                    <strong>
                      {
                        memories.filter((e) =>
                          e.data.favoriteBy?.includes(service.userId),
                        ).length
                      }
                    </strong>
                    <span>份珍藏</span>
                  </div>
                </div>
                <button
                  className="secondary full"
                  onClick={() => {
                    service.lock();
                    sessionStorage.removeItem("us.demo.password");
                    setWelcomeMode("unlock");
                    update();
                  }}
                >
                  <LockKeyhole size={15} /> 锁上我的小世界
                </button>
              </section>
              <section className="card settings-list">
                {[
                  {
                    icon: Feather,
                    title: "我的私人日记",
                    text: "只有我自己可以打开",
                    action: () => {
                      go("memories", "timeline");
                      setFilter("私人日记");
                    },
                  },
                  {
                    icon: Mail,
                    title: "写给未来的信",
                    text: "把想说的话，交给时间",
                    action: () => go("memories", "capsules"),
                  },
                  {
                    icon: RefreshCw,
                    title: "连接与同步",
                    text: "查看连接状态与最近刷新时间",
                    action: async () => {
                      setConnection(null);
                      setModal("connection");
                      await run(async () => {
                        setConnection(await service.checkConnection());
                      });
                    },
                  },
                  {
                    icon: ShieldCheck,
                    title: "设备与安全",
                    text: "安全码、设备授权与密钥交换",
                    action: async () => {
                      await run(async () =>
                        setDevices(await service.devices()),
                      );
                      setModal("security");
                    },
                  },
                  {
                    icon: KeyRound,
                    title: "备份与恢复密钥",
                    text: "为重要的回忆留一把备用钥匙",
                    action: () => {
                      setRecovery(service.secrets?.recoveryKey || "");
                      setModal("recovery");
                    },
                  },
                  {
                    icon: ArrowDownToLine,
                    title: "导出我的回忆",
                    text: "加密备份，或明确选择明文导出",
                    action: () => setModal("export"),
                  },
                  {
                    icon: Trash2,
                    title: "回收站",
                    text: "手动恢复，或保留在加密备份中",
                    action: () => setModal("trash"),
                  },
                  {
                    icon: Settings,
                    title: "隐私与空间设置",
                    text: "外部服务说明、解除绑定与本机数据",
                    action: () => setModal("privacy"),
                  },
                ].map((item) => (
                  <button
                    key={item.title}
                    className="settings-row"
                    onClick={item.action}
                  >
                    <span className="settings-icon">
                      <item.icon size={21} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.text}</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </section>
              <div className="profile-note">
                <Flower2 size={24} />
                <p>
                  这里不记录在线状态，不追踪实时位置。
                  <br />
                  每一份分享，都是你自己的选择。
                </p>
                <span>Us · made for the two of us</span>
              </div>
            </div>
          )}
          <footer className="app-footer">
            <span>一点日常，一点喜欢，一点属于我们的小幸福。</span>
            <span>
              MADE FOR US <Heart size={10} />
            </span>
          </footer>
        </div>
      </main>
      <nav className="mobile-nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={page === t.id ? "active" : ""}
            onClick={() =>
              go(
                t.id,
                t.id === "memories"
                  ? "timeline"
                  : t.id === "interaction"
                    ? "games"
                    : t.id === "plans"
                      ? "wishes"
                      : undefined,
              )
            }
          >
            <t.icon size={21} />
            <span>{t.sub}</span>
          </button>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {modal.startsWith("edit:") && (
        <Modal
          title={
            modal === "edit:relationship" ||
            editing?.data.category === "relationship"
              ? "设置恋爱开始日期"
              : editing
                ? "再添一笔，慢慢珍藏"
                : kindNames[modal.slice(5)] || "记下这份温柔"
          }
          subtitle={
            modal === "edit:relationship" ||
            editing?.data.category === "relationship"
              ? "首页会从这一天开始计算我们的在一起天数。"
              : "把此刻的心情，好好放在这一页。"
          }
          close={close}
          wide
        >
          <Editor
            kind={modal.slice(5)}
            service={service}
            existing={editing}
            busy={busy}
            run={run}
            done={close}
          />
        </Modal>
      )}
      {modal === "mood" && (
        <Modal
          title="今天的我，感觉…"
          subtitle="只在你主动分享后，对方才会看见。"
          close={close}
        >
          <div className="mood-options">
            {moodOptions.map((m) => (
              <button
                className="secondary"
                key={m}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await service.save(
                      { kind: "mood", title: m, mood: m, date: day },
                      "shared",
                      mood,
                    );
                    close();
                  }, "今天的心情，已被温柔放好")
                }
              >
                {m}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {modal === "detail" && detail && (
        <Modal
          title={detail.data.title}
          subtitle={`${dateLabel(detail.data.date)} · ${detail.visibility === "private" ? "私人记录" : "共同回忆"}`}
          close={close}
          wide
        >
          <div className="detail-photos">
            {detail.data.photos?.map((p) => (
              <Photo
                key={p.id}
                photo={p}
                visibility={detail.visibility}
                service={service}
              />
            ))}
          </div>
          <p className="detail-body">
            {detail.data.body || "这个瞬间，本身就很好。"}
          </p>
          <div className="tags">
            {detail.data.tags?.map((t) => (
              <span key={t}># {t}</span>
            ))}
          </div>
          <details>
            <summary>查看编辑历史（最多 10 次）</summary>
            {detail.data.history?.length ? (
              detail.data.history.map((h, i) => (
                <div className="history-entry" key={i}>
                  <strong>{h.title}</strong>
                  <p>{h.body}</p>
                  <small>{new Date(h.at).toLocaleString()}</small>
                </div>
              ))
            ) : (
              <p>这一页还没有修改过。</p>
            )}
          </details>
          <div className="detail-actions">
            <button
              className="secondary"
              onClick={() => edit(detail.data.kind, detail)}
            >
              <Feather size={15} /> 编辑这一页
            </button>
            <button
              className="text-button"
              onClick={() =>
                run(async () => {
                  await service.trash(detail);
                  close();
                }, "已放入回收站")
              }
            >
              <Trash2 size={15} /> 移入回收站
            </button>
          </div>
          {detail.data.kind === "memory" && (
            <div className="comments">
              <h3>给这一页留句话</h3>
              {entries
                .filter(
                  (e) =>
                    e.data.kind === "comment" && e.data.targetId === detail.id,
                )
                .map((e) => (
                  <p key={e.id}>
                    <strong>
                      {e.creatorId === service.userId ? "我" : "对方"}
                    </strong>
                    {e.data.body}
                  </p>
                ))}
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await service.save(
                      {
                        kind: "comment",
                        title: "回忆留言",
                        body: comment.trim(),
                        targetId: detail.id,
                        date: day,
                      },
                      detail.visibility,
                    );
                    setComment("");
                  }, "留言已加密保存");
                }}
              >
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="想说点什么…"
                  maxLength={500}
                  required
                />
                <button className="primary" disabled={busy}>
                  留言
                </button>
              </form>
            </div>
          )}
        </Modal>
      )}
      {modal === "delete-capsule" && detail && (
        <Modal title="把这份期待放回抽屉？" close={close}>
          <p className="muted">内容会保留在回收站，可以恢复。</p>
          <button
            className="primary full"
            onClick={() =>
              run(async () => {
                await service.trash(detail);
                close();
              }, "胶囊已移入回收站")
            }
          >
            移入回收站
          </button>
        </Modal>
      )}
      {modal === "recovery" && (
        <Modal
          title="给回忆，留一把备用钥匙"
          subtitle="恢复密钥能打开备份中的全部内容。请离线保管，不要发给任何人。"
          close={close}
        >
          <div className="recovery-code">{recovery}</div>
          <p className="fineprint">
            恢复需要「加密备份文件 +
            这把恢复密钥」。双方同时遗失密钥和备份后，内容将无法恢复。
          </p>
          <button
            className="primary full"
            onClick={() => {
              download(`Us-恢复密钥-${day}.txt`, recovery, "text/plain");
              download(
                `Us-加密备份-${day}.json`,
                JSON.stringify(
                  {
                    format: "UsBackup",
                    version: 1,
                    vault: service.vault,
                    database: service.storage.get("database"),
                    files: Object.fromEntries(
                      Object.keys(localStorage)
                        .filter((k) => k.startsWith(`us.${mode}.file.`))
                        .map((k) => [
                          k.replace(`us.${mode}.`, ""),
                          localStorage.getItem(k),
                        ]),
                    ),
                  },
                  null,
                  2,
                ),
              );
            }}
          >
            保存恢复密钥和加密备份
          </button>
          <p className="fineprint">建议把恢复密钥与加密备份放在不同位置。</p>
        </Modal>
      )}
      {modal === "connection" && (
        <Modal
          title="连接与同步"
          subtitle="这里只检查连接，不发送日记正文或照片。"
          close={close}
        >
          <div className="connection-status">
            <ShieldCheck size={25} />
            <strong>
              {connection
                ? connection.mode === "cloud"
                  ? "云端连接正常"
                  : "本机存储可用"
                : busy
                  ? "正在检查连接…"
                  : "暂未取得连接结果"}
            </strong>
            <p>
              {connection?.mode === "cloud"
                ? "继续记录之前，可以先刷新双方的最新时光。"
                : "当前浏览器中的记录保存在本机；跨设备共享请使用微信小程序并完成双人绑定。"}
            </p>
          </div>
          <div className="connection-details">
            <span>最近成功刷新</span>
            <strong>
              {service.lastSyncedAt
                ? new Date(service.lastSyncedAt).toLocaleString("zh-CN")
                : "尚未刷新"}
            </strong>
            <span>可查看的记录</span>
            <strong>{service.active.length} 条</strong>
          </div>
          {service.lastSyncError && (
            <p className="error-text">最近同步提示：{service.lastSyncError}</p>
          )}
          <button
            className="primary full"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setConnection(null);
                const status = await service.checkConnection();
                await service.refresh();
                setConnection(status);
              }, "连接正常，已经取得最新记录")
            }
          >
            <RefreshCw size={15} />
            检查并刷新
          </button>
          <p className="fineprint">
            网络中断时不会自动重发保存、删除或 AI
            生成操作。若结果不确定，请先联网刷新，避免重复提交。
          </p>
        </Modal>
      )}
      {modal === "security" && (
        <Modal title="我们之间的安全感" close={close}>
          <p className="muted">
            内容在设备上加密，空间服务只保存密文。共享密钥前，请通过可信渠道核对双方安全码。
          </p>
          <Field label="我的设备安全码">
            <code className="safety-code">
              {fingerprint(publicKeys(service.secrets!))}
            </code>
          </Field>
          <p className="fineprint">
            本机预览仅支持当前浏览器。跨微信账号邀请、密钥交换和设备管理在原生小程序中执行。
          </p>
          <div className="device-list">
            {devices.map((d) => (
              <div key={d.id}>
                <ShieldCheck size={18} />
                <span>
                  <strong>
                    {d.label}
                    {d.id === service.secrets!.deviceId ? " · 当前设备" : ""}
                  </strong>
                  <small>{d.id.slice(0, 16)}…</small>
                </span>
                {d.id !== service.secrets!.deviceId &&
                  d.userId === service.userId && (
                    <button
                      className="text-button"
                      onClick={() =>
                        run(async () => {
                          await service.call("revokeDevice", {
                            targetDeviceId: d.id,
                          });
                          setDevices(await service.devices());
                        }, "该设备的后续云访问已撤销")
                      }
                    >
                      撤销
                    </button>
                  )}
              </div>
            ))}
          </div>
          <button
            className="secondary full"
            onClick={() =>
              run(
                () => service.rotateKey(),
                "未来记录的密钥已轮换，请对方接收新密钥",
              )
            }
          >
            轮换未来记录密钥
          </button>
          <button
            className="secondary full"
            onClick={() =>
              run(async () => {
                const r = await service.call<{ token: string }>(
                  "createInvitation",
                );
                setInvitation(r.token);
              }, "邀请已生成，有效期一小时")
            }
          >
            生成一次性邀请码
          </button>
          {invitation && <code className="invitation">{invitation}</code>}
        </Modal>
      )}
      {modal === "export" && (
        <Modal title="把回忆，好好带走" close={close}>
          <p className="muted">
            加密备份需要恢复密钥才能打开。明文导出会包含你有权查看的文字与照片说明。
          </p>
          <button
            className="primary full"
            onClick={() => {
              setRecovery(service.secrets?.recoveryKey || "");
              setModal("recovery");
            }}
          >
            <ShieldCheck size={16} /> 保存加密备份
          </button>
          <button
            className="secondary full"
            onClick={() => setModal("export-plain")}
          >
            导出明文记录
          </button>
          <button
            className="text-button full"
            onClick={() => setModal("restore")}
          >
            从备份恢复本机空间
          </button>
        </Modal>
      )}
      {modal === "export-plain" && (
        <Modal title="导出可直接阅读的记录？" close={close}>
          <p className="muted">
            导出的 JSON
            文件不再受应用加密保护，包含你可见的日记、计划、留言和照片说明。照片文件包含在加密备份中。
          </p>
          <button
            className="primary full"
            onClick={() => {
              download(
                `Us-明文回忆-${day}.json`,
                JSON.stringify(service.entries, null, 2),
              );
              close();
              notify("明文记录已导出，请妥善保管");
            }}
          >
            确认并导出明文记录
          </button>
        </Modal>
      )}
      {modal === "restore" && (
        <Modal title="恢复加密备份" close={close}>
          <RestoreForm
            service={service}
            mode={mode}
            run={run}
            done={() => {
              close();
              update();
            }}
          />
        </Modal>
      )}
      {modal === "trash" && (
        <Modal
          title="暂时收起的回忆"
          subtitle="回收站保留加密记录，恢复后会回到原来的位置。"
          close={close}
        >
          {service.entries
            .filter((e) => e.deletedAt)
            .map((e) => (
              <div className="trash-row" key={e.id}>
                <span>{e.data.title}</span>
                <button
                  className="text-button"
                  onClick={() =>
                    run(() => service.trash(e, true), "这份回忆回来了")
                  }
                >
                  恢复
                </button>
                {e.creatorId === service.userId && (
                  <button
                    className="text-button danger"
                    onClick={() => {
                      setDetail(e);
                      setModal("purge");
                    }}
                  >
                    永久删除
                  </button>
                )}
              </div>
            ))}
          {!service.entries.some((e) => e.deletedAt) && (
            <p className="empty-text">没有暂时收起的回忆。</p>
          )}
        </Modal>
      )}
      {modal === "privacy" && (
        <Modal title="分享多少，由我们决定" close={close}>
          <div className="privacy-copy">
            <h3>关于本机空间</h3>
            <p>
              本机模式不联网同步。只有记录密文、加密密钥库与必要元数据会留在浏览器。示例模式的解锁凭据只保存在当前标签页会话中，关闭后可重新体验。
            </p>
            <h3>关于地图和 AI</h3>
            <p>
              这里不追踪位置、不记录在线状态。打开外部地图会把所选地点坐标交给地图服务。AI
              请求必须先选择、预览并单次确认；服务商的数据保留规则由所配置服务决定。
            </p>
            <h3>关于设备和退出空间</h3>
            <p>
              撤销设备只能阻止后续云端访问，不能撤回已经解密的内容。解除绑定会关闭双方的云端访问，请先导出需要保存的回忆。私人内容不会被另一方删除。
            </p>
          </div>
          <button
            className="secondary full"
            onClick={() => setModal("close-space")}
          >
            解除绑定 / 关闭空间
          </button>
          <button
            className="text-button full danger"
            onClick={() => setModal("clear-local")}
          >
            清除此模式的本机数据
          </button>
        </Modal>
      )}
      {modal === "close-space" && (
        <Modal title="关闭这个空间？" close={close}>
          <p className="muted">
            关闭后双方的云端读写会立即停止，记录不会自动删除。请先保存备份。这个操作无法在当前版本内撤销。
          </p>
          <button
            className="danger-button full"
            onClick={() =>
              run(async () => {
                await service.call("closeSpace");
                service.lock();
                setWelcomeMode("unlock");
                close();
              }, "空间已关闭，云端访问已停止")
            }
          >
            确认关闭空间
          </button>
        </Modal>
      )}
      {modal === "purge" && detail && (
        <Modal title="永久删除这条记录？" close={close}>
          <p className="muted">
            只删除你创建的这条回收站记录及照片密文。无法恢复，也无法撤回对方已有的副本。
          </p>
          <button
            className="danger-button full"
            onClick={() =>
              run(async () => {
                await service.purge(detail);
                close();
              }, "记录已永久删除")
            }
          >
            确认永久删除
          </button>
        </Modal>
      )}
      {modal === "clear-local" && (
        <Modal title="清除此模式的全部本机数据？" close={close}>
          <p className="muted">
            这会删除当前{mode === "demo" ? "示例" : "个人"}
            模式的本机密钥、记录密文和照片，无法撤销。请先确认已经保存需要的备份。
          </p>
          <button
            className="danger-button full"
            onClick={() => {
              Object.keys(localStorage)
                .filter((k) => k.startsWith(`us.${mode}.`))
                .forEach((k) => localStorage.removeItem(k));
              sessionStorage.removeItem("us.demo.password");
              localStorage.removeItem("us.mode");
              service.lock();
              setService(null);
              setWelcomeMode("welcome");
              close();
            }}
          >
            确认清除本机数据
          </button>
        </Modal>
      )}
    </div>
  );
}

function Empty({
  icon,
  title,
  text,
  action,
  label,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action: () => void;
  label: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
      <button className="secondary" onClick={action}>
        {label}
        <Plus size={14} />
      </button>
    </div>
  );
}

function Editor({
  kind,
  service,
  existing,
  busy,
  run,
  done,
}: {
  kind: string;
  service: UsService;
  existing?: Entry;
  busy: boolean;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  done: () => void;
}) {
  const isRelationship =
    kind === "relationship" || existing?.data.category === "relationship";
  const draft =
    !existing && kind === "memory"
      ? service.loadDraft<{ form: Payload; visibility: Visibility }>()
      : null;
  const [form, setForm] = useState<Payload>(
    existing?.data ||
      draft?.form || {
        kind: isRelationship ? "anniversary" : (kind as Payload["kind"]),
        ...(isRelationship ? { category: "relationship" } : {}),
        title: isRelationship ? "我们的小世界" : "",
        body: "",
        date: today(),
        tags: [],
        photos: [],
        unlockDate: addDays(today(), 30),
        yearly: true,
      },
  );
  const [visibility, setVisibility] = useState<Visibility>(
    existing?.visibility || draft?.visibility || "shared",
  );
  const [photosBusy, setPhotosBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [saved, setSaved] = useState("");
  const generation = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const initial = useRef(true);
  const set = (patch: Partial<Payload>) => setForm((f) => ({ ...f, ...patch }));
  useEffect(() => {
    if (existing || kind !== "memory") return;
    if (initial.current) {
      initial.current = false;
      return;
    }
    const id = setTimeout(() => {
      const value = ++generation.current;
      saving.current = saving.current
        .then(() => service.saveDraft({ form, visibility }))
        .then(() => {
          if (value === generation.current) setSaved("已在本机加密保存草稿");
        });
    }, 600);
    return () => clearTimeout(id);
  }, [form, visibility, service, existing, kind]);
  const upload = async (files: FileList | null) => {
    if (!files) return;
    setPhotosBusy(true);
    setPhotoError("");
    try {
      for (const file of Array.from(files).slice(
        0,
        Math.max(0, 6 - (form.photos?.length || 0)),
      )) {
        const prepared = await prepareBrowserPhoto(file);
        const bytes = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(prepared);
        });
        const photo = await service.addPhoto(
          bytes,
          prepared.type,
          file.name,
          visibility,
        );
        setForm((value) => ({
          ...value,
          photos: [...(value.photos || []), photo],
        }));
      }
    } catch (e) {
      setPhotoError((e as Error).message);
    } finally {
      setPhotosBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(
          async () => {
            if (form.kind === "capsule" && form.unlockDate! < today())
              throw new AppError("INVALID_DATE", "请选择今天或之后的开启日期");
            await saving.current;
            await service.save(form, visibility, existing);
            if (!existing && kind === "memory") service.storage.remove("draft");
            done();
          },
          isRelationship
            ? "恋爱开始日期已更新，首页天数已重新计算"
            : "这份温柔，已经好好收藏",
        );
      }}
    >
      <div className="editor-meta">
        <Field
          label={
            isRelationship
              ? "恋爱开始日期"
              : kind === "anniversary"
                ? "纪念日日期"
                : "记录日期"
          }
        >
          <input
            type="date"
            value={form.date}
            max={isRelationship ? today() : undefined}
            onChange={(e) => set({ date: e.target.value })}
            required
          />
        </Field>
        {kind === "memory" && (
          <Field label="谁可以看见">
            <select
              value={visibility}
              disabled={
                photosBusy || !!existing || !!form.photos?.some((p) => p.fileId)
              }
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="shared">我们两个人</option>
              <option value="private">只有我自己</option>
            </select>
          </Field>
        )}
      </div>
      {isRelationship && (
        <p className="muted">
          恋爱开始当天记为第 1
          天。保存后，首页天数和恋爱纪念日倒计时都会自动更新。
        </p>
      )}
      {!isRelationship && (
        <>
          <Field label="这一页的小标题">
            <input
              placeholder={
                kind === "capsule"
                  ? "写给未来的我们…"
                  : "今天，有什么值得记住？"
              }
              value={form.title}
              maxLength={80}
              onChange={(e) => set({ title: e.target.value })}
              required
            />
          </Field>
          <Field
            label={kind === "capsule" ? "想留给未来的话" : "慢慢写，不用着急"}
          >
            <textarea
              placeholder="或许只是一起喝了一杯咖啡，也很值得。"
              rows={kind === "memory" || kind === "capsule" ? 6 : 3}
              value={form.body || ""}
              maxLength={12000}
              onChange={(e) => set({ body: e.target.value })}
            />
          </Field>
        </>
      )}
      {kind === "memory" && (
        <>
          <div className="editor-meta">
            <Field label="今天的心情">
              <select
                value={form.mood || ""}
                onChange={(e) => set({ mood: e.target.value })}
              >
                <option value="">留白也很好</option>
                {moodOptions.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="小标签（用逗号分开）">
              <input
                value={form.tags?.join("，") || ""}
                placeholder="日常，约会，小幸福"
                onChange={(e) =>
                  set({ tags: e.target.value.split(/[,，]/).slice(0, 8) })
                }
              />
            </Field>
          </div>
          <div className="photo-upload">
            <label className="upload-button">
              <ImagePlus size={20} />
              <span>{photosBusy ? "正在整理并加密照片…" : "添加照片"}</span>
              <small>JPG / PNG / WebP，自动压缩至 ≤500 KB，最多 6 张</small>
              <input
                aria-label="添加照片"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                disabled={photosBusy || (form.photos?.length || 0) >= 6}
                onChange={(e) => upload(e.target.files)}
              />
            </label>
            <div className="editor-photos">
              {form.photos?.map((p) => (
                <div key={p.id}>
                  <Photo photo={p} visibility={visibility} service={service} />
                  <button
                    type="button"
                    aria-label="移除照片"
                    onClick={() =>
                      set({ photos: form.photos?.filter((x) => x.id !== p.id) })
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            {photoError && <p className="error-text">{photoError}</p>}
          </div>
        </>
      )}
      {kind === "capsule" && (
        <>
          <Field label="约定开启的日子">
            <input
              type="date"
              min={today()}
              value={form.unlockDate}
              onChange={(e) => set({ unlockDate: e.target.value })}
              required
            />
          </Field>
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!form.needsBoth}
              onChange={(e) => set({ needsBoth: e.target.checked })}
            />{" "}
            到期后，还需要我们两个人都确认
          </label>
        </>
      )}
      {kind === "place" && (
        <>
          <div className="editor-meta">
            <Field label="在哪个城市">
              <input
                value={form.city || ""}
                onChange={(e) => set({ city: e.target.value })}
                placeholder="文字地点也可以"
              />
            </Field>
            <Field label="足迹分类">
              <select
                value={form.category || "城市"}
                onChange={(e) => set({ category: e.target.value })}
              >
                {["城市", "旅行", "餐厅", "特别纪念", "未来想去"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
          </div>
          <details>
            <summary>可选：主动填写地图坐标（不会自动定位）</summary>
            <div className="editor-meta">
              <Field label="纬度">
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  value={form.latitude ?? ""}
                  onChange={(e) =>
                    set({
                      latitude: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </Field>
              <Field label="经度">
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  value={form.longitude ?? ""}
                  onChange={(e) =>
                    set({
                      longitude: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </Field>
            </div>
          </details>
        </>
      )}
      {kind === "wish" && (
        <Field label="这份期待有多特别">
          <select
            value={form.priority || "小小期待"}
            onChange={(e) => set({ priority: e.target.value })}
          >
            <option>小小期待</option>
            <option>很想实现</option>
            <option>慢慢来就好</option>
          </select>
        </Field>
      )}
      {kind === "anniversary" && !isRelationship && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={!!form.yearly}
            onChange={(e) => set({ yearly: e.target.checked })}
          />{" "}
          每一年，都想好好记住
        </label>
      )}
      {kind === "date" && (
        <div className="editor-meta">
          <Field label="约会地点">
            <input
              value={form.location || ""}
              onChange={(e) => set({ location: e.target.value })}
            />
          </Field>
          <Field label="大概预算（元）">
            <input
              type="number"
              min="0"
              value={form.budget || ""}
              onChange={(e) => set({ budget: e.target.value })}
            />
          </Field>
        </div>
      )}
      <div className="editor-footer">
        <span className="fineprint">
          <LockKeyhole size={12} />
          {saved || "保存前在本机加密"}
        </span>
        <button className="primary" disabled={busy || photosBusy}>
          {busy
            ? "正在收藏…"
            : isRelationship
              ? "保存恋爱开始日期"
              : kind === "capsule"
                ? "封存这份期待"
                : "收藏到我们的小世界"}
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
  );
}

function RestoreForm({
  service,
  mode,
  run,
  done,
}: {
  service: UsService | null;
  mode: "demo" | "personal";
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
  done: () => void;
}) {
  const [backup, setBackup] = useState<any>(null);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const values = await stageBackup(backup, key, password);
          commitBackup(mode, values);
          sessionStorage.removeItem("us.demo.password");
          done();
          window.location.reload();
        }, "备份已恢复，请用新口令解锁");
      }}
    >
      <p className="fineprint">
        导入会替换当前模式的本机数据库。请先保存当前备份；本机备份恢复不能迁移到不同微信账号。
      </p>
      <Field label="加密备份 JSON">
        <input
          type="file"
          accept="application/json,.json"
          required
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              try {
                setBackup(JSON.parse(await file.text()));
              } catch {
                setBackup(null);
              }
            }
          }}
        />
      </Field>
      <Field label="64 位恢复密钥">
        <textarea
          rows={3}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
        />
      </Field>
      <Field label="新的本机解锁口令">
        <input
          type="password"
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <button className="primary full">验证并恢复备份</button>
    </form>
  );
}
