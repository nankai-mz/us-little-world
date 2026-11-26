import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
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
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Shirt,
  Sparkles,
  Star,
  Sun,
  Trash2,
  UserRound,
  Utensils,
  WandSparkles,
} from "lucide-react";
import { UsService } from "../src/core/service";
import { Field } from "./Field";
import { RecordEditor, moodOptions } from "./RecordEditor";
import { SharedMemoryPhoto } from "./SharedMemoryPhoto";
import { CoverCredits, JournalCover, PhotoReplyButton, WelcomeCover } from "./JournalCover";
import { MealSlip, RecordPaper } from "./PaperObjects";
import { canReplyToPhoto, finishPhotoPair, receiptOf, stampMeal, stampNames, type MealStamp } from "../src/core/keepsakes";
import { prepareBrowserPhoto } from "./photos";
import { PasswordInput } from "./PasswordInput";
import { HomeCompanionship } from "./HomeCompanionship";
import type { GalaxyView } from "./MemoryGalaxy";
import { MemoryPages } from "./MemoryPages";
import { newBookDraft } from "./bookDraft";
import { ExternalMap } from "./ExternalMap";
import { OutboxPanel } from "./OutboxPanel";
import { useCalendarDay } from "./useCalendarDay";
import { ArchiveExport, RestoreForm } from "./BackupForms";
import { Modal } from "./Modal";
import { pairingRoute, parseWebRoute, playRoute, recordRoute, webRoute, type PlayTarget, type WebPage, type WebRoute } from "./routes";
import { playIdPattern } from "../src/features/play-core/protocol";
import {
  allowsUnlockMemory,
  deleteExpiredUnlock,
  forgetUnlock,
  rememberUnlock,
  restoreUnlock,
  setUnlockMemory,
  unlockDuration,
  unlockGeneration,
  unlockGenerationKey,
} from "./rememberedUnlock";
import { dailyQuestion } from "../src/core/questions";
import { type ConnectionStatus } from "../src/core/protocol";
import {
  AppError,
  type Attachment,
  type Device,
  type Entry,
  type Visibility,
} from "../src/core/types";
import {
  addDays,
  dateLabel,
  daysBetween,
  nextAnniversary,
  spaceDay,
  today,
  togetherDays,
} from "../src/core/date";
import { canOpenCapsule, report, secureChoice, SPACE_MEMBER_NAMES } from "../src/core/domain";
import { fingerprint, publicKeys, recoveryOnlyVault } from "../src/core/crypto";
import {
  createBrowserService,
  download,
} from "./platform";

const PlansPage = lazy(() => import("./PlansPage").then(({ PlansPage }) => ({ default: PlansPage })));
const QuestionRoom = lazy(() => import("./QuestionRoom").then(({ QuestionRoom }) => ({ default: QuestionRoom })));
const Playground = lazy(() => import("./features/playground/Playground").then(({ Playground }) => ({ default: Playground })));
const GalaxyWorks = lazy(() => import("./features/playground/GalaxyWorks").then(({ GalaxyWorks }) => ({ default: GalaxyWorks })));
const MealDecision = lazy(() => import("./MealDecision").then(({ MealDecision }) => ({ default: MealDecision })));
const MealNotebook = lazy(() => import("./MealDecision").then(({ MealNotebook }) => ({ default: MealNotebook })));
const Wardrobe = lazy(() => import("./Wardrobe").then(({ Wardrobe }) => ({ default: Wardrobe })));
const MemoryGalaxy = lazy(() => import("./MemoryGalaxy").then(({ MemoryGalaxy }) => ({ default: MemoryGalaxy })));
const MemoryBook = lazy(() => import("./MemoryBook").then(({ MemoryBook }) => ({ default: MemoryBook })));

const tabs = [
  { id: "home", label: "今天", sub: "今天", icon: Home },
  { id: "interaction", label: "一起做", sub: "一起做", icon: Gamepad2 },
  { id: "memories", label: "收藏册", sub: "收藏册", icon: Feather },
] as const;
const firstAvatar = { name: SPACE_MEMBER_NAMES[0], color: "a" };
const secondAvatar = { name: SPACE_MEMBER_NAMES[1], color: "b" };
const emptyEntries: Entry[] = [];
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
  return <SharedMemoryPhoto photo={photo} title="照片" service={service} visibility={visibility} className={className} />;
}
function currentWebRoute() {
  const next = parseWebRoute(window.location.pathname) ?? webRoute("home");
  const parent = window.history.state?.usRecordBackground;
  const background = next.record && typeof parent === "string" ? parseWebRoute(parent) : undefined;
  if (!next.record) return next;
  const record = next.record.kind === "new" && window.history.state?.usPhotoPage ? { kind: "new" as const, photo: true } : next.record;
  return recordRoute(record, background && !background.record ? background : webRoute("memories"));
}
export function App({ hosted }: { hosted?: { account: string; service: UsService; owner: boolean; signOut: () => Promise<void>; installation?: ReactNode } }) {
  const hostedService = hosted?.service;
  const account = hosted?.account;
  const [service, setService] = useState<UsService | null>(hosted?.service ?? null);
  const [mode, setMode] = useState<"demo" | "personal">(hosted ? "personal" : "demo");
  const [revision, setRevision] = useState(0);
  const [route, setRoute] = useState(() =>
    hosted && typeof window !== "undefined" && window.location && window.history ? currentWebRoute() : webRoute("home"),
  );
  const { page, section } = route;
  const [activeModal, setModal] = useState("");
  const [authorization, setAuthorization] = useState<{
    action: string; title: string; execute: () => Promise<unknown>; success: string;
  } | null>(null);
  const [websitePassword, setWebsitePassword] = useState("");
  const authorizationAttempt = useRef(0);
  const [activeEditing, setEditing] = useState<Entry | undefined>();
  const [editorTitle, setEditorTitle] = useState("");
  const [localPhotoPage, setLocalPhotoPage] = useState(false);
  const [activeDetail, setDetail] = useState<Entry | null>(null);
  const editorDirty = useRef(false);
  const target = route.record;
  const readOnly = service?.space?.status === "closing";
  const routedEntry = target && target.kind !== "new" ? service?.active.find((entry) =>
    entry.id === target.id && entry.data.kind === "memory") : undefined;
  const recordModal = target?.kind === "detail" ? (routedEntry ? "detail" : "")
    : !readOnly && (target?.kind === "new" || routedEntry) ? "edit:memory" : "";
  const settingsModal = hostedService && page === "profile" && (
    section === "devices" ? "security" : section === "backup"
      ? (service?.hasPrivateAccess ? "verify-backup" : "restore") : ""
  );
  const modal = authorization ? "authorize" : activeModal || recordModal || settingsModal || "";
  const editing = activeModal ? activeEditing : routedEntry;
  const detail = activeModal ? service?.active.find(e => e.id === activeDetail?.id) ?? activeDetail : routedEntry ?? null;
  const photoEditor = !!editing?.data.photoPage || (target?.kind === "new" && !activeModal ? !!target.photo : localPhotoPage && !editing);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [showCompanionship, setShowCompanionship] = useState(() =>
    !!account && localStorage.getItem(`us.web.${account}.companionship`) !== "false",
  );
  const [showGalaxy, setShowGalaxy] = useState(() =>
    !!account && localStorage.getItem(`us.web.${account}.memoryGalaxy`) !== "false",
  );
  const [galaxy, setGalaxy] = useState<GalaxyView>({ zoom: 1, year: "", page: 0 });
  const galaxyScroll = useRef({ left: 0, top: 0 });
  const [bookDraft, setBookDraft] = useState(() => newBookDraft(hosted ? spaceDay() : today()));
  const [spaceName, setSpaceName] = useState("我们的小世界");
  const [startDate, setStartDate] = useState(hosted ? spaceDay : today);
  const [baseWelcomeMode, setWelcomeMode] = useState(
    hostedService ? (hostedService.secrets ? "unlock" : hostedService.vault ? "resume" : "checking") : "welcome",
  );
  const pairingForm = hosted && route.pairing === (hosted.owner ? "create" : "join") ? route.pairing : undefined;
  const welcomeMode = baseWelcomeMode === "welcome" && pairingForm ? pairingForm : baseWelcomeMode;
  const [unlockExpiresAt, setUnlockExpiresAt] = useState(0);
  const [rememberUnlockOnDevice, setRememberUnlockOnDevice] = useState(() =>
    account ? allowsUnlockMemory(account) : false,
  );
  const [joinCode, setJoinCode] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
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
  const [showExternalMap, setShowExternalMap] = useState(() =>
    !!account && localStorage.getItem(`us.web.${account}.externalMap`) === "true",
  );
  const [showAiExperiment, setShowAiExperiment] = useState(() =>
    !!account && localStorage.getItem(`us.web.${account}.aiExperiment`) === "true",
  );
  const close = useCallback(() => {
    authorizationAttempt.current++;
    setModal("");
    setAuthorization(null);
    setWebsitePassword("");
    setDetail(null);
    setAiPreview(false);
    setAiConsent(false);
    setRecovery("");
    setBackupPassword("");
    setVerificationCode("");
    setNickname("");
    if (settingsModal && (!activeModal || (section === "backup" && ["recovery", "restore", "verify-backup"].includes(activeModal)))) {
      const next = webRoute("profile");
      if (window.history.state?.usSettingsBackground) window.history.back();
      else {
        window.history.replaceState(null, "", next.pathname);
        setRoute(next);
      }
    }
  }, [settingsModal, section, activeModal]);
  const unlocked = !!service?.ready;
  const sessionOpen = !!service?.secrets;
  useEffect(() => {
    if (!unlocked) {
      setBookDraft(newBookDraft(today()));
      setRecovery("");
      setBackupPassword("");
      setModal((current) =>
        ["recovery", "verify-backup"].includes(current) ? "" : current,
      );
    }
  }, [unlocked]);
  const notify = useCallback((message: string) => setToast(message), []);
  const copySecret = (value: string, label: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        notify(`已复制${label}`);
      } catch {
        notify(`无法访问剪贴板，请长按或选中${label}后复制`);
      }
    })();
  };
  const lockHostedSpace = useCallback(() => {
    hostedService?.lock();
    setPassword("");
    setUnlockExpiresAt(0);
    setWelcomeMode(hostedService?.vault ? "unlock" : "checking");
    close();
  }, [hostedService, close]);
  const handleRevokedDevice = useCallback((error: unknown) => {
    if (!account || !(error instanceof AppError) || !["DEVICE_REVOKED", "DEVICE_UNBOUND"].includes(error.code)) return false;
    void forgetUnlock(account).catch(() => {});
    lockHostedSpace();
    notify(error.code === "DEVICE_REVOKED" ? "这台设备的空间访问已被撤销。可使用自己的加密备份重新登记。"
      : "当前网站会话已切换设备。请重新解锁以验证这台设备。");
    return true;
  }, [account, lockHostedSpace, notify]);
  useEffect(() => {
    if (!account || !hostedService || welcomeMode !== "resume") return;
    let canceled = false;
    void (async () => {
      const saved = await restoreUnlock(account).catch(() => {
        if (!canceled) notify("浏览器无法读取上次解锁状态，请输入本机口令");
        return null;
      });
      try {
        if (!saved || canceled) return;
        await hostedService.unlockWithKey(saved.access);
        if (canceled || saved.expiresAt <= Date.now() || saved.generation !== unlockGeneration(account)) {
          hostedService.lock();
          return;
        }
        setUnlockExpiresAt(saved.expiresAt);
      } catch (error) {
        hostedService.lock();
        handleRevokedDevice(error);
      } finally {
        saved?.access.key.fill(0);
        if (!canceled) setWelcomeMode("unlock");
      }
    })();
    return () => { canceled = true; };
  }, [account, hostedService, welcomeMode, handleRevokedDevice, notify]);
  useEffect(() => {
    if (!account) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === unlockGenerationKey(account) || event.key === null) lockHostedSpace();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [account, lockHostedSpace]);
  useEffect(() => {
    if (!account || !unlockExpiresAt) return;
    const check = () => {
      if (Date.now() >= unlockExpiresAt) {
        lockHostedSpace();
        void deleteExpiredUnlock(account).catch(() => {});
      }
    };
    const timer = window.setTimeout(check, Math.max(0, unlockExpiresAt - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [account, unlockExpiresAt, lockHostedSpace]);
  async function openSpace<T>(action: () => Promise<T>): Promise<T> {
    if (!hostedService || !account) return action();
    const generation = unlockGeneration(account);
    const value = await action();
    const expiresAt = Date.now() + unlockDuration;
    const access = hostedService.getUnlockKey();
    if (access) {
      try {
        if (rememberUnlockOnDevice) await rememberUnlock(account, access, generation, expiresAt);
      } catch {
        notify("浏览器暂时无法记住解锁状态，刷新后需重新输入口令");
      } finally {
        access.key.fill(0);
      }
    }
    if (generation !== unlockGeneration(account)) {
      lockHostedSpace();
      throw new AppError("LOCKED", "此空间已锁定，请重新解锁");
    }
    setUnlockExpiresAt(rememberUnlockOnDevice ? expiresAt : 0);
    return value;
  }
  function changeUnlockMemory(remember: boolean) {
    if (!account) return;
    setRememberUnlockOnDevice(remember);
    void setUnlockMemory(account, remember).catch(() => {
      notify("浏览器未能保存此选项，请在用完后主动锁定空间");
    });
  }
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
      if (!handleRevokedDevice(e)) notify(e instanceof Error ? e.message : "暂时没有成功，请再试一次");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (modal !== "security" || !unlocked || !service) return;
    let active = true;
    setDevices([]);
    void service.devices().then((registered) => {
      if (active) setDevices(registered);
    }).catch((error) => {
      if (active && !handleRevokedDevice(error)) notify(error instanceof Error ? error.message : "设备列表暂时不可用");
    });
    return () => { active = false; };
  }, [modal, unlocked, service, handleRevokedDevice, notify]);
  const runSensitive = (
    action: string, title: string, execute: () => Promise<unknown>, success: string,
  ) => {
    if (!hosted) return void run(execute, success);
    setWebsitePassword("");
    setAuthorization({ action, title, execute, success });
  };
  const cancelAuthorization = useCallback(() => {
    authorizationAttempt.current++;
    setAuthorization(null);
    setWebsitePassword("");
  }, []);
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
    if (!hostedService || welcomeMode !== "checking") return;
    let canceled = false;
    hostedService.bootstrap().then(() => {
      if (!canceled) {
        const space = hostedService.space;
        setWelcomeMode(space?.status === "active" ? "device" : space ? "restore-only" : "welcome");
      }
    }).catch(() => {
      if (!canceled) setWelcomeMode("check-error");
    });
    return () => { canceled = true; };
  }, [hostedService, welcomeMode]);
  useEffect(() => {
    if (hosted) return;
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
  }, [notify, hosted]);
  useEffect(() => {
    if (!service?.ready) return;
    let stopped = false;
    let pending = false;
    const refresh = async (event?: Event) => {
      if (pending || (hostedService && document.hidden) || !service.ready) return;
      pending = true;
      const before = [service.entries, service.space, service.displayNames, service.lastSyncError, service.syncStorageWarning];
      try {
        await service.refresh();
        if (event?.type === "online" && service.supportsOutbox) await service.flushOutbox();
      } catch (error) {
        handleRevokedDevice(error);
      } finally {
        pending = false;
        const after = [service.entries, service.space, service.displayNames, service.lastSyncError, service.syncStorageWarning];
        if (!stopped && (event || before.some((value, index) => value !== after[index]))) setRevision((value) => value + 1);
      }
    };
    const id = window.setInterval(() => void refresh(), 30000);
    if (hostedService) {
      window.addEventListener("online", refresh);
      document.addEventListener("visibilitychange", refresh);
    }
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [service, hostedService, unlocked, handleRevokedDevice]);
  useEffect(() => {
    if (hostedService || !service || !sessionOpen) return;
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
  }, [hostedService, service, sessionOpen]);
  async function enterDemo(confirmReset = false) {
    await run(async () => {
      const s = createBrowserService("demo");
      const savedPassword = sessionStorage.getItem("us.demo.password");
      if (s.vault && savedPassword) await s.unlock(savedPassword);
      else {
        if (s.vault && !confirmReset) {
          setModal("reset-demo");
          return;
        }
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
      setModal("");
      setWelcomeMode("welcome");
    });
  }
  async function createPersonal() {
    await run(async () => {
      const s = hosted?.service ?? createBrowserService("personal");
      let key: string;
      try {
        key = await openSpace(() => welcomeMode === "join"
          ? s.join(password, joinCode)
          : s.create(password, spaceName, startDate));
      } catch (error) {
        if (hosted && s.vault && !s.ready) setWelcomeMode("unlock");
        else if (hosted && !s.ready && error instanceof AppError &&
          ["ALREADY_BOUND", "NETWORK_ERROR", "TIMEOUT", "LOCAL_STORAGE_UNAVAILABLE"].includes(error.code))
          setWelcomeMode("checking");
        throw error;
      }
      setService(s);
      setMode("personal");
      if (!hosted) localStorage.setItem("us.mode", "personal");
      setJoinCode("");
      if (!hosted || welcomeMode !== "join") {
        setRecovery(key);
        setModal("recovery");
      }
      if (hosted && welcomeMode === "join") {
        const next = pairingRoute("keys");
        window.history.replaceState(window.history.state, "", next.pathname);
        setRoute(next);
      }
      setPassword("");
    });
  }
  const day = useCalendarDay(!!hosted);
  const entries = service?.active ?? emptyEntries;
  const spaceMembers = service?.space?.members;
  const memberAvatars = [firstAvatar, secondAvatar].map((avatar, index) => ({
    ...avatar, name: (spaceMembers?.[index] && service?.displayNames.get(spaceMembers[index])) || avatar.name,
  }));
  const [myAvatar, partnerAvatar] = hosted && !hosted.owner
    ? [memberAvatars[1], memberAvatars[0]] : memberAvatars;
  const relationship = entries.find(
    (e) => e.data.kind === "anniversary" && e.data.category === "relationship",
  );
  const memories = useMemo(() => entries.filter((e) => e.data.kind === "memory"), [entries]);
  const places = useMemo(() => entries.filter((e) => e.data.kind === "place"), [entries]);
  const sharedMemories = useMemo(() => memories.filter((e) => e.visibility === "shared"), [memories]);
  const filteredMemories = useMemo(() => memories.filter(
    (e) =>
      (!search ||
        `${e.data.title} ${e.data.body} ${e.data.tags?.join(" ")}`.includes(
          search,
        )) &&
      (filter === "全部" ||
        (filter === "共同回忆" && e.visibility === "shared") ||
        (filter === "私人日记" && e.visibility === "private") ||
        (filter === "收藏" && e.data.favoriteBy?.includes(service?.userId ?? ""))) &&
      (!monthFilter || e.data.date.startsWith(monthFilter)) &&
      (authorFilter === "全部" ||
        (e.creatorId === service?.userId) === (authorFilter === "我")) &&
      (!tagFilter || e.data.tags?.some((t) => t.includes(tagFilter))),
  ), [memories, search, filter, monthFilter, authorFilter, tagFilter, service?.userId]);
  const petEntry = entries.find((e) => e.data.kind === "pet");
  const pet = petEntry?.data.pet;
  const nextEvent = useMemo(() => entries
    .filter((e) => e.data.kind === "anniversary")
    .map((e) => ({
      ...e,
      next: nextAnniversary(e.data.date, e.data.yearly, day),
    }))
    .filter((e) => e.next >= day)
    .sort((a, b) => a.next.localeCompare(b.next))[0], [entries, day]);
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
  const stats = useMemo(() => report(entries, reportFrom, day), [entries, reportFrom, day]);
  useEffect(() => {
    if (!hostedService) return;
    const restoreRoute = () => {
      const next = currentWebRoute();
      if (next.pathname === route.pathname) return;
      if (editorDirty.current && !window.confirm("还有未保存的编辑，确定离开吗？")) {
        window.history.pushState(route.record ? { usRecordBackground: next.pathname } : null, "", route.pathname);
        return;
      }
      editorDirty.current = false;
      setModal("");
      if (route.pairing) {
        setPassword("");
        setJoinCode("");
      }
      setRoute(next);
    };
    const guardReload = (event: BeforeUnloadEvent) => {
      if (!editorDirty.current) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("beforeunload", guardReload);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("beforeunload", guardReload);
    };
  }, [hostedService, route]);
  const closePairing = useCallback(() => {
    const previous = window.history.state?.usPairingBackground;
    const next = typeof previous === "string" ? parseWebRoute(previous) : undefined;
    const destination = next && !next.pairing ? next : webRoute("home");
    window.history.replaceState(null, "", destination.pathname);
    setPassword("");
    setJoinCode("");
    setRoute(destination);
  }, []);
  useEffect(() => {
    if (!hosted || !route.pairing) return;
    const setupUnavailable = ["device", "restore-only"].includes(baseWelcomeMode);
    const wrongAccount = route.pairing !== "keys" && !pairingForm;
    const noPairedDevice = route.pairing === "keys" && baseWelcomeMode === "welcome" && !sessionOpen;
    if (unlocked || setupUnavailable || wrongAccount || noPairedDevice) closePairing();
  }, [hosted, route.pairing, baseWelcomeMode, pairingForm, unlocked, sessionOpen, closePairing]);
  useEffect(() => {
    if (!hostedService || !unlocked || !service?.lastSyncedAt || !target || target.kind === "new" || routedEntry) return;
    const next = webRoute("memories");
    window.history.replaceState(null, "", next.pathname);
    setRoute(next);
    notify("这条回忆已移除或当前账号无法访问。");
  }, [hostedService, unlocked, service?.lastSyncedAt, target, routedEntry, notify]);
  const closeRecordRoute = useCallback(() => {
    const background = window.history.state?.usRecordBackground;
    if (background) window.history.back();
    else {
      const next = webRoute("memories");
      window.history.replaceState(null, "", next.pathname);
      setRoute(next);
    }
  }, []);
  const finishEditor = () => {
    editorDirty.current = false;
    if (target && !activeModal) closeRecordRoute();
    close();
  };
  const requestEditorClose = useCallback(() => {
    if (editorDirty.current && !window.confirm("还有未保存的编辑，确定离开吗？")) return;
    editorDirty.current = false;
    if (target && !activeModal) closeRecordRoute();
    close();
  }, [target, activeModal, closeRecordRoute, close]);
  const closeDetail = useCallback(() => {
    if (target && !activeModal) closeRecordRoute();
    close();
  }, [target, activeModal, closeRecordRoute, close]);
  function openRecordRoute(next: WebRoute) {
    const state = { usRecordBackground: route.record ? window.history.state?.usRecordBackground : route.pathname,
      usPhotoPage: next.record?.kind === "new" && !!next.record.photo };
    if (route.record) window.history.replaceState(state, "", next.pathname);
    else window.history.pushState(state, "", next.pathname);
    setModal("");
    setRoute(next);
  }
  function openSettingsPane(pane: "devices" | "backup") {
    if (!hostedService) {
      go("profile");
      setModal(pane === "devices" ? "security" : "verify-backup");
      return;
    }
    const next = webRoute("profile", pane);
    if (route.pathname !== next.pathname)
      window.history.pushState({ usSettingsBackground: true }, "", next.pathname);
    setModal("");
    setRoute(next);
  }
  function navigate(nextPage: WebPage, nextSection?: string) {
    const next = webRoute(nextPage, nextSection);
    if (hostedService && window.location.pathname !== next.pathname) {
      window.history.pushState(null, "", next.pathname);
    }
    setRoute(next);
  }
  function visitPlay(target?: PlayTarget) {
    const next = target ? playRoute(target) : webRoute("interaction");
    if (window.location.pathname !== next.pathname) window.history.pushState(null, "", next.pathname);
    close();
    setRoute(next);
    window.scrollTo(0, 0);
  }
  function setSection(nextSection: string) {
    navigate(page, nextSection);
  }
  function go(nextPage: WebPage, nextSection?: string) {
    navigate(nextPage, nextSection);
    setSearch("");
    setFilter("全部");
    setAiConsent(false);
    setAiPreview(false);
    window.scrollTo(0, 0);
  }
  function edit(kind: string, entry?: Entry, title = "", photo = false) {
    if (readOnly) return notify("空间处于只读期");
    setEditorTitle(title);
    setLocalPhotoPage(photo);
    if (hostedService && kind === "memory" && (!entry || /^[a-f0-9]{32,64}$/.test(entry.id))) {
      openRecordRoute(recordRoute(entry ? { kind: "edit", id: entry.id } : { kind: "new", photo }, route));
      return;
    }
    setEditing(entry);
    setModal(`edit:${kind}`);
  }
  function openPhotoEditor() {
    if (readOnly) return notify("空间处于只读期");
    flushSync(() => edit("memory", undefined, "", true));
    document.querySelector<HTMLInputElement>('.modal input[aria-label="添加照片"]')?.click();
  }
  const viewEntry = (e: Entry) => {
    if (hostedService && e.data.kind === "memory" && /^[a-f0-9]{32,64}$/.test(e.id)) {
      openRecordRoute(recordRoute({ kind: "detail", id: e.id }, route));
      return;
    }
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

  if (welcomeMode === "resume" || !service?.secrets || !service.space)
    return (
      <div className="welcome">
        <WelcomeCover />
        <div className="welcome-form">
          <Flower2 className="flower" size={40} />
          <h2>
            {welcomeMode === "unlock"
              ? "欢迎回到我们的小世界"
              : welcomeMode === "device"
                ? "已加入双人空间"
              : welcomeMode === "create"
                ? "故事，从今天开始"
                : "很高兴，在这里遇见你"}
          </h2>
          <p className="muted">
            {welcomeMode === "unlock"
              ? mode === "demo"
                ? "示例使用临时随机口令，没有需要你记住的默认密码。"
                : hostedService?.enrollmentPending
                  ? "本机已保存这次配对的加密密钥。输入原来设置的口令继续。"
                  : hosted
                  ? "输入本机解锁口令。这个浏览器会记住解锁状态 24 小时。"
                  : "输入本机解锁口令，打开你的加密手账。"
              : welcomeMode === "resume"
                ? "正在恢复本机解锁状态…"
              : welcomeMode === "device"
                ? hostedService?.initialDevicePending
                  ? "账号已绑定。请设置本机口令，继续完成首次登记。"
                  : "使用自己的加密备份可恢复共同和私人记录。也可以先登记这台设备，仅加入共同空间。"
              : welcomeMode === "checking"
                ? "正在查询账号的空间状态…"
              : welcomeMode === "check-error"
                ? "暂时无法查询空间状态，请重试。"
              : welcomeMode === "restore-only"
                ? "你的空间处于关闭冷静期。请使用已有的加密备份恢复密钥。"
              : hosted
                ? "请创建或加入你们的双人空间。"
                : "这里可以翻阅示例，也可以建立自己的本机手账。"}
          </p>
          {welcomeMode === "unlock" && mode === "demo" ? (
            <div className="demo-session-ended">
              <p>
                这是示例空间的临时会话，不需要你记住随机口令。原会话已结束，现有示例数据暂时保留。
              </p>
              <button
                className="secondary full"
                onClick={() => setWelcomeMode("welcome")}
              >
                返回体验入口
              </button>
              <p className="fineprint">
                重新进入示例前会询问是否重建；如果要保留修改，可先使用已导出的备份恢复。
              </p>
            </div>
          ) : ["checking", "resume"].includes(welcomeMode) ? null : welcomeMode === "check-error" ? (
            <button className="primary full" onClick={() => setWelcomeMode("checking")}>重试</button>
          ) : welcomeMode === "restore-only" ? (
            <button className="primary full" onClick={() => setModal("restore")}>使用备份恢复</button>
          ) : welcomeMode === "welcome" && hosted ? (
            <>
              <button className="primary full" onClick={() => {
                const next = pairingRoute(hosted.owner ? "create" : "join");
                window.history.pushState({ usPairingBackground: route.pathname }, "", next.pathname);
                setRoute(next);
              }}>
                {hosted.owner ? "创建双人空间" : "输入邀请码加入"}
              </button>
              <button className="secondary full" onClick={() => setModal("restore")}>使用备份恢复</button>
            </>
          ) : welcomeMode === "welcome" ? (
            <>
              <button
                className="primary full"
                onClick={() => enterDemo()}
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
                本机手账保存在这个浏览器。两人跨设备使用时，请登录双人网站。
              </p>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (busy) return;
                if (welcomeMode === "unlock")
                  run(async () => {
                    try {
                      await openSpace(() => service!.unlock(password));
                      setPassword("");
                    } catch (error) {
                      if (hosted && !service!.vault) setWelcomeMode("checking");
                      throw error;
                    }
                  });
                else if (welcomeMode === "device")
                  run(async () => {
                    try {
                      const recoveryKey = await openSpace(() => hostedService!.setUpDevice(password, { title: spaceName, date: startDate }));
                      if (recoveryKey) {
                        setRecovery(recoveryKey);
                        setModal("recovery");
                      }
                      setPassword("");
                    } catch (error) {
                      if (hostedService!.vault) setWelcomeMode("unlock");
                      throw error;
                    }
                  });
                else createPersonal();
              }}
            >
              {(welcomeMode === "create" || (welcomeMode === "device" && hosted?.owner && hostedService?.initialDevicePending)) && (
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
              {welcomeMode === "join" && (
                <Field label="一次性邀请码">
                  <input value={joinCode} maxLength={128} onChange={(event) => setJoinCode(event.target.value)} required />
                </Field>
              )}
              <Field label="本机解锁口令（至少 10 位）">
                <PasswordInput
                  value={password}
                  autoComplete={
                    welcomeMode === "unlock" ? "current-password" : "new-password"
                  }
                  minLength={10}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              {account && <label className="unlock-memory-option">
                <input type="checkbox" checked={rememberUnlockOnDevice}
                  onChange={(event) => changeUnlockMemory(event.target.checked)} disabled={busy} />
                <span>在此浏览器记住解锁 24 小时</span>
              </label>}
              <button className="primary full" disabled={busy}>
                {busy
                  ? "正在打开…"
                  : welcomeMode === "unlock"
                    ? "打开小世界"
                    : welcomeMode === "device"
                      ? hostedService?.initialDevicePending ? "继续完成首次登记" : "登记设备，仅加入共同空间"
                      : welcomeMode === "join" ? "加入双人空间" : "创建我们的空间"}
              </button>
              {(!hosted || ["create", "join"].includes(welcomeMode)) && <button
                className="text-button full"
                type="button"
                onClick={() => {
                  if (route.pairing) closePairing();
                  else setWelcomeMode(hosted ? "checking" : "welcome");
                }}
              >
                返回
              </button>}
              {["unlock", "device"].includes(welcomeMode) && (
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
          {hosted && <button className="text-button full" disabled={busy} onClick={() => run(hosted.signOut)}>退出网站账号</button>}
        </div>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        {modal === "reset-demo" && (
          <Modal title="重建示例前，请确认数据范围" close={close}>
            <p>
              这会清除示例里的日期、日记、照片和其他修改，重新生成示例。个人加密空间不受影响。如果要保留修改，请先用已导出的备份恢复。
            </p>
            <button className="secondary full" onClick={close}>
              保留原示例，返回
            </button>
            <button
              className="danger-button full"
              disabled={busy}
              onClick={() => enterDemo(true)}
            >
              确认重建示例
            </button>
          </Modal>
        )}
        {modal === "restore" && (
          <Modal title="恢复加密备份" close={close}>
            <RestoreForm
              service={service}
              hosted={!!hosted}
              openSpace={openSpace}
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

  if (hosted && !unlocked)
    return (
      <main className="key-setup">
        <section className="welcome-form" aria-labelledby="key-setup-title">
          <ShieldCheck className="flower" size={40} />
          <h2 id="key-setup-title">已加入双人空间</h2>
          <p>正在等待空间密钥。接收后，即可查看你们的共同记录。</p>
          <Field label="我的设备安全码">
            <input
              readOnly
              value={fingerprint(publicKeys(service.secrets))}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <button className="text-button" type="button" onClick={() =>
            copySecret(fingerprint(publicKeys(service.secrets!)), "设备安全码")
          }>复制安全码</button>
          <p>
            把上面的安全码发给对方。请对方在「我的空间 → 设备与安全」核对你的安全码，
            向这台设备发送空间密钥，并把对方的设备安全码发给你。
          </p>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (busy || !verificationCode.trim()) return;
            run(async () => {
              const firstKey = Object.keys(service.secrets!.spaceKeys).length === 0;
              await service.receive(verificationCode.trim());
              setVerificationCode("");
              const recoveryKey = service.secrets?.recoveryKey;
              if (firstKey && service.ready && service.hasPrivateAccess && recoveryKey) {
                setRecovery(recoveryKey);
                setModal("recovery");
              }
            }, "已接收空间密钥");
          }}>
            <Field label="对方的设备安全码">
              <input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} required />
            </Field>
            <button className="primary full" disabled={busy || !verificationCode.trim()}>
              接收空间密钥
            </button>
          </form>
          {toast && <p role="status" className="muted">{toast}</p>}
          <button className="text-button full" disabled={busy} onClick={() => run(hosted.signOut)}>
            退出网站账号
          </button>
        </section>
      </main>
    );

  const memoryFilters = JSON.stringify([search, filter, monthFilter, authorFilter, tagFilter]);
  const showMemories = (rows: Entry[], compact = false) =>
    rows.length ? (
      <div className={compact ? "memory-grid" : "timeline-grid"}>
        {rows.map((e) => (
          <article className={`memory-card ${receiptOf(e.data) ? "receipt-memory" : e.data.photoPage ? "photo-memory" : ""}`} key={e.id}>
            <button className="memory-open" onClick={() => viewEntry(e)}>
              {receiptOf(e.data) ? <MealSlip receipt={receiptOf(e.data)!} date={e.data.date} names={service.displayNames} userId={service.userId}/> : e.data.photos?.[0] ? (
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
              disabled={readOnly || busy}
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
      <a className="journal-skip" href="#journal-main">跳到主要内容</a>
      <header className="journal-mast">
        <button className="journal-brand" onClick={() => go("home")} aria-label="我们的小世界首页"><b>Us<span>.</span></b><span>我们的小世界</span></button>
        <nav className="journal-nav" aria-label="桌面主导航">
          {tabs.map(t => <button key={t.id} aria-current={(page === t.id || (page === "plans" && t.id === "interaction")) ? "page" : undefined}
            onClick={() => go(t.id)}>{t.label}</button>)}
        </nav>
        <div className="top-actions">
          <button className="icon-button" aria-label="隐私与安全" onClick={() => openSettingsPane("devices")}><ShieldCheck size={17}/></button>
          <button className="icon-button" aria-label="切换深浅主题" onClick={() => setDark(v => !v)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button>
          <button className="icon-button" aria-label="刷新" onClick={() => run(() => service.refresh(), "已经是最新的时光了")}><RefreshCw size={17} className={busy ? "spin" : ""}/></button>
          <button className={`avatar small ${myAvatar.color}`} aria-label="打开我的空间" aria-current={page === "profile" ? "page" : undefined} onClick={() => go("profile")}>{[...myAvatar.name][0]}</button>
        </div>
      </header>
      <main id="journal-main">
        <div className="content">
          {(service.space?.status === "closing" ||
            !!service.space?.closeConfirmations?.length) && (
            <section className="closing-notice" aria-label="空间关闭状态">
              <h2>
                {service.space?.status === "closing"
                  ? "空间处于七天关闭冷静期"
                  : "已收到关闭空间请求"}
              </h2>
              <p>
                {service.space?.status === "closing"
                  ? `当前只可查看和导出。预计在 ${new Date(service.space.purgeAfter!).toLocaleString("zh-CN")} 后由清理任务删除云端数据。若已有成员建立新空间，将无法撤销关闭。`
                  : "双方确认后才解除绑定并开始七天冷静期，到期将清理双方共同及私人云端数据。目前仍可正常使用，任一方可以撤销请求。"}
              </p>
              {service.space?.status === "active" && (
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    service.space.closeConfirmations?.includes(service.userId)
                  }
                  onClick={() =>
                    runSensitive("closeSpace", "同意关闭空间", () => service.closeSpace(), "关闭状态已更新")
                  }
                >
                  {service.space.closeConfirmations?.includes(service.userId)
                    ? "等待对方确认"
                    : "同意关闭并启动七天冷静期"}
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  runSensitive(
                    "cancelClose", "撤销关闭",
                    () => service.cancelClose(),
                    "关闭已撤销，双方可以继续使用",
                  )
                }
              >
                撤销关闭
              </button>
              <button
                className="text-button"
                onClick={() => setModal("export")}
              >
                先导出备份
              </button>
              {service.space?.status === "closing" && (
                <button
                  className="text-button"
                  onClick={() => setModal("new-space")}
                >
                  建立新空间
                </button>
              )}
            </section>
          )}
          {page !== "home" && <div className="page-heading journal-heading">
            <h1>{page === "memories" ? "我们的收藏册" : page === "interaction" ? "一起做点什么？" : page === "plans" ? "未来清单" : "我的空间"}</h1>
            <time dateTime={day}>{dateLabel(day)}</time>
          </div>}
          {(page === "interaction" || page === "plans") && <nav className="journal-sections" aria-label="一起做的栏目">
            <button aria-current={page === "interaction" ? "page" : undefined} onClick={() => go("interaction")}>一起玩耍</button>
            <button aria-current={page === "plans" ? "page" : undefined} onClick={() => go("plans")}>未来清单</button>
          </nav>}
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
          <Suspense fallback={<p role="status">正在打开页面…</p>}>
          {page === "home" && (
            <>
              <div className="journal-dateline">
                <time dateTime={day}>{dateLabel(day)}</time>
                <div className="journal-byline side-space"><strong className="hero-avatars">{memberAvatars.map(x => x.name).join(" & ")}</strong></div>
                <button type="button" disabled={readOnly} aria-label="设置恋爱开始日期" onClick={() => edit("relationship", relationship)}>
                  在一起 <strong className="together-number">{togetherDays(relationship?.data.date || day, day)}<span>天</span></strong>
                </button>
              </div>
              <JournalCover day={day} shared={sharedMemories} dates={entries} service={service} reduced={reduceMotion}
                readOnly={!!readOnly} open={viewEntry} compose={openPhotoEditor}/>
              <div className="quick-actions">
                {[
                  {
                    icon: Feather,
                    title: "写一篇日记",
                    subtitle: "从一句话开始",
                    action: () => edit("memory"),
                  },
                  {
                    icon: ImagePlus,
                    title: "收藏新照片",
                    subtitle: "给相纸留出另一半",
                    action: openPhotoEditor,
                  },
                  {
                    icon: Mail,
                    title: "给未来的信",
                    subtitle: "选一个拆信日",
                    action: () => edit("capsule"),
                  },
                  {
                    icon: Sparkles,
                    title: "随机一段回忆",
                    subtitle: "重逢过去的某一天",
                    action: randomMemory,
                  },
                ].map((q, i) => (
                  <button key={q.title} disabled={readOnly && q.action !== randomMemory} onClick={q.action}>
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
              <div className="journal-today-extra">
                <section className="mood-card">
                  <div className="section-title">
                    <h2>
                      <Sun size={18} /> 今日小心情
                    </h2>
                    <span className="tiny">轻轻告诉对方</span>
                  </div>
                  <div className="mood-row">
                    <span className={`avatar ${myAvatar.color}`}>{[...myAvatar.name][0]}</span>
                    <div>
                      <strong>
                        我今天<span className="tiny"> · 主动分享</span>
                      </strong>
                      <button
                        className="mood-bubble"
                        disabled={readOnly}
                        onClick={() => setModal("mood")}
                      >
                        {mood?.data.mood || "今天，感觉怎么样？"}
                        <ChevronDown size={13} />
                      </button>
                    </div>
                    <span className="mood-sun">☀</span>
                  </div>
                  <div className="mood-row">
                    <span className={`avatar ${partnerAvatar.color}`}>{[...partnerAvatar.name][0]}</span>
                    <div>
                      <strong>
                        {hosted || mode === "demo" ? partnerAvatar.name : "对方"}
                        <span className="tiny"> · 只展示分享的心情</span>
                      </strong>
                      <span className="mood-bubble lavender">
                        {partnerMood?.data.mood || "还没有分享心情"}
                      </span>
                    </div>
                    <span className="mood-cloud">☁</span>
                  </div>

                </section>
                <section className="journal-agenda"><CalendarDays size={21}/><h2>接下来的计划</h2>
                  <p>{nextEvent ? `${dateLabel(nextEvent.next)} · ${nextEvent.data.title}` : "在日历上约一个两个人都有空的日子。"}</p>
                  <button className="text-button" onClick={() => go("plans", "dates")}>翻看约会票 <ArrowRight size={15}/></button>
                  {nextEvent && <button className="text-button" onClick={() => go("plans", "anniversaries")}>查看特别日子</button>}
                </section>
              </div>
              {hosted && showCompanionship && (
                <HomeCompanionship service={service} day={day} busy={busy} run={run} open={viewEntry} />
              )}
              <div className="home-bottom">
                <section>
                  <div className="section-title">
                    <h2>最近收进来的</h2>
                    <button
                      className="text-button"
                      onClick={() => go("memories", "timeline")}
                    >
                      翻翻全部回忆
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {showMemories(sharedMemories.slice(0, 2), true)}

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
                  <button type="button"
                    className="pet-illustration"
                    aria-label="打开糯米的小屋"
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
                  </button>
                  <div className="pet-bottom">
                    <span>
                      <span className="dot green" />{" "}
                      {pet?.mood && pet.mood > 70
                        ? "正在快乐地发呆"
                        : "期待你来陪它"}
                    </span>
                    <button
                      className="pet-feed"
                      disabled={busy || readOnly}
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
              {!service.hasPrivateAccess && <p className="fineprint">
                此设备仅能使用共同空间。<button type="button" className="text-button" onClick={() => setModal("restore")}>恢复私人记录</button>
              </p>}
              <div className="toolbar">
                <div className="pills">
                  {[
                    ["timeline", "时间轴"],
                    ["album", "相册"],
                    ...(hosted && showGalaxy ? [["galaxy", "回忆银河"]] : []),
                    ...(hosted ? [["book", "回忆纪念册"]] : []),
                    ["capsules", "时光胶囊"],
                    ["map", "共同足迹"],
                    ["report", "回忆报告"],
                    ...(!hosted || showAiExperiment ? [["ai", "AI 回忆助手"]] : []),
                  ].map(([id, name]) => (
                    <button
                      className={section === id ? "selected" : ""}
                      onClick={() => {
                        setSection(id);
                        if (id === "galaxy" && filter === "私人日记") setFilter("共同回忆");
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
                    disabled={readOnly}
                  onClick={() => section === "album" ? openPhotoEditor() :
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
                      : section === "album" ? "收藏新照片" : "记一笔"}
                </button>
              </div>
              {section === "galaxy" && (!hosted || !showGalaxy) && (
                <section className="card"><h2>回忆银河</h2>
                  <button className="secondary" onClick={() => go("profile")}>前往设置</button>
                </section>
              )}
              {section === "book" && hosted && (
                <MemoryBook memories={memories} service={service} draft={bookDraft} setDraft={setBookDraft} openMemory={viewEntry} />
              )}
              {(["timeline", "album"].includes(section) || (section === "galaxy" && hosted && showGalaxy)) && (
                <>
                  <div className="filter-row">
                    <div className="pills small">
                      {["全部", "共同回忆", ...(section === "galaxy" ? [] : ["私人日记"]), "收藏"].map((f) => (
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
                  <details className="journal-filters">
                    <summary>更多筛选{(monthFilter || authorFilter !== "全部" || tagFilter) && " · 已启用"}</summary>
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
                  </details>
                  {section === "timeline" ? (
                    <MemoryPages key={`timeline:${memoryFilters}`} label="回忆时间轴" items={filteredMemories} render={showMemories} />
                  ) : section === "galaxy" ? (
                    <>
                      <MemoryGalaxy entries={filteredMemories} allEntries={memories} service={service}
                        state={galaxy} setState={setGalaxy} scrollPosition={galaxyScroll.current}
                        reduceMotion={reduceMotion} openMemory={viewEntry} />
                      {hosted && <Suspense fallback={null}><GalaxyWorks service={service} navigate={visitPlay} /></Suspense>}
                    </>
                  ) : (
                    <MemoryPages key={`album:${memoryFilters}`} label="回忆相册"
                      items={filteredMemories.flatMap((e) => (e.data.photos ?? []).map((p) => ({ e, p })))}
                      render={(photos) => <div className="album-grid">
                        {photos.map(({ e, p }) => (
                          <button
                            key={`${e.id}:${p.id}`}
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
                        ))}
                      {photos.length === 0 && (
                        <Empty
                          icon={<Camera />}
                          title="相册的第一页，留给你"
                          text="在日记中添加照片，就会出现在这里。"
                          action={() => edit("memory")}
                          label="收藏照片"
                        />
                      )}
                    </div>} />
                  )}
                </>
              )}
              {section === "capsules" && (
                <>
                  <div className="feature-banner capsule-banner">
                    <Mail size={58} />
                    <div>
                      <h2>寄给未来的信</h2>
                      <p>写下今天想说的话，约一个拆信日。</p>
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
                            canOpenCapsule(e, service.space!.members, day) ? (
                              <Mail size={28} />
                            ) : (
                              <LockKeyhole size={28} />
                            )}
                          </span>
                          {e.data.category && <span className="eyebrow">{e.data.category}</span>}
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
                                disabled={busy || readOnly}
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
                            disabled={busy || (readOnly && !e.data.openedAt)}
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
                            disabled={busy || readOnly}
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
                      <h2>我们的足迹明信片</h2>
                      <p>从去过的地方寄一张，写下想记住的事。</p>
                    </div>
                    <span className="map-count">
                      {places.length}
                      <small>处共同记忆</small>
                    </span>
                  </div>
                  <div className="map-layout">
                    <div className="illustrated-map">
                      <div className="map-river" />
                      <span className="map-land land-a" />
                      <span className="map-land land-b" />
                      <span className="map-label">OUR MEMORY MAP</span>
                      {places.slice(0, 9)
                        .map((e, i) => (
                          <button
                            style={{
                              left: `${22 + (i % 3) * 24}%`,
                              top: `${27 + Math.floor(i / 3) * 24}%`,
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
                        {places.length > 9 ? "地图显示最近 9 处足迹，完整记录见列表" : "足迹手绘示意 · 点按标记回看故事"}
                      </span>
                    </div>
                    <div>
                      <div className="section-title">
                        <h2>一起去过的地方</h2>
                      </div>
                      {places.map((e) => (
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
                      {(!hosted || showExternalMap) && <ExternalMap entries={entries} />}
                    </div>
                  </div>
                </>
              )}
              {section === "report" && (
                <div className="report-page">
                  <div className="report-cover">
                    <h2>
                      {day.slice(0, 4)}
                      <span>
                        我们的{reportRange === "year" ? "这一年" : "这个月"}
                      </span>
                    </h2>
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
                    <p className="fineprint">
                      宠物日统计保留 400 天，明细保留 30
                      天，更早互动只保留累计次数。
                    </p>
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
                    {(!hosted || showAiExperiment) && <button
                      className="text-button"
                      onClick={() => setSection("ai")}
                    >
                      <WandSparkles size={16} /> 为回忆写段话
                    </button>}
                  </div>
                  <p className="fineprint">
                    统计在本机计算，仅包括所选日期内的共同内容。PDF
                    通过浏览器打印窗口保存。
                  </p>
                </div>
              )}
              {section === "ai" && hosted && !showAiExperiment && (
                <section className="card"><h2>AI 回忆助手</h2>
                  <button className="secondary" onClick={() => go("profile")}>前往设置</button>
                </section>
              )}
              {section === "ai" && (!hosted || showAiExperiment) && (
                <div className="ai-layout">
                  <section className="card">
                    <WandSparkles className="rose" size={32} />
                    <h2>让零散的回忆，连成一段故事</h2>
                    <p className="muted">
                      {hosted ? "选取共同回忆，在本机预览用于整理的文字。" : "先选几条共同回忆，再预览本次要发送的文字。"}
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
                      {hosted ? "在本机预览" : "预览将发送的内容"}
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
                        <h3>{hosted ? "所选共同回忆" : "这一次，只发送这些文字"}</h3>
                        <pre>
                          {sharedMemories
                            .filter((e) => aiSelected.includes(e.id))
                            .map(
                              (e) =>
                                `${e.data.date} ${e.data.title}\n${e.data.body || ""}`,
                            )
                            .join("\n\n")}
                        </pre>
                        {hosted ? <>
                          <p className="fineprint">当前网站尚未配置 AI 服务，文字仅在本机预览。</p>
                          <button type="button" className="secondary" onClick={() => setAiPreview(false)}>关闭预览</button>
                        </> : <><label className="check-line">
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
                          disabled={
                            !aiConsent ||
                            busy ||
                            service.space?.members.length !== 2
                          }
                          onClick={() =>
                            run(async () => {
                              setAiConsent(false);
                              const result = await service.ai(
                                aiSelected,
                                Date.now(),
                                "story",
                              );
                              setAiResult(result.text);
                            }, "回忆文案已经生成")
                          }
                        >
                          确认并生成
                        </button>
                        <p className="fineprint">
                          本机预览未连接 AI 服务。微信版需配置服务地址、模型与
                          API 密钥。 正式整理需已绑定两位成员；输入最多 6000
                          字，每空间每天最多 10 次。
                        </p></>}
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
              {section !== "games" && <div className="toolbar">
                <div className="pills">
                  {[
                    ["pet", "糯米的小屋"],
                    ["question", "每日问答"],
                    ["quiz", "默契小问答"],
                    ["roulette", "约会转盘"],
                    ["truth", "真心话"],
                    ["food", "今天吃什么"],
                    ...(hosted ? [["wardrobe", "今天穿什么"]] : []),
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
              </div>}
              {section === "food" && hosted && <MealDecision service={service} busy={busy} run={run} open={viewEntry} />}
              {section === "food" && !hosted && <MealNotebook service={service} busy={busy} run={run} open={viewEntry} />}
              {section === "wardrobe" && hosted && <Wardrobe service={service} busy={busy} run={run}
                photo={(attachment, visibility) => <Photo photo={attachment} visibility={visibility} service={service} />} />}
              {section === "games" && (
                (() => {
                const routines = <>
                  <div className="activity-spread">
                    <button className="activity-meal" onClick={() => setSection("food")}><Utensils size={24}/><strong>今天吃什么？</strong>
                      <span>{hosted ? "选一道两个人都想吃的菜" : "给今天这顿饭留张小票"} <ArrowRight size={16}/></span></button>
                    <button className="activity-date" onClick={() => go("plans", "dates")}><CalendarDays size={23}/><strong>约个日子见面</strong>
                      <span>打开双人约会票 <ArrowRight size={16}/></span></button>
                  </div>
                  <div className="game-grid">
                    {[
                      ...(hosted ? [{ id: "wardrobe", icon: Shirt, title: "今天穿什么", text: "从自己的衣橱挑几件，让对方帮你搭一身。", note: "打开双人衣橱" }] : []),
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
                          g.id === "challenge" ? edit("wish", undefined, g.text) : setSection(g.id)
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
                </>;
                return hosted ? <Suspense fallback={route.play ? <p>正在打开双人游乐园…</p> : routines}>
                  <Playground service={service} target={route.play} fallback={routines} navigate={visitPlay} openMemory={viewEntry} reduceMotion={reduceMotion} />
                </Suspense> : routines;
                })()
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
                          disabled={busy || readOnly}
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
                          disabled={busy || readOnly}
                          defaultValue={pet?.name}
                          maxLength={12}
                        />
                        <button className="primary" disabled={busy || readOnly}>保存</button>
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
                          disabled={busy || readOnly}
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
                    <p className="fineprint">
                      累计陪伴 {pet?.totalActions ?? pet?.history.length ?? 0}{" "}
                      次。保留最近 30 天明细、400 天日统计，累计次数长期保留。
                    </p>
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
                  day={day}
                  busy={busy || readOnly}
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
                          disabled={readOnly}
                          onClick={() => {
                            edit("date", undefined, roulette);
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
            <PlansPage section={section} setSection={setSection} entries={entries} day={day}
              service={service} edit={edit} run={run} />
          )}

          {page === "profile" && (
            <div className="profile-layout">
              <section className="card profile-card">
                <span className={`avatar ${myAvatar.color} xlarge`}>{[...myAvatar.name][0]}</span>
                <h2>{hosted || mode === "demo" ? myAvatar.name : "我的小角落"}</h2>
                {hosted && service.space?.status === "active" && (
                  <button className="text-button" onClick={() => {
                    setNickname(service.displayNames.get(service.userId) ?? "");
                    setModal("nickname");
                  }}>修改昵称</button>
                )}
                <p className="muted">愿每个平凡的日子，都有小小的喜欢。</p>
                <span className="private-badge">
                  <LockKeyhole size={13} />{" "}
                  {hosted ? "私密双人空间" : mode === "demo" ? "本机示例空间" : "本机加密空间"}
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
                  disabled={busy}
                  onClick={() => {
                    if (account) {
                      void forgetUnlock(account).catch(() => {});
                      lockHostedSpace();
                      return;
                    }
                    service.lock();
                    sessionStorage.removeItem("us.demo.password");
                    setWelcomeMode("unlock");
                    update();
                  }}
                >
                  <LockKeyhole size={15} /> 锁上我的小世界
                </button>
                {hosted && <button className="text-button full" disabled={busy} onClick={() => run(hosted.signOut)}>退出网站账号</button>}
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
                    action: () => openSettingsPane("devices"),
                  },
                  {
                    icon: KeyRound,
                    title: service.hasPrivateAccess ? "备份与恢复密钥" : "恢复私人记录",
                    text: "为重要的回忆留一把备用钥匙",
                    action: () => openSettingsPane("backup"),
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
                    text: "外部服务、关闭空间与本机数据",
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
              <details className="card profile-preferences" open>
                <summary>偏好、离线与安装</summary>
                {account && (
                  <label className="motion-preference">
                    <span>本机密文缓存<small>断网时可用本机口令查看最近 24 小时内缓存的日记和照片。</small></span>
                    <input type="checkbox" checked={service.cipherCacheEnabled} disabled={busy}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void run(() => service.setCipherCacheEnabled(enabled));
                      }} />
                  </label>
                )}
                {hosted?.installation}
                {account && (
                  <label className="motion-preference">
                    <span>站内陪伴<small>首页显示想你、回送与那年今日</small></span>
                    <input type="checkbox" checked={showCompanionship} onChange={(event) => {
                      const next = event.target.checked;
                      void run(async () => {
                        service.storage.set("companionship", String(next));
                        setShowCompanionship(next);
                      });
                    }} />
                  </label>
                )}
                {account && (
                  <label className="motion-preference">
                    <span>回忆银河<small>在「时光」查看共同回忆的照片星图</small></span>
                    <input type="checkbox" checked={showGalaxy} onChange={(event) => {
                      const next = event.target.checked;
                      void run(async () => {
                        service.storage.set("memoryGalaxy", String(next));
                        setShowGalaxy(next);
                      });
                    }} />
                  </label>
                )}
                {account && <>
                  <label className="motion-preference">
                    <span>外部地图试用<small>逐次确认要提供给高德地图的经纬度</small></span>
                    <input type="checkbox" checked={showExternalMap} onChange={(event) => {
                      const next = event.target.checked;
                      void run(async () => { service.storage.set("externalMap", String(next)); setShowExternalMap(next); });
                    }} />
                  </label>
                  <label className="motion-preference">
                    <span>AI 回忆助手试用<small>在本机预览选中的共同文字</small></span>
                    <input type="checkbox" checked={showAiExperiment} onChange={(event) => {
                      const next = event.target.checked;
                      void run(async () => {
                        service.storage.set("aiExperiment", String(next));
                        setAiPreview(false);
                        setAiSelected([]);
                        setShowAiExperiment(next);
                      });
                    }} />
                  </label>
                </>}
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
              </details>
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
          </Suspense>
          <footer className="app-footer">
            <span>Us. / 生活收集册</span><CoverCredits/>
          </footer>
        </div>
      </main>
      <nav className="mobile-nav journal-mobile" aria-label="移动端主导航">
        {tabs.map(t => <button key={t.id} aria-current={(page === t.id || (page === "plans" && t.id === "interaction")) ? "page" : undefined}
          onClick={() => go(t.id)}><t.icon size={19}/><span>{t.sub}</span></button>)}
        <button aria-current={page === "profile" ? "page" : undefined} onClick={() => go("profile")}><UserRound size={19}/><span>我的</span></button>
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
                : modal === "edit:memory" && photoEditor ? "留一张相纸" : kindNames[modal.slice(5)] || "记一笔"
          }
          subtitle={
            modal === "edit:relationship" ||
            editing?.data.category === "relationship"
              ? "首页会从这一天开始计算我们的在一起天数。"
              : photoEditor && modal === "edit:memory" ? "一张照片就能保存。选“我们两个人”，对方也可以接上一张。" : undefined
          }
          close={requestEditorClose}
          wide
        >
          {readOnly && <p role="status">空间已进入只读期。撤销关闭后可继续编辑。</p>}
          <div inert={readOnly}>
            <RecordEditor
              key={editing?.id ?? (photoEditor ? "new-photo" : modal)}
              photoMode={photoEditor && modal === "edit:memory"}
              kind={modal.slice(5)}
              initialTitle={editorTitle}
              service={service}
              existing={editing}
              busy={busy || readOnly}
              run={run}
              done={finishEditor}
              dirty={editorDirty}
            />
          </div>
        </Modal>
      )}
      {modal === "nickname" && (
        <Modal title="修改昵称" close={close}>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (busy || readOnly) return;
            void run(async () => { await service.saveDisplayName(nickname); close(); }, "昵称已保存");
          }}>
            <Field label="共同空间显示的昵称">
              <input value={nickname} disabled={busy || readOnly} maxLength={32} placeholder={hosted?.owner ? firstAvatar.name : secondAvatar.name}
                onChange={(event) => setNickname(event.target.value)} />
            </Field>
            <button className="primary full" disabled={busy || readOnly}>保存昵称</button>
          </form>
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
                disabled={busy || readOnly}
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
          close={closeDetail}
          wide
        >
          {detail.data.kind !== "memory" && <RecordPaper data={detail.data} reveal/>}
          {hosted && detail.data.playWorkId && playIdPattern.test(detail.data.playWorkId) &&
            <button onClick={() => visitPlay({ kind: "work", id: detail.data.playWorkId! })}>打开关联作品</button>}
          {receiptOf(detail.data) && <div className="receipt-detail">
            <MealSlip receipt={receiptOf(detail.data)!} date={detail.data.date} names={service.displayNames} userId={service.userId}/>
            {detail.visibility === "shared" && <div className="stamp-choices" aria-label="为这顿饭盖章">
              {(Object.keys(stampNames) as MealStamp[]).map(stamp => <button key={stamp} className="secondary"
                disabled={busy || readOnly} aria-pressed={receiptOf(detail.data)?.stamps?.[service.userId] === stamp}
                onClick={() => run(() => stampMeal(service, detail.id, stamp), "已盖上你的餐后印章")}>{stampNames[stamp]}</button>)}
            </div>}
          </div>}
          <div className={`detail-photos ${detail.data.photoPage ? "photo-spread" : ""}`}>
            {detail.data.photos?.map((p) => (
              <Photo
                key={p.id}
                photo={p}
                visibility={detail.visibility}
                service={service}
              />
            ))}
          </div>
          {canReplyToPhoto(detail, service.userId) && <PhotoReplyButton disabled={!!readOnly || busy} onFile={file => {
            void run(async () => {
              const session = service.secrets;
              const prepared = await prepareBrowserPhoto(file);
              const bytes = new Uint8Array(await prepared.arrayBuffer());
              if (!session || service.secrets !== session) throw new AppError("LOCKED", "请重新解锁空间");
              const photo = await service.addPhoto(bytes, prepared.type, file.name, "shared");
              if (service.secrets !== session) throw new AppError("LOCKED", "请重新解锁空间");
              await finishPhotoPair(service, detail.id, photo);
            }, "两个人的照片已拼在同一页");
          }}/>}
          <p className="detail-body">
            {detail.data.body}
          </p>
          <div className="tags">
            {detail.data.tags?.map((t) => (
              <span key={t}># {t}</span>
            ))}
          </div>
          {detail.data.kind === "memory" && <details>
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
          </details>}
          <div className="detail-actions">
            <button
              className="secondary"
              disabled={readOnly}
              onClick={() => edit(detail.data.kind, detail)}
            >
              <Feather size={15} /> 编辑这一页
            </button>
            <button
              className="text-button"
              disabled={readOnly || busy}
              onClick={() =>
                run(async () => {
                  await service.trash(detail);
                  closeDetail();
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
              {!readOnly && <form
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
              </form>}
            </div>
          )}
        </Modal>
      )}
      {modal === "delete-capsule" && detail && (
        <Modal title="把这份期待放回抽屉？" close={close}>
          <p className="muted">内容会保留在回收站，可以恢复。</p>
          <button
            className="primary full"
            disabled={busy || readOnly}
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
      {modal === "verify-backup" && (
        <Modal title="确认本机口令，再查看备份" close={close}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const backup = await service.createBackup(backupPassword);
                setRecovery(backup.recoveryKey);
                setBackupPassword("");
                setModal("recovery");
              });
            }}
          >
            <Field label="再次输入本机口令">
              <input
                type="password"
                autoComplete="current-password"
                value={backupPassword}
                onChange={(event) => setBackupPassword(event.target.value)}
                required
              />
            </Field>
            <p className="fineprint">
              新备份只包含恢复密钥信封，不包含本机口令信封。
            </p>
            <button className="primary full" disabled={busy || !backupPassword}>
              验证并查看恢复密钥
            </button>
          </form>
        </Modal>
      )}
      {modal === "recovery" && (
        <Modal
          title="给回忆，留一把备用钥匙"
          subtitle="恢复密钥能打开备份中的全部内容。请离线保管，不要发给任何人。"
          close={close}
        >
          <div className="recovery-code">{recovery}</div>
          <button type="button" className="text-button" onClick={() => copySecret(recovery, "恢复密钥")}>复制恢复密钥</button>
          <p className="fineprint">
            恢复需要「加密备份文件 +
            这把恢复密钥」。双方同时遗失密钥和备份后，内容将无法恢复。
          </p>
          <button
            className="primary full"
            onClick={() => {
              download(
                `Us-加密备份-${day}.json`,
                JSON.stringify(
                  {
                    format: "UsBackup",
                    version: 2,
                    vault: recoveryOnlyVault(service.vault!),
                    ...(!hosted && {
                      database: service.storage.get("database"),
                      files: Object.fromEntries(
                        Object.keys(localStorage)
                          .filter((k) => k.startsWith(`us.${mode}.file.`))
                          .map((k) => [
                            k.replace(`us.${mode}.`, ""),
                            localStorage.getItem(k),
                          ]),
                      ),
                    }),
                  },
                  null,
                  2,
                ),
              );
            }}
          >
            保存加密备份文件
          </button>
          <button
            className="secondary full"
            onClick={() =>
              download(`Us-恢复密钥-${day}.txt`, recovery, "text/plain")
            }
          >
            单独保存恢复密钥
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
          {service.syncStorageWarning && <p className="error-text">{service.syncStorageWarning}</p>}
          {service.supportsOutbox && <OutboxPanel service={service} revision={revision} busy={busy} run={run} />}
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
            选择「先存本机」的日记可在重新联网后同步。普通保存结果不确定时，请先核对保存回执。
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
          <button type="button" className="text-button" onClick={() =>
            copySecret(fingerprint(publicKeys(service.secrets!)), "设备安全码")
          }>复制安全码</button>
          <p className="fineprint">
            {hosted ? "将你的设备安全码发给另一位成员，通过可信渠道核对后再发送密钥。"
              : "本机预览仅支持当前浏览器。跨微信账号邀请、密钥交换和设备管理在原生小程序中执行。"}
          </p>
          {hosted && (
            <>
              <Field label="对方的设备安全码">
                <input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} />
              </Field>
              <button className="text-button" disabled={busy} onClick={() =>
                run(async () => setDevices(await service.devices()))
              }>刷新设备列表</button>
            </>
          )}
          <div className="device-list">
            {devices.map((d) => (
              <div key={d.id}>
                <ShieldCheck size={18} />
                <span>
                  <strong>
                    {d.id === service.secrets!.deviceId
                      ? `${d.label} · 当前设备`
                      : hosted && d.userId !== service.userId ? "对方的设备" : d.label}
                  </strong>
                  <small>{d.id.slice(0, 16)}…</small>
                </span>
                {hosted && service.ready && d.id !== service.secrets!.deviceId && (
                  <button className="text-button" disabled={busy || readOnly || fingerprint(d) !== verificationCode.trim().toUpperCase().replace(/\s+/g, " ")} onClick={() =>
                    runSensitive("putTransfer", "发送空间密钥", () => service.transfer(d, verificationCode.trim()), "空间密钥已发送")
                  }>发送空间密钥</button>
                )}
                {d.id !== service.secrets!.deviceId &&
                  d.userId === service.userId && (
                    <button
                      className="text-button"
                      disabled={busy || readOnly}
                      onClick={() =>
                        runSensitive("revokeDevice", "撤销设备", async () => {
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
          {hosted && <button className="secondary full" disabled={busy || readOnly || !verificationCode.trim()} onClick={() =>
            run(() => service.receive(verificationCode.trim()), "空间密钥已接收")
          }>接收空间密钥</button>}
          <button
            className="secondary full"
            disabled={busy || readOnly || !service.ready}
            onClick={() =>
              runSensitive(
                "rotateSpaceKey", "轮换未来记录密钥",
                () => service.rotateKey(),
                "未来记录的密钥已轮换，请对方接收新密钥",
              )
            }
          >
            轮换未来记录密钥
          </button>
          {hosted && service.space?.members.length === 1 && <button
            className="secondary full"
            disabled={busy || readOnly}
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
          </button>}
          {invitation && service.space?.members.length === 1 && <>
            <code className="invitation">{invitation}</code>
            <button type="button" className="text-button" onClick={() => copySecret(invitation, "邀请码")}>复制邀请码</button>
          </>}
        </Modal>
      )}
      {modal === "export" && (
        <Modal title="把回忆，好好带走" close={close}>
          <p className="muted">
            加密备份用于恢复密钥。可读归档包含选定的记录和实际照片，可以离线打开。
          </p>
          {!service.hasPrivateAccess && <p className="fineprint">此设备仅能查看共同空间。请保管原设备的加密备份以恢复私人记录。</p>}
          <button
            className="primary full"
            disabled={!service.hasPrivateAccess}
            onClick={() => {
              setBackupPassword("");
              setModal("verify-backup");
            }}
          >
            <ShieldCheck size={16} /> 保存加密备份
          </button>
          <button
            className="secondary full"
            onClick={() => setModal("export-plain")}
          >
            导出可读图文归档
          </button>
          <button
            className="text-button full"
            onClick={() => setModal("restore")}
          >
            {hosted ? "使用加密备份恢复此设备" : "从备份恢复本机空间"}
          </button>
        </Modal>
      )}
      {modal === "export-plain" && (
        <Modal title="导出可直接阅读的记录？" close={close}>
          <ArchiveExport service={service} busy={busy} run={run} complete={(partial) => {
            close();
            notify(partial ? "已导出可用内容。未导出的项目见归档清单。" : "图文归档已导出，请妥善保管");
          }} />
        </Modal>
      )}
      {modal === "restore" && (
        <Modal title="恢复加密备份" close={close}>
          <RestoreForm
            service={service}
            hosted={!!hosted}
            openSpace={openSpace}
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
                  disabled={busy || readOnly}
                  onClick={() =>
                    run(() => service.trash(e, true), "这份回忆回来了")
                  }
                >
                  恢复
                </button>
                {e.creatorId === service.userId && (
                  <button
                    className="text-button danger"
                    disabled={busy || readOnly}
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
              Us 不追踪位置或记录在线时长。打开外部地图会把所选地点坐标交给地图服务。AI
              请求必须先选择、预览并单次确认；服务商的数据保留规则由所配置服务决定。
            </p>
            {hosted && <>
              <h3>关于双人游乐园</h3>
              <p>实时房间会向同房的伙伴显示你是否在房间。笔迹、故事和作品在设备上加密，服务器保留房间进度、操作时间及密文大小等同步所需的信息。</p>
              <p>收藏时可以选择仅自己查看或让两位成员查看。浏览器清除站点数据会移除本机待同步的笔迹。导出的文件可直接查看，请确认保存位置。</p>
            </>}
            <h3>关于设备和退出空间</h3>
            <p>
              撤销设备只能阻止后续云端访问，不能撤回已经解密的内容。双人空间须双方确认后才解除绑定并进入七天只读冷静期，到期清理双方共同及私人云端密文。请提前导出备份。
            </p>
          </div>
          <button
            className="secondary full"
            onClick={() => setModal("close-space")}
          >
            申请或确认关闭空间
          </button>
          {!hosted && <button
            className="text-button full danger"
            onClick={() => setModal("clear-local")}
          >
            清除此模式的本机数据
          </button>}
        </Modal>
      )}
      {modal === "close-space" && (
        <Modal title="关闭这个空间？" close={close}>
          <p className="muted">
            双人空间须双方确认后才解除绑定并进入七天只读冷静期；期间可查看、导出或撤销。单人空间仅需本人确认。到期清理任务会删除共同记录、双方私人记录、照片和密钥包。若任一成员已建立新空间，旧空间就无法撤销关闭。请先保存备份。
          </p>
          <button
            className="danger-button full"
            onClick={() =>
              runSensitive("closeSpace", "确认关闭空间", async () => {
                await service.closeSpace();
                close();
              }, "关闭状态已更新，请留意双方确认状态并保存备份")
            }
          >
            确认关闭空间
          </button>
        </Modal>
      )}
      {authorization && (
        <Modal title={authorization.title} close={cancelAuthorization}>
          {authorization.action === "rotateSpaceKey" && <p className="muted">
            轮换后，旧记录仍可用原密钥打开。其他设备需要核验并接收新密钥，才能继续打开空间和读取新记录。
          </p>}
          <form onSubmit={(event) => {
            event.preventDefault();
            if (busy || (readOnly && authorization.action !== "closeSpace" && authorization.action !== "cancelClose")) return;
            const attempt = ++authorizationAttempt.current;
            const device = service.secrets;
            const password = websitePassword;
            setWebsitePassword("");
            void run(async () => {
              await service.call("authorizeSensitiveAction", { password, forAction: authorization.action });
              if (attempt !== authorizationAttempt.current) return;
              if (service.secrets !== device) throw new AppError("LOCKED", "当前设备已锁定，请解锁后重试");
              cancelAuthorization();
              await authorization.execute();
              notify(authorization.success);
            });
          }}>
            <Field label="重新输入网站密码">
              <PasswordInput value={websitePassword} autoComplete="current-password" required
                onChange={(event) => setWebsitePassword(event.target.value)} />
            </Field>
            <button className="primary full" disabled={busy || !websitePassword ||
              (readOnly && authorization.action !== "closeSpace" && authorization.action !== "cancelClose")}>验证并继续</button>
          </form>
        </Modal>
      )}
      {modal === "new-space" && (
        <Modal title="建立新空间前，请先导出备份" close={close}>
          <p>
            建立新空间后，旧空间不能撤销关闭；本机将使用新空间的密钥库。旧空间将在冷静期结束后清理。请确认已保存旧空间的加密备份和恢复密钥。
          </p>
          <button
            className="danger-button full"
            onClick={() => {
              if (account) void forgetUnlock(account).catch(() => {});
              service.lock();
              close();
              setWelcomeMode(hosted && !hosted.owner ? "join" : "create");
              update();
            }}
          >
            已保存备份，前往创建
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
            disabled={busy || readOnly}
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
