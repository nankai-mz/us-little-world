import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from "react";
import { hashText } from "../../../src/core/crypto";
import { dateLabel } from "../../../src/core/date";
import type { UsService } from "../../../src/core/service";
import { AppError, type Entry } from "../../../src/core/types";
import {
  brushColors, characters, comicBackgrounds, expressions, matchesDrawingAnswer, publicPrompts, sortedItems, stickers, type CanvasBody, type CanvasItem, type DrawCommand, type Drawing,
  type ItemInput, type StrokePreview,
} from "../../../src/features/canvas-core/canvas";
import { strokesUnderEraser } from "../../../src/features/canvas-core/eraser";
import { roomClock, type Seat } from "../../../src/features/play-core/protocol";
import { flowers } from "../../../src/features/scene-core/levels";
import type { PlayClient, RoomView } from "./client";
import { CanvasBoard } from "./CanvasBoard";

type Props = {
  client: PlayClient;
  service: UsService;
  view: RoomView;
  state: Drawing;
  seat: Seat;
  disabled: boolean;
  busy: boolean;
  pending: boolean;
  members: [string, string];
  shared: Entry[];
  submit: (command: DrawCommand) => Promise<boolean>;
  report: (error: unknown) => void;
  openMemory: (entry: Entry) => void;
  preview?: StrokePreview | null;
  sendPreview: (value: StrokePreview | null) => void;
  lowResolution?: boolean;
};

const newId = () => crypto.randomUUID().replaceAll("-", "");
type QueuedStroke = { round: number; panel: number; item: Extract<ItemInput, { kind: "stroke" }> };
const kindLabel = { stroke: "笔迹", shape: "形状", text: "文字", sticky: "便签", sticker: "贴纸",
  bubble: "对白", character: "角色", photo: "照片", link: "连线", group: "组合", wish: "愿望" };
const display = (item: CanvasItem, index: number) => `${index + 1} · ${kindLabel[item.kind]}${"text" in item ? " " + item.text.slice(0, 24) : ""}`;

function DrawGuess({ props }: { props: Props }) {
  const { state, seat, client, view, disabled, submit, members } = props;
  const round = state.rounds.at(-1)!;
  const roundId = state.rounds.length;
  const draw = round.author === seat;
  const [word, setWord] = useState("");
  const [duration, setDuration] = useState(90);
  const [difficulty, setDifficulty] = useState<keyof typeof publicPrompts>("容易");
  const [bank, setBank] = useState<"public" | "shared">("public");
  const [guess, setGuess] = useState("");
  const [now, setNow] = useState(Date.now);
  const attemptedRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const seconds = Math.max(0, Math.ceil((round.start + round.seconds * 1000 - roomClock(view.room, now)) / 1000));
  let answer: string | null = null;
  if (draw && round.secret && !round.result) {
    try { answer = client.openAnswer(view.room, roundId, round.secret).text; }
    catch { /* Another device may hold the decryption key for this round. */ }
  }
  const canReveal = !disabled && !!answer && (seconds === 0 || matchesDrawingAnswer(round.guesses, answer));
  const reveal = useEffectEvent(() => {
    if (answer) void submit({ type: "drawing.reveal", answer, at: roomClock(view.room), round: roundId });
  });
  useEffect(() => {
    if (!canReveal || attemptedRevision.current === view.room.revision) return;
    attemptedRevision.current = view.room.revision;
    reveal();
  }, [canReveal, view.room.revision]);

  const words = bank === "public" ? publicPrompts[difficulty] : props.shared.filter(({ data }) => data.kind === "memory")
    .slice(0, 24).map(({ data }) => data.title);
  const selectedWord = word.trim() || words[0];

  if (!round.secret) return draw && !disabled ? <form className="play-fields" onSubmit={(event) => {
    event.preventDefault();
    void (async () => {
      try {
        if (!selectedWord) return;
        const hidden = await client.sealAnswer(view.room, roundId, { text: selectedWord });
        await submit({ type: "drawing.ask", hidden, start: roomClock(view.room), seconds: duration });
      } catch (error) { props.report(error); }
    })();
  }}>
    <h3>第 {roundId} 轮的题目</h3>
    <div className="play-fields play-split">
      <label>题库<select value={bank} onChange={(event) => setBank(event.target.value === "shared" ? "shared" : "public")}>
        <option value="public">公共词库</option><option value="shared">共同回忆</option>
      </select></label>
      {bank === "public" && <label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}>
        {Object.keys(publicPrompts).map((name) => <option key={name}>{name}</option>)}
      </select></label>}
      <label>画图时间<select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
        {[60, 90, 120].map((value) => <option value={value} key={value}>{value} 秒</option>)}
      </select></label>
    </div>
    <label>自定义或从词库选题<input list="play-words" value={word} maxLength={100}
      placeholder={words[0] ?? "输入自己的题目"} onChange={(event) => setWord(event.target.value)} /></label>
    <datalist id="play-words">
      {words.map((item, index) => <option value={item} key={index} />)}
    </datalist>
    <div className="play-actions"><button className="primary" disabled={!selectedWord}>开始画这一轮</button></div>
  </form> : <p>等 {members[round.author]} 选一个要画的词。</p>;

  if (round.result) return <div>
    <h3>{round.result.answer} · {round.result.correct ? "猜对了！" : "时间到了"}</h3>
    <div className="play-actions">
      {!disabled && roundId < 12 && <button onClick={() => void submit({ type: "drawing.next" })}>换人画下一轮</button>}
    </div>
  </div>;

  return <div className="play-fields">
    <h3>第 {roundId} 轮 · 剩 {seconds} 秒</h3>
    {draw ? <p>{answer ? "你要画的题目　" + answer : "请用出题设备打开谜底。"}</p> :
      <p>{seconds === 0 ? "时间已到，等画者回来揭晓。" : "根据画面猜猜是什么。"}</p>}
    {round.guesses.length > 0 && <p>猜测　{round.guesses.join("、")}</p>}
    {canReveal && answer &&
      <div className="play-actions"><button className="primary"
        onClick={() => void submit({ type: "drawing.reveal", answer, at: roomClock(view.room), round: roundId })}>揭晓答案</button></div>}
    {!draw && !disabled && seconds > 0 && <form className="play-fields" onSubmit={(event) => {
      event.preventDefault();
      void submit({ type: "drawing.guess", value: guess, at: roomClock(view.room), round: roundId }).then((saved) => { if (saved) setGuess(""); });
    }}><label>我猜是<input value={guess} maxLength={100} onChange={(event) => setGuess(event.target.value)} required /></label>
      <div className="play-actions"><button>提交猜测</button></div></form>}
  </div>;
}

function Placement({ props, add, panelItems, color, disabled }: {
  props: Props; add: (body: CanvasBody) => Promise<boolean>; panelItems: CanvasItem[]; color: string; disabled: boolean;
}) {
  const [type, setType] = useState<"shape" | "sticky" | "text" | "bubble" | "character" | "sticker" | "photo" | "link" | "group" | "wish">("sticky");
  const [value, setValue] = useState("");
  const [other, setOther] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [shape, setShape] = useState<"rect" | "ellipse" | "line">("rect");
  const [avatar, setAvatar] = useState(0);
  const [expression, setExpression] = useState(0);
  const photos = props.shared.flatMap((entry) => (entry.data.photos ?? []).flatMap((photo) => photo.fileId
    ? [{ title: entry.data.title + " · " + photo.name, recordId: entry.id, fileId: photo.fileId }] : []));
  const wishes = props.shared.filter(({ data }) => data.kind === "wish");
  const blooms = props.state.id === "c22" ? flowers : [];
  const palette = [...new Set([...stickers, ...blooms.map(({ symbol }) => symbol)])];
  function send(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    let item: CanvasBody | undefined;
    switch (type) {
      case "shape": item = { kind: "shape", shape, color }; break;
      case "character": item = { kind: "character", avatar, expression, color }; break;
      case "link": item = { kind: "link", from: value, to: other, color }; break;
      case "group": item = { kind: "group", children: members }; break;
      case "photo": {
        const photo = photos.find((photo) => photo.fileId === value);
        if (photo) item = { kind: "photo", reference: { recordId: photo.recordId, fileId: photo.fileId } };
        break;
      }
      case "wish": if (wishes.some((wish) => wish.id === value)) item = { kind: "wish", reference: { recordId: value } }; break;
      case "sticker": item = { kind: "sticker", text: palette.includes(value) ? value : palette[0], color }; break;
      default: item = { kind: type, text: value, color };
    }
    if (item) void add(item).then((saved) => { if (saved) setValue(""); });
  }

  return <details><summary>加入物件</summary>
    <form onSubmit={send}><fieldset className="play-fields play-placement" disabled={disabled}>
      <label>物件类型<select value={type} onChange={(event) => {
        setType(event.target.value as typeof type); setValue("");
      }}>
        <option value="sticky">便签</option><option value="text">文字</option><option value="shape">形状</option>
        <option value="sticker">贴纸</option><option value="photo">共同照片</option><option value="link">连线</option>
        <option value="group">组合</option>
        {props.state.id === "c16" && <><option value="bubble">对白气泡</option><option value="character">原创角色</option></>}
        {props.state.id === "c22" && <option value="wish">共同愿望</option>}
      </select></label>
      {type === "shape" && <label>形状<select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)}>
        <option value="rect">方框</option><option value="ellipse">椭圆</option><option value="line">短线</option>
      </select></label>}
      {type === "character" && <div className="play-fields play-split">
        <label>角色<select value={avatar} onChange={(event) => setAvatar(Number(event.target.value))}>
          {characters.map((name, index) => <option value={index} key={name}>{name}</option>)}</select></label>
        <label>表情<select value={expression} onChange={(event) => setExpression(Number(event.target.value))}>
          {expressions.map((name, index) => <option value={index} key={name}>{name}</option>)}</select></label>
      </div>}
      {type === "sticker" && <label>贴纸<select value={value || palette[0]} onChange={(event) => setValue(event.target.value)}>
        {palette.map((symbol) => {
          const flower = blooms.find((flower) => flower.symbol === symbol);
          return <option key={symbol} value={symbol}>{flower ? `${flower.name} ${symbol}` : symbol}</option>;
        })}</select></label>}
      {type === "photo" && <label>共同照片<select required value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">请选择</option>
        {photos.map((photo) => <option value={photo.fileId} key={photo.fileId}>{photo.title}</option>)}
      </select></label>}
      {type === "wish" && <label>共同愿望<select required value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">请选择</option>
        {wishes.map((wish) => <option value={wish.id} key={wish.id}>{wish.data.title}</option>)}
      </select></label>}
      {type === "link" && <div className="play-fields play-split">
        {[{ label: "起点物件", current: value, choose: setValue }, { label: "终点物件", current: other, choose: setOther }]
          .map(({ label, current, choose }) => <label key={label}>{label}<select value={current} required onChange={(event) => choose(event.target.value)}>
            <option value="">请选择</option>{panelItems.map((item, index) => <option key={item.id} value={item.id}>{display(item, index)}</option>)}
          </select></label>)}
      </div>}
      {type === "group" && <label>选同一画面内自己的物件<select multiple value={members} onChange={(event) =>
        setMembers(Array.from(event.target.selectedOptions).map(({ value }) => value))}>
        {panelItems.filter((object) => object.by === props.seat && object.kind !== "link" && object.kind !== "group")
          .map((item, index) => <option key={item.id} value={item.id}>{display(item, index)}</option>)}
      </select></label>}
      {(type === "sticky" || type === "text" || type === "bubble") &&
        <label>要写的字<textarea required rows={2} maxLength={240} value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      <div className="play-actions"><button>放到画面中央</button></div>
    </fieldset></form>
  </details>;
}

function Captions({ props, panel, editable }: { props: Props; panel: number; editable: boolean }) {
  const { state, submit } = props;
  const [title, setTitle] = useState(state.frames[panel].title);
  const [cover, setCover] = useState(state.cover);
  const [ending, setEnding] = useState(state.ending);
  return <details><summary>分镜文字和封面</summary>
    <div className="play-fields">
      <label>分镜标题<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
      <button disabled={!editable} onClick={() => void submit({ type: "comic.caption", panel, text: title })}>保存分镜标题</button>
      <label>分镜背景<select disabled={!editable} value={state.frames[panel].background ?? "paper"}
        onChange={(event) => void submit({ type: "comic.background", panel, background: event.target.value })}>
        {Object.entries(comicBackgrounds).map(([key, item]) => <option value={key} key={key}>{item.name}</option>)}</select></label>
      <label>封面<input value={cover} maxLength={160} onChange={(event) => setCover(event.target.value)} /></label>
      <button disabled={props.disabled} onClick={() => void submit({ type: "comic.cover", text: cover })}>保存封面</button>
      <label>结尾<input value={ending} maxLength={160} onChange={(event) => setEnding(event.target.value)} /></label>
      <button disabled={props.disabled} onClick={() => void submit({ type: "comic.ending", text: ending })}>保存结尾</button>
    </div>
  </details>;
}

export function DrawingRoom(props: Props) {
  const { state, seat, client, view, disabled, busy, pending, submit, service, report } = props;
  const [panel, setPanel] = useState(0);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [color, setColor] = useState(brushColors[0]);
  const [width, setWidth] = useState(4);
  const [tool, setTool] = useState<"draw" | "erase" | "pan" | "select">("draw");
  const [drawingGesture, setDrawingGesture] = useState(false);
  const [showPartnerCursor, setShowPartnerCursor] = useState(false);
  const [selection, select] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [savingWish, setSavingWish] = useState(false);
  const [strokes, setStrokes] = useState(() => client.loadDraft<QueuedStroke[]>(view.room, "stroke-queue") ?? []);
  const queue = useRef(strokes);
  const saveGeneration = useRef(0);
  const flushing = useRef(false);
  const [failed, setFailed] = useState(false);
  const round = state.rounds.at(-1);
  const frame = state.frames[panel];
  const objects = useMemo(() => sortedItems(state.objects, panel), [state.objects, panel]);
  const objectIds = useMemo(() => new Set(objects.map(({ id }) => id)), [objects]);
  const selected = selection.filter((id) => objectIds.has(id));
  const item = selected.length === 1 ? objects.find((object) => object.id === selected[0]) : undefined;
  const searchTerm = search.trim().normalize("NFKC").toLowerCase();
  const choices = objects.map((object, index) => ({ object, label: display(object, index) }))
    .filter(({ object, label }) => !searchTerm || (label + " " + ("text" in object ? object.text : "") + " " + object.id)
      .normalize("NFKC").toLowerCase().includes(searchTerm));
  const canDraw = !disabled && (!frame || frame.owner === seat) &&
    (!round || (!!round.secret && round.author === seat && !round.result));
  const editable = canDraw && !busy && !pending;
  const eraseEnabled = state.id === "g01" && editable && strokes.length === 0;
  const activeRound = state.rounds.length;

  function keep(next: QueuedStroke[]) {
    queue.current = next;
    setStrokes(next);
    const generation = ++saveGeneration.current;
    void client.saveDraft(view.room, "stroke-queue", next.length ? next : null, () => generation === saveGeneration.current).catch(report);
  }

  useEffect(() => {
    const first = queue.current[0];
    if (!first) return;
    if (Object.hasOwn(state.versions, first.item.id)) {
      keep(queue.current.slice(1));
      setFailed(false);
      return;
    }
    if (disabled || busy || pending || flushing.current || failed || first.round !== state.rounds.length) return;
    flushing.current = true;
    void submit({ type: "canvas.add", item: first.item, panel: first.panel }).then((saved) => {
      flushing.current = false;
      if (saved && queue.current[0]?.item.id === first.item.id) keep(queue.current.slice(1));
      if (!saved) setFailed(true);
    });
  }, [busy, pending, disabled, failed, strokes, state.versions, state.rounds.length, submit]);

  const visual = useMemo(() => !strokes.length ? objects : [...objects, ...strokes.flatMap((stroke, index) => stroke.panel === panel && stroke.round === activeRound &&
    !Object.hasOwn(state.versions, stroke.item.id) ? [{
      ...stroke.item, by: seat, angle: 0, version: 0, panel, layer: 10001 + index,
    }] : [])], [objects, strokes, panel, activeRound, state.versions, seat]);
  const add = (body: CanvasBody) => submit({ type: "canvas.add", panel, item: {
    ...body, id: newId(), x: body.kind === "group" ? 0 : camera.x + objects.length % 4 * 12,
    y: body.kind === "group" ? 0 : camera.y + objects.length % 4 * 12,
  } });
  const move = (dx: number, dy: number) => setCamera(({ x, y, zoom }) =>
    ({ x: Math.max(-900000, Math.min(900000, x + dx)), y: Math.max(-900000, Math.min(900000, y + dy)), zoom }));
  const modify = (changes: { x?: number; y?: number; angle?: number; layer?: number }) => {
    if (item) void submit({ type: "canvas.change", id: item.id, version: item.version, ...changes });
  };
  const wish = item?.kind === "wish" ? props.shared.find((entry) => entry.id === item.reference.recordId && entry.data.kind === "wish") : undefined;
  const wishMemoryId = wish ? hashText(JSON.stringify(["Us/play/completed-wish/1", wish.id])).slice(0, 32) : undefined;
  const wishMemory = wishMemoryId ? service.entries.find(({ id, visibility, data }) => id === wishMemoryId &&
    visibility === "shared" && data.kind === "memory" && data.targetId === wish?.id) : undefined;
  async function saveWishMemory() {
    if (!wish?.data.completedAt || !wishMemoryId || !window.confirm("将愿望标题和完成日期写入共同日记？")) return;
    setSavingWish(true);
    try {
      let entry: Entry;
      try {
        entry = await service.save({ kind: "memory", title: wish.data.title, date: wish.data.completedAt, targetId: wish.id },
          "shared", undefined, wishMemoryId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "REVISION_CONFLICT") throw error;
        await service.refresh();
        const existing = service.active.find(({ id, visibility, data }) => id === wishMemoryId &&
          visibility === "shared" && data.kind === "memory" && data.targetId === wish.id);
        if (!existing) throw error;
        entry = existing;
      }
      props.openMemory(entry);
    } catch (error) { report(error); }
    finally { setSavingWish(false); }
  }
  const canGroup = selected.length >= 2 && selected.length <= 15 && selected.every((id) => {
    const object = objects.find((object) => object.id === id);
    return object?.by === seat && object.kind !== "group" && object.kind !== "link" &&
      !objects.some((member) => member.kind === "group" && member.children.includes(id));
  });

  return <div className="play-drawing">
    {state.id === "g01" && <DrawGuess key={state.rounds.length} props={{ ...props,
      disabled: disabled || busy || pending || !!strokes.length || drawingGesture }} />}
    {!!state.frames.length && <div className="play-actions">
      {state.frames.map(({ owner, title }, index) => <button key={index} aria-pressed={panel === index}
        onClick={() => { setPanel(index); setCamera({ x: 0, y: 0, zoom: 1 }); select([]); setSearch(""); }}>
        {title || `分镜 ${index + 1}`}{owner !== null ? " · " + props.members[owner] : ""}
      </button>)}
      {!disabled && frame?.owner === null && <button className="primary" onClick={() => void submit({ type: "comic.claim", panel })}>认领这一格</button>}
    </div>}
    <div className="play-actions play-tools">
      {editable && <><button aria-pressed={tool === "draw"} onClick={() => setTool("draw")}>画笔</button>
        {state.id === "g01" && <button aria-pressed={tool === "erase"} disabled={!eraseEnabled || drawingGesture}
          onClick={() => setTool(tool === "erase" ? "draw" : "erase")} title="擦掉碰到的整笔">橡皮</button>}
        <label>颜色<select value={color} onChange={(event) => setColor(event.target.value)}>
          {brushColors.map((value, i) => <option key={value} value={value}>{["墨色", "砖红", "赭色", "草绿", "湖蓝", "藤紫", "鹅黄"][i]}</option>)}
        </select></label>
        <label>粗细<input aria-label="笔画粗细" type="range" min={1} max={28} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label></>}
      <button aria-pressed={tool === "pan"} onClick={() => setTool(tool === "pan" ? "draw" : "pan")}>平移</button>
      {state.id !== "g01" && <button aria-pressed={tool === "select"} onClick={() => setTool(tool === "select" ? "draw" : "select")}>框选物件</button>}
      <button onClick={() => setCamera((value) => ({ ...value, zoom: Math.min(4, value.zoom * 1.25) }))}>放大</button>
      <button onClick={() => setCamera((value) => ({ ...value, zoom: Math.max(0.16, value.zoom / 1.25) }))}>缩小</button>
      {view.room.mode === "realtime" && view.room.status === "active" &&
        <button aria-pressed={showPartnerCursor} onClick={() => setShowPartnerCursor((value) => !value)}>显示搭档光标</button>}
      {eraseEnabled && tool === "erase" && <small>拖过笔迹可擦掉整笔。</small>}
    </div>
    <CanvasBoard service={service} objects={visual} paper={state.paper} camera={camera} label="双人画布" background={frame?.background}
      enabled={canDraw && tool === "draw" && strokes.length < 20} onPan={tool === "pan" ? move : undefined} color={color} width={width}
      onDrawActivity={state.id === "g01" ? setDrawingGesture : undefined}
      canStartStroke={round?.secret ? () => roomClock(view.room) < round.start + round.seconds * 1000 : undefined}
      onErase={tool === "erase" && eraseEnabled ? (path, radius) => {
        const items = strokesUnderEraser(objects.filter((item) => item.by === seat), path, radius);
        if (items.length) void submit({ type: "canvas.erase", round: activeRound, items });
      } : undefined}
      onSelect={tool === "select" ? (ids) => select(ids.filter((id) => objectIds.has(id))) : undefined}
      selected={selected}
      remote={view.room.status === "active" && props.preview?.panel === panel ? props.preview : null}
      showPartnerCursor={showPartnerCursor}
      lowResolution={props.lowResolution}
      onPreview={(points, x, y) => props.sendPreview({ panel, x, y, points, color, width })}
      onPreviewEnd={() => props.sendPreview(null)}
      onStroke={(points, x, y) => {
        if (queue.current.length >= 20) return;
        keep([...queue.current, { panel, round: activeRound, item: { kind: "stroke", id: newId(), color, width, points, x, y } }]);
      }} />
    {!!selected.length && <div className="play-actions">
      <span role="status">已选中 {selected.length} 件物件</span>
      {editable && canGroup && <button onClick={() => {
        const id = newId();
        void submit({ type: "canvas.add", panel, item: { id, kind: "group", children: selected, x: 0, y: 0 } })
          .then((saved) => { if (saved) select([id]); });
      }}>组合所选物件</button>}
      <button onClick={() => select([])}>取消选择</button>
    </div>}
    {strokes.length > 0 && <div className="play-actions">
      <p role="status">{strokes.length} 笔留在本机{strokes.length === 20 ? "，等待同步后可继续绘制" : ""}。</p>
      {failed && !pending && strokes[0].round === activeRound &&
        <button disabled={disabled || busy} onClick={() => setFailed(false)}>重试笔迹同步</button>}
      {(failed || strokes[0].round !== activeRound) && !pending && <button disabled={busy} onClick={() => {
        if (window.confirm("清除此设备上待同步的笔迹？")) { keep([]); setFailed(false); }
      }}>丢弃本机待同步笔迹</button>}
    </div>}
    <div className="play-actions">
      {editable && <>
        <button disabled={!state.undo[seat].length || drawingGesture} onClick={() => void submit({ type: "canvas.undo" })}>撤销我的操作</button>
        <button disabled={!state.redo[seat].length || drawingGesture} onClick={() => void submit({ type: "canvas.redo" })}>重做我的操作</button>
        {state.id !== "g01" && <label>纸张<select value={state.paper}
          onChange={(event) => void submit({ type: "canvas.paper", paper: event.target.value as Drawing["paper"] })}>
          <option value="plain">白纸</option><option value="grid">点阵</option><option value="pink">粉色</option>
        </select></label>}
        {state.id === "g01" && <button disabled={drawingGesture} onClick={() => {
          const last = objects.filter((item) => item.by === seat).at(-1);
          if (last) void submit({ type: "canvas.delete", id: last.id, version: last.version });
        }}>擦除上一笔</button>}
        {objects.some((item) => item.by === seat) && <button disabled={drawingGesture} onClick={() => {
          if (window.confirm("清空这张画面上自己绘制的内容？")) void submit({ type: "canvas.clear", panel });
        }}>清空我的画面</button>}
      </>}
      <button onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>回到中心</button>
    </div>
    <details><summary>浏览与编辑物件</summary>
      <div className="play-fields">
        <div className="play-actions">
          <button onClick={() => move(-100, 0)}>画面向左</button><button onClick={() => move(100, 0)}>画面向右</button>
          <button onClick={() => move(0, -100)}>画面向上</button><button onClick={() => move(0, 100)}>画面向下</button>
        </div>
        <label>搜索物件<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称、文字或编号" /></label>
        {searchTerm && <small role="status">找到 {choices.length} 件物件</small>}
        <label>画面物件<select value={choices.some(({ object }) => object.id === item?.id) ? item?.id : ""}
          onChange={(event) => select(event.target.value ? [event.target.value] : [])}>
          <option value="">请选择</option>
          {choices.map(({ object, label }) => <option key={object.id} value={object.id}>{label}</option>)}
        </select></label>
        {item && <div className="play-actions">
          <button onClick={() => setCamera((value) => ({ ...value, x: item.x, y: item.y }))}>定位物件</button>
          {editable && item.by === seat && <>
            <button onClick={() => modify({ x: item.x - 20 })}>左移</button><button onClick={() => modify({ x: item.x + 20 })}>右移</button>
            <button onClick={() => modify({ y: item.y - 20 })}>上移</button><button onClick={() => modify({ y: item.y + 20 })}>下移</button>
            <button onClick={() => modify({ angle: (item.angle + 15) % 360 })}>旋转</button>
            <button onClick={() => modify({ layer: Math.max(0, ...objects.map(({ layer }) => layer)) + 1 })}>移到上层</button>
            <button onClick={() => void submit({ type: "canvas.delete", id: item.id, version: item.version })}>移除物件</button>
          </>}
          {wish && <>
            <button onClick={() => props.openMemory(wish)}>打开{wish.data.title}</button>
            {wish.data.wishTargetDate && <small>目标 {dateLabel(wish.data.wishTargetDate)}</small>}
            <button disabled={disabled || savingWish} onClick={() => void service.save({ ...wish.data,
              completedAt: wish.data.completedAt ? undefined : service.day }, "shared", wish)
              .then(() => setCamera((value) => ({ ...value }))).catch(report)}>{wish.data.completedAt ? "重新列为待完成" : "标记愿望完成"}</button>
            {wishMemory ? (wishMemory.deletedAt ? <small>这条完成回忆在回收站。</small> :
              <button onClick={() => props.openMemory(wishMemory)}>打开完成回忆</button>) :
              wish.data.completedAt && <button disabled={disabled || savingWish} onClick={() => void saveWishMemory()}>生成共同回忆</button>}
          </>}
        </div>}
      </div>
    </details>
    {canDraw && state.id !== "g01" && <Placement key={`placement-${panel}`} props={props}
      add={add} panelItems={objects} color={color} disabled={!editable} />}
    {frame && <Captions key={`captions-${panel}`} props={props} panel={panel} editable={editable} />}
  </div>;
}
