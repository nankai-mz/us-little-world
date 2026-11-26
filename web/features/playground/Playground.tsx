import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Gamepad2, House, Palette } from "lucide-react";
import { hashText } from "../../../src/core/crypto";
import { spaceDay } from "../../../src/core/date";
import { QUESTION_BANK } from "../../../src/core/questions";
import type { UsService } from "../../../src/core/service";
import { AppError, type Entry } from "../../../src/core/types";
import { activities, activityIds, type ActivityId, type PlaySection } from "../../../src/features/play-core/catalog";
import { playActions, roomClock, type ActivityMode, type PlayStage, type WorkHeader } from "../../../src/features/play-core/protocol";
import { archiveGame, withWorkCover, type WorkContent } from "../../../src/features/play-core/works";
import { isMediaGame } from "../../../src/features/play-core/game";
import { isSceneGame } from "../../../src/features/scene-core/scene";
import { download } from "../../platform";
import { playRoute, type PlayTarget } from "../../routes";
import { AsyncGames, QuestionPicker } from "./AsyncGames";
import { DrawingRoom } from "./DrawingRoom";
import { CanvasWorkPreview, exportCanvasWork } from "./CanvasBoard";
import { GardenCard, MediaRoom, SkyCards, SongCards } from "./MediaRoom";
import { authorizedConstellation, StarMap } from "./ConstellationMap";
import { ArchivedMemoryTree } from "./MemoryTree";
import { SceneRoom, WorldLayout } from "./SceneRoom";
import { exportSky } from "./visualExport";
import { PlayClient } from "./client";
import { playError, useRoom } from "./useRoom";
import { WorkCover } from "./WorkCover";
import "./playground.css";

type Navigate = (target?: PlayTarget) => void;
type Context = { service: UsService; client: PlayClient; navigate: Navigate; openMemory: (entry: Entry) => void; reduceMotion?: boolean };
const areas = [
  { kind: "games", label: "小游戏屋", icon: Gamepad2, summary: "下一盘棋，猜一次对方的答案。" },
  { kind: "create", label: "创造工坊", icon: Palette, summary: "从一段故事开始，做一件共同作品。" },
  { kind: "world", label: "我们的世界", icon: House, summary: "慢慢布置共同的小角落。" },
  { kind: "gallery", label: "双人作品馆", icon: BookOpen, summary: "重温两个人一起留下的作品。" },
] as const;
const statusLabels = { waiting: "等待对方准备", active: "可以继续", paused: "已暂停", completed: "已结束" } as const;

function Link({ target, navigate, children, className, current }: {
  target?: PlayTarget; navigate: Navigate; children: ReactNode; className?: string; current?: boolean;
}) {
  return <a className={className} href={target ? playRoute(target).pathname : "/app/play"}
    aria-current={current ? "page" : undefined}
    onClick={(event) => {
      if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      navigate(target);
    }}>{children}</a>;
}

function ErrorText({ children }: { children?: string }) {
  return children ? <p className="play-error" role="alert">{children}</p> : null;
}

function useRoomList(client: PlayClient) {
  const [rooms, setRooms] = useState<Awaited<ReturnType<PlayClient["roomList"]>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generation, retry] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => client.roomList().then((items) => {
      if (live) { setRooms(items); setError(""); }
    }).catch((failure) => { if (live) setError(playError(failure)); })
      .finally(() => { if (live) setLoading(false); });
    void read();
    const refresh = () => { if (!document.hidden) void read(); };
    const timer = window.setInterval(refresh, 8000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, generation]);
  return { rooms, loading, error, retry: () => retry((n) => n + 1) };
}

function Recent({ client, navigate, activity }: Pick<Context, "client" | "navigate"> & { activity?: ActivityId }) {
  const { rooms, loading, error, retry } = useRoomList(client);
  const visible = activity ? rooms.filter(({ seed }) => seed?.activityId === activity) : rooms;
  return <section className="play-surface play-recent">
    <h3>{activity ? "这个玩法的房间" : "我的活动"}</h3>
    <ErrorText>{error}</ErrorText>
    {error && <button onClick={retry}>刷新活动</button>}
    {loading ? <p>正在同步房间…</p> : !visible.length ? <p>有进行中的活动时，可以从这里继续。</p> :
      <ul>{visible.map(({ room, seed }) => <li key={room.id}>
        <Link target={{ kind: "room", id: room.id }} navigate={navigate}>
          <strong>{seed?.title ?? "需要旧空间密钥的活动"}</strong>
          <span>{room.turn !== null && room.status === "active" && client.seat(room) !== room.turn ? "等对方回合" : statusLabels[room.status]}
            <ArrowRight size={16} aria-hidden="true" /></span>
        </Link>
      </li>)}</ul>}
  </section>;
}

function ActivityHome({ context, id, stages }: { context: Context; id: ActivityId; stages: PlayStage[] }) {
  const game = activities[id];
  const [title, setTitle] = useState("");
  const [choice, setChoice] = useState(id === "g03" ? QUESTION_BANK[0].text : "");
  const availableModes = (game.modes as readonly ActivityMode[]).filter((candidate) => candidate !== "realtime" || stages.includes("shared_canvas"));
  const [mode, setMode] = useState<ActivityMode>(availableModes[0] ?? "realtime");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const room = await context.client.create(id, title, mode, id === "c19" ? title : choice || undefined);
      context.navigate({ kind: "room", id: room.id });
    } catch (failure) { setError(playError(failure)); }
    finally { setBusy(false); }
  }

  return <>
    <Link target={{ kind: game.section }} navigate={context.navigate} className="play-back"><ArrowLeft size={16} />返回{areas.find(({ kind }) => kind === game.section)?.label}</Link>
    <section className="play-surface">
      <h2>{game.title}</h2><p>{game.summary}</p>
      {stages.includes(game.stage) && availableModes.length ? <form className="play-fields" onSubmit={create}>
        <label>{id === "c19" ? "故事标题" : "房间名称"}<input value={title} maxLength={60} placeholder={game.title}
          onChange={(event) => setTitle(event.target.value)} /></label>
        {id === "g03" && <QuestionPicker value={choice} select={setChoice} />}
        {id === "c16" && <label>分镜数量<select value={choice || "4"} onChange={(event) => setChoice(event.target.value)}>
          <option value="4">四格</option><option value="6">六格</option></select></label>}
        {availableModes.length > 1 &&
          <label>活动方式<select value={mode} onChange={(event) => setMode(event.target.value as ActivityMode)}>
            <option value="asynchronous">错峰继续</option><option value="realtime">实时一起玩</option>
          </select></label>}
        <ErrorText>{error}</ErrorText>
        <div className="play-actions"><button className="primary" disabled={busy}>{busy ? "正在创建…" : "创建双人房间"}</button></div>
      </form> : <p>当前空间尚未开放这个玩法。</p>}
    </section>
    <Recent {...context} activity={id} />
  </>;
}

function Room({ context, id }: { context: Context; id: string }) {
  const { client, service, navigate } = context;
  const state = useRoom(client, id);
  const [notice, setNotice] = useState("");
  const [invite, setInvite] = useState(false);
  const [lowEffects, setLowEffects] = useState(false);
  const entries = service.active;
  const shared = useMemo(() => entries.filter(({ visibility, data }) => visibility === "shared" &&
    ["memory", "anniversary", "place", "wish", "play-media"].includes(data.kind)), [entries]);
  const sharedById = useMemo(() => new Map(shared.map((entry) => [entry.id, entry])), [shared]);
  const view = state.view;
  if (!view) return <section className="play-surface">
    <h2>双人房间</h2><ErrorText>{state.error}</ErrorText>
    {state.error ? <button onClick={() => void state.refresh()}>重新加载房间</button> : <p>正在解锁活动…</p>}
  </section>;
  const { room, seed, game } = view;
  const seat = client.seat(room);
  const readonly = !client.canWrite(room);
  const names = room.memberIds.map((id, index) => service.displayNames.get(id) ?? (id === service.userId ? "我" : `伙伴 ${index + 1}`)) as [string, string];
  const archivable = game.id === "c18" ? authorizedConstellation(game, shared) : game.id === "w24" ? {
    ...game, selected: game.selected.filter((id) => {
      const kind = sharedById.get(id)?.data.kind;
      return kind === "memory" || kind === "anniversary";
    }),
  } : game;
  const work = archiveGame(archivable, seed.title, id);
  const inviteUrl = new URL(playRoute({ kind: "room", id }).pathname, window.location.origin).href;
  const unavailable = state.busy || !!state.pending || readonly;
  const active = !unavailable && room.status === "active";
  const approvals = room.archive?.through === room.lastSeq ? room.archive.approved : [];
  const sharedEligible = room.status === "completed" || approvals.length === 2;
  const cleanupVotes = room.cleanupVotes ?? [];
  const expiryDate = room.expiresAt && new Date(room.expiresAt).toLocaleDateString("zh-CN");

  async function keep(visibility: WorkHeader["visibility"]) {
    return state.run(async () => {
      const workId = client.workIdFor(id, visibility);
      const existing = await client.work(workId).catch((error) => {
        if (error instanceof AppError && error.code === "WORK_UNAVAILABLE") return null;
        throw error;
      });
      const valid = work.references.filter(({ recordId, fileId }) => {
        const record = sharedById.get(recordId);
        return record && (!fileId || record.data.photos?.some((photo) => photo.fileId === fileId));
      });
      const data = withWorkCover({ ...work, references: valid });
      if (existing && JSON.stringify(withWorkCover({ ...existing.data, title: data.title })) === JSON.stringify(data)) {
        navigate({ kind: "work", id: workId });
        return;
      }
      const saved = await client.saveWork(existing ? { ...data, title: existing.data.title } : data, visibility, existing?.header,
        { sequence: room.lastSeq });
      navigate({ kind: "work", id: saved.id });
    });
  }

  return <>
    <Link target={{ kind: "activity", id: seed.activityId }} navigate={navigate} className="play-back"><ArrowLeft size={16} />{activities[game.id].title}</Link>
    <header className="play-surface play-room-header">
      <div><h2>{seed.title}</h2>
        <p>{room.mode === "asynchronous" ? "错峰活动" : "实时房间"} · {statusLabels[room.status]}
          {readonly ? " · 旧密钥只读" : ""}</p></div>
      <div className="play-actions">
        <button onClick={() => setInvite((value) => !value)}>邀请对方</button>
        <button disabled={state.busy} onClick={() => void state.refresh()}>刷新进度</button>
      </div>
      {invite && <div className="play-fields">
        <label>房间链接<input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="play-actions"><button onClick={() => void navigator.clipboard.writeText(inviteUrl)
          .then(() => setNotice("房间链接已复制")).catch(() => setNotice("可选中链接手动复制"))}>复制链接</button>
          <small>链接仅供已配对并解锁的两位成员使用。</small></div>
      </div>}
      <div className="play-actions" role="status"><small>{state.realtime ? "实时连接已就绪" : state.connected ? "已读取最新进度" : "连接待确认"}</small>
        {notice && <small>{notice}</small>}</div>
      <ErrorText>{state.error}</ErrorText>
      {state.pending && <div className="play-actions">
        <span>有一条加密操作待确认。</span>
        <button disabled={state.busy} onClick={() => void state.retry()}>重新同步</button>
        <button disabled={state.busy} onClick={() => {
          if (window.confirm("放弃本机重试并核对云端进度？")) void state.discard();
        }}>放弃重试</button>
      </div>}
      {room.mode === "realtime" && <ul className="play-members">
        {names.map((name, index) => <li key={index}>{name} · {room.ready.includes(index as 0 | 1) ? "已准备" : "待准备"}
          {state.presence.includes(index as 0 | 1) ? " · 在房间" : ""}</li>)}
      </ul>}
      {room.mode === "realtime" && room.status !== "completed" && room.supportsAsync && !unavailable &&
        <button onClick={() => {
          if (window.confirm("把当前房间切换成错峰活动？双方可以分别回来继续。")) void state.lifecycle(playActions.useAsync);
        }}>转为错峰活动</button>}
      <details><summary>房间设置</summary><label className="play-settings"><input type="checkbox" checked={lowEffects}
        onChange={(event) => setLowEffects(event.target.checked)} />减少动效并降低画布清晰度{game.id === "c17" ? "，使用二维地图" : ""}</label></details>
    </header>
    <section className="play-surface play-game" data-low-effects={lowEffects || undefined}>
      {room.status === "waiting" ? <><h3>准备开始</h3><p>双方都准备后开局。你可以在房间里等，也可以稍后回来。</p>
        {!room.ready.includes(seat) && <button className="primary" disabled={unavailable}
          onClick={() => void state.lifecycle(playActions.join)}>我准备好了</button>}
        {game.id === "g04" && <SceneRoom {...context} roomId={room.id} game={game} seat={seat} disabled
          members={names} shared={shared} submit={state.submit} report={state.report} gameNow={() => roomClock(room)}
          openMusic={() => navigate({ kind: "activity", id: "c20" })} openDrawing={() => navigate({ kind: "activity", id: "c15" })} />}
      </> : "objects" in game
        ? <DrawingRoom {...context} view={view} state={game} seat={seat} disabled={room.status !== "active" || readonly}
          busy={state.busy} pending={!!state.pending}
          members={names} shared={shared} submit={state.submit} report={state.report} preview={state.preview}
          sendPreview={state.sendPreview} lowResolution={lowEffects} />
        : isMediaGame(game)
          ? <MediaRoom {...context} view={view} game={game} seat={seat} reduceMotion={lowEffects || context.reduceMotion} disabled={room.status !== "active" || !!state.pending || readonly}
            members={names} shared={shared} submit={state.submit} report={state.report} />
          : isSceneGame(game)
            ? <SceneRoom {...context} roomId={room.id} game={game} seat={seat} lowEffects={lowEffects}
              disabled={room.status !== "active" || !!state.pending || readonly} busy={state.busy}
              predictMoves={state.realtime && room.status === "active" && !readonly}
              members={names} shared={shared} submit={state.submit} report={state.report} gameNow={() => roomClock(room)}
              openMusic={() => navigate({ kind: "activity", id: "c20" })} openDrawing={() => navigate({ kind: "activity", id: "c15" })} />
            : <AsyncGames {...context} view={view} seat={seat} disabled={room.status !== "active" || !!state.pending || readonly}
              members={names} shared={shared} submit={state.submit} report={state.report} />}
    </section>
    <section className="play-surface">
      <h3>进度与收藏</h3>
      <div className="play-actions">
        {room.status === "active" && <button disabled={!active} onClick={() => void state.lifecycle(playActions.pause)}>暂停活动</button>}
        {room.status === "paused" && <button disabled={unavailable} onClick={() => void state.lifecycle(playActions.resume)}>继续活动</button>}
        {room.status !== "completed" && room.status !== "waiting" && <button disabled={unavailable || room.finish.includes(seat)}
          onClick={() => void state.lifecycle(playActions.close)}>{room.finish.includes(seat) ? "等待对方确认结束" : "确认结束活动"}</button>}
        {room.expiresAt && <button disabled={unavailable} onClick={() => void state.lifecycle(playActions.extend)}>再保留 30 天</button>}
      </div>
      {room.status === "completed" ? <p>{expiryDate && `房间保留至 ${expiryDate}。`}已收藏的作品会继续保留。</p> :
        <details className="play-routines">
          <summary>房间保留设置</summary>
          <p aria-live="polite">{expiryDate ? `预计于 ${expiryDate} 清理。提交新进度后，保留时间顺延 30 天。` :
            `房间持续保留。双方确认后，连续 30 天无新进度的房间将清理。${cleanupVotes.length === 1 ? " 已有一人确认。" : ""}`}</p>
          <div className="play-actions">
            {!expiryDate && <button disabled={unavailable || cleanupVotes.includes(seat)}
              onClick={() => void state.lifecycle(playActions.approveCleanup)}>
              {cleanupVotes.includes(seat) ? "等待搭档确认清理设置" : "同意闲置 30 天后清理"}
            </button>}
            {cleanupVotes.length > 0 && <button disabled={unavailable} onClick={() => void state.lifecycle(playActions.keepRoom)}>
              {expiryDate ? "改为持续保留" : "取消清理确认"}
            </button>}
          </div>
        </details>}
      <div className="play-actions">
        {sharedEligible && <button className="primary" disabled={state.busy || !work.markdown}
          onClick={() => void keep("shared")}>放入共同作品馆</button>}
        {!sharedEligible && work.markdown && !readonly &&
          <button disabled={unavailable || approvals.includes(seat)} onClick={() => void state.lifecycle(playActions.approveArchive)}>
            {approvals.includes(seat) ? "等待对方确认收藏" : "确认收藏当前版本"}
          </button>}
        {service.hasPrivateAccess && <button disabled={state.busy || !work.markdown} onClick={() => void keep("private")}>只为自己收藏</button>}
      </div>
      {!sharedEligible && work.markdown && <small>两人确认当前版本后即可收藏，房间可以继续使用。</small>}
      <Link navigate={navigate} className="play-back"><ArrowLeft size={16} />离开房间</Link>
    </section>
  </>;
}

function Gallery({ client, navigate, service }: Pick<Context, "client" | "navigate" | "service">) {
  const [theme, setTheme] = useState<PlaySection | "">("");
  return <section className="play-surface play-recent">
    <h2>双人作品馆</h2>
    <div className="play-fields"><label>作品主题<select value={theme} onChange={(event) => setTheme(event.target.value as PlaySection | "")}>
      <option value="">全部作品</option>
      {areas.slice(0, 3).map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
    </select></label></div>
    <GalleryResults key={theme} client={client} navigate={navigate} service={service} theme={theme} />
  </section>;
}

type GalleryPage = Awaited<ReturnType<PlayClient["workList"]>>;

async function galleryPage(client: PlayClient, theme: PlaySection | "", after?: string): Promise<GalleryPage> {
  let cursor = after;
  do {
    const page = await client.workList(cursor);
    if (!theme) return page;
    // Activity type is encrypted. Continue over pages without a match on this device.
    const items = page.items.filter(({ data }) => data && activities[data.activityId].section === theme);
    if (items.length || !page.next) return { items, next: page.next };
    cursor = page.next;
  } while (cursor);
  return { items: [], next: null };
}

function GalleryResults({ client, navigate, service, theme }: Pick<Context, "client" | "navigate" | "service"> & { theme: PlaySection | "" }) {
  const [items, setItems] = useState<GalleryPage["items"]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [generation, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true); setError("");
    void galleryPage(client, theme).then((page) => {
      if (live) { setItems(page.items); setNext(page.next); }
    }).catch((error) => { if (live) setError(playError(error)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [client, theme, generation]);
  return <>
    <ErrorText>{error}</ErrorText>
    {error && !next && <button onClick={() => refresh((value) => value + 1)}>重试加载作品</button>}
    {busy && !items.length ? <p role="status">正在解锁作品…</p> : !items.length && !error ? <p>{theme ? "这个主题还没有作品。" : "在房间里收藏一件作品后，就可以在这里打开。"}</p> : <ul>
      {items.map(({ header, data }) => <li key={header.id}>
        <Link target={{ kind: "work", id: header.id }} navigate={navigate}>
          <div className="play-work-title"><WorkCover service={service} data={data} />
            <strong>{data?.title ?? "需要旧空间密钥的作品"}</strong>
          </div>
          <span>{header.visibility === "shared" ? "共同" : "私人"} · 版本 {header.revision}<ArrowRight size={16} /></span>
        </Link>
      </li>)}
    </ul>}
    {next && <button disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        const page = await galleryPage(client, theme, next);
        setItems((current) => [...current, ...page.items]);
        setNext(page.next);
      } catch (failure) { setError(playError(failure)); }
      finally { setBusy(false); }
    }}>{busy ? "正在查找作品…" : "加载更多作品"}</button>}
  </>;
}

function Work({ context, id }: { context: Context; id: string }) {
  const { service, client, navigate, openMemory } = context;
  const entries = service.active;
  const records = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const [latest, setLatest] = useState<Awaited<ReturnType<PlayClient["work"]>>>();
  const [current, setCurrent] = useState<Awaited<ReturnType<PlayClient["work"]>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    void client.work(id).then((work) => {
      if (live) { setLatest(work); setCurrent(work); setTitle(work.data.title); }
    }).catch((failure) => { if (live) setError(playError(failure)); });
    return () => { live = false; };
  }, [client, id]);

  const execute = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (failure) { setError(playError(failure)); }
    finally { setBusy(false); }
  };
  if (!current || !latest) return <section className="play-surface">
    <h2>作品详情</h2>{error ? <ErrorText>{error}</ErrorText> : <p>正在解锁作品…</p>}
    <Link target={{ kind: "gallery" }} navigate={navigate}>返回作品馆</Link>
  </section>;

  const { header, data } = current;
  const linkId = hashText(JSON.stringify(["Us/play/journal/1", id])).slice(0, 32);
  const linked = records.get(linkId);
  function exportWork(format: "md" | "txt" | "json" | "pdf") {
    if (!window.confirm("导出的文件可以直接阅读。请确认保存位置适合存放这份私人内容。")) return;
    if (format === "pdf") window.print();
    else {
      const output = format === "json" ? JSON.stringify(data, null, 2) : (format === "md" ? "# " : "") + data.title + "\n\n" +
        (format === "txt" ? data.markdown.replace(/^## |^> /gm, "") : data.markdown);
      download("Us-" + id.slice(0, 8) + "." + format, output, format === "json" ? "application/json" : "text/plain;charset=utf-8");
    }
  }
  function validRefs(value: WorkContent) {
    return value.references.filter(({ recordId, fileId }) => {
      const entry = records.get(recordId);
      return entry && (header.visibility === "private" || entry.visibility === "shared") &&
        (!fileId || entry.data.photos?.some((photo) => photo.fileId === fileId));
    });
  }

  return <>
    <Link target={{ kind: "gallery" }} navigate={navigate} className="play-back"><ArrowLeft size={16} />返回作品馆</Link>
    <section className="play-surface play-work-print">
      <h2>{data.title}</h2>
      <p>{header.visibility === "shared" ? "共同作品" : "私人作品"} · 版本 {header.revision}</p>
      {data.canvas && <CanvasWorkPreview service={service} work={data.canvas} />}
      {data.postcard?.id === "c18" && <StarMap service={service} game={data.postcard} />}
      {data.postcard?.id === "c20" && <SongCards service={service} value={data.postcard} />}
      {data.postcard?.id === "c21" && <SkyCards service={service} value={data.postcard} />}
      {data.postcard?.id === "g14" && <GardenCard value={data.postcard} />}
      {data.world && <WorldLayout game={data.world} />}
      {data.activityId === "w24" && <ArchivedMemoryTree service={service} references={data.references}
        reduceMotion={context.reduceMotion} openMemory={openMemory} report={(failure) => setError(playError(failure))} />}
      {data.postcard?.id !== "g14" && <div className="play-work-body">{data.markdown.split("\n\n").map((block, index) =>
        block.startsWith("## ") ? <h3 key={index}>{block.slice(3)}</h3> : <p key={index}>{block}</p>)}</div>}
      {data.activityId !== "w24" && !!data.references.length && <ul className="play-reference">
        {data.references.map(({ recordId, fileId }, index) => {
          const entry = records.get(recordId);
          if (entry?.data.kind === "play-media") return null;
          return <li key={index}>{entry && (header.visibility === "private" || entry.visibility === "shared") && (!fileId || entry.data.photos?.some((photo) => photo.fileId === fileId))
            ? <button onClick={() => openMemory(entry)}>打开回忆 · {entry.data.title}</button> : "这条回忆或照片已移除。"}</li>;
        })}
      </ul>}
    </section>
    <section className="play-surface">
      <h3>管理作品</h3>
      <ErrorText>{error}</ErrorText>
      {notice && <p role="status">{notice}</p>}
      <div className="play-actions">
        <button onClick={() => exportWork("md")}>导出 Markdown</button>
        <button onClick={() => exportWork("txt")}>导出文本</button>
        <button onClick={() => exportWork("json")}>导出 JSON</button>
        <button onClick={() => exportWork("pdf")}>打印或另存 PDF</button>
        {data.canvas && <button disabled={busy} onClick={() => {
          if (window.confirm("PNG 文件可以直接查看。请确认保存位置适合这份私人作品。"))
            void execute(() => exportCanvasWork(service, data.canvas!, id));
        }}>导出 PNG</button>}
        {data.postcard?.id === "c21" && <button disabled={busy} onClick={() => {
          const sky = data.postcard;
          if (sky?.id === "c21" && window.confirm("拼贴图片可以直接查看。确认导出？"))
            void execute(() => exportSky(service, sky, id));
        }}>导出天空拼贴 PNG</button>}
      </div>
      <div className="play-fields">
        <label>查看历史版本<select disabled={busy} value={header.revision} onChange={(event) => {
          const next = Number(event.target.value);
          void execute(async () => {
            const work = next === latest.header.revision ? latest : await client.work(id, next);
            setCurrent(work); setTitle(work.data.title);
          });
        }}>
          {Array.from({ length: latest.header.revision }, (_, index) => <option value={index + 1} key={index}>版本 {index + 1}</option>)}
        </select></label>
        <label>作品标题<input maxLength={60} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="play-actions">
          <button disabled={busy || !title.trim() || (title.trim() === latest.data.title && current === latest)}
            onClick={() => void execute(async () => {
              const saved = await client.saveWork({ ...data, title: title.trim(), references: validRefs(data) }, header.visibility, latest.header);
              const next = await client.work(id, saved.revision);
              setCurrent(next); setLatest(next); setNotice("已保存新版本");
            })}>保存为新版本</button>
          <Link target={{ kind: "room", id: data.roomId }} navigate={navigate}>查看原房间</Link>
        </div>
      </div>
      <div className="play-actions">
        {header.visibility === "private" && header.authorId === service.userId && <button disabled={busy} onClick={() => {
          if (!window.confirm("另存为共同作品后，两位成员均可打开此副本。确认共享？")) return;
          void execute(async () => {
            const allowed = (recordId: string, fileId?: string) => {
              const entry = records.get(recordId);
              return entry?.visibility === "shared" && (!fileId || entry.data.photos?.some((photo) => photo.fileId === fileId));
            };
            const references = data.references.filter((ref) => allowed(ref.recordId, ref.fileId));
            const canvas = data.canvas && { ...data.canvas, objects: data.canvas.objects.filter((item) =>
              (item.kind !== "photo" && item.kind !== "wish") || allowed(item.reference.recordId, item.reference.fileId)) };
            const postcard = data.postcard;
            if (postcard && references.length !== data.references.length)
              throw new AppError("REFERENCE_UNAVAILABLE", "这份明信片的部分素材无法共享");
            const world = data.world && { ...data.world, decorations: data.world.decorations.map((item) =>
              item.memory && !allowed(item.memory, item.photo) ? { ...item, memory: undefined, photo: undefined } : item) };
            const copy = await client.saveWork({ ...data, references, canvas, world }, "shared", undefined, { workId: id });
            navigate({ kind: "work", id: copy.id });
          });
        }}>另存为共同作品</button>}
        {header.visibility === "shared" && (linked ? <button onClick={() => openMemory(linked)}>打开关联日记</button>
          : <button disabled={busy} onClick={() => {
            if (window.confirm("将作品标题和入口加入共同日记？")) void execute(async () => {
              const entry = await service.save({ kind: "memory", title: data.title, date: spaceDay(), playWorkId: id }, "shared", undefined, linkId);
              openMemory(entry);
            });
          }}>加入共同日记</button>)}
        {header.authorId === service.userId && <button disabled={busy} onClick={() => {
          if (window.confirm("永久删除这份作品及其历史版本？已有日记会保留作品入口占位。")) void execute(async () => {
            await client.deleteWork(latest.header);
            navigate({ kind: "gallery" });
          });
        }}>删除作品</button>}
      </div>
    </section>
  </>;
}

export function Playground({ target, fallback, ...props }: Omit<Context, "client"> & { target?: PlayTarget; fallback: ReactNode }) {
  const client = useMemo(() => new PlayClient(props.service), [props.service]);
  const [stages, setStages] = useState<PlayStage[] | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const paired = props.service.space?.members.length === 2 && props.service.space.status === "active";
  useEffect(() => {
    if (!paired) return;
    let live = true;
    setChecking(true);
    void client.config().then(({ stages }) => {
      if (live) { setStages(stages); setError(""); }
    }).catch((failure) => {
      if (live) { setStages(null); setError(playError(failure)); }
    }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [client, paired]);
  if (!paired || !stages) {
    if (!target) return fallback;
    return <section className="playground play-surface"><h2>双人游乐园</h2>
      <p>{!paired ? "配对并解锁两位成员的设备后，就可以在这里一起玩。" : checking ? "正在连接游乐园…" : error}</p>
      <Link navigate={props.navigate}>返回一起玩耍</Link>
    </section>;
  }
  const context = { ...props, client };
  const filters = activityIds.filter((id) => stages.includes(activities[id].stage));
  const recommended = filters.length ? filters[Number(spaceDay().slice(-2)) % filters.length] : undefined;
  const category = target?.kind === "games" || target?.kind === "create" || target?.kind === "world" ? target.kind : null;
  return <div className="playground">
    <nav className="play-area-nav" aria-label="游乐园分区">
      <Link navigate={props.navigate} current={!target}>游乐园</Link>
      {areas.map(({ kind, label }) => <Link key={kind} target={{ kind }} navigate={props.navigate} current={target?.kind === kind}>{label}</Link>)}
    </nav>
    {!target && <>
      <section className="play-hero">
        <div><h2>双人游乐园</h2><p>找一件想一起做的事。今天没做完，改天再接着来。</p>
          {recommended && <Link target={{ kind: "activity", id: recommended }} navigate={props.navigate} className="play-recommend">
            {activities[recommended].icon}　今天来玩{activities[recommended].title} <ArrowRight size={18} />
          </Link>}</div>
        <div className="play-hero-art" aria-hidden="true">✦<span>◉</span><i>♪</i></div>
      </section>
      <div className="play-area-grid">{areas.map(({ kind, label, icon: Icon, summary }) =>
        <Link key={kind} target={{ kind }} navigate={props.navigate} className="play-area">
          <Icon size={24} aria-hidden="true" /><strong>{label}</strong><span>{summary}</span><ArrowRight size={17} aria-hidden="true" />
        </Link>)}</div>
      <Recent {...context} />
      <details className="play-routines"><summary>日常活动</summary>{fallback}</details>
    </>}
    {category && <>
      <h2>{areas.find(({ kind }) => kind === category)?.label}</h2>
      {filters.some((id) => activities[id].section === category) ? <div className="play-area-grid">
        {filters.filter((id) => activities[id].section === category).map((id) => {
          const activity = activities[id];
          return <Link key={id} target={{ kind: "activity", id }} navigate={props.navigate} className="play-area">
            <span className="play-symbol" aria-hidden="true">{activity.icon}</span><strong>{activity.title}</strong>
            <span>{activity.summary}</span><small>约 {activity.minutes} 分钟</small>
          </Link>;
        })}
      </div> : <p>这个区域的活动尚未开放。</p>}
    </>}
    {target?.kind === "activity" && <ActivityHome key={target.id} context={context} id={target.id} stages={stages} />}
    {target?.kind === "room" && <Room key={target.id} context={context} id={target.id} />}
    {target?.kind === "work" && <Work key={target.id} context={context} id={target.id} />}
    {target?.kind === "gallery" && <Gallery client={client} service={props.service} navigate={props.navigate} />}
  </div>;
}
