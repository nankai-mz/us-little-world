import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { newPet } from "../../../src/core/domain";
import { mealRecord, updateMealPlan } from "../../../src/core/meal-plan";
import type { UsService } from "../../../src/core/service";
import type { Entry } from "../../../src/core/types";
import type { Seat } from "../../../src/features/play-core/protocol";
import {
  escapeRooms, flightBadges, ingredients, kitchens, orders, sameCell, type Coord, type MazeLevel,
} from "../../../src/features/scene-core/levels";
import {
  applyExplorer, applyScene, availableWorldItems, itemsFor, levelsFor, stardust, startScene, worldSize, type Decoration, type Escape, type Explorer,
  type Kitchen, type SceneCommand, type SceneGame, type World,
} from "../../../src/features/scene-core/scene";
import { PlayPhoto } from "./MediaRoom";
import { FlightJoystick } from "./FlightJoystick";
import { exportEscapePostcard } from "./visualExport";

type Props = {
  service: UsService;
  roomId: string;
  game: SceneGame;
  seat: Seat;
  disabled: boolean;
  busy?: boolean;
  lowEffects?: boolean;
  reduceMotion?: boolean;
  predictMoves?: boolean;
  members: [string, string];
  shared: Entry[];
  submit: (command: SceneCommand) => Promise<boolean>;
  openMemory: (entry: Entry) => void;
  report: (error: unknown) => void;
  openMusic: () => void;
  openDrawing: () => void;
  gameNow: () => number;
};

const directions: { key: string; label: string; delta: Coord }[] = [
  { key: "ArrowUp", label: "上移", delta: [0, -1] }, { key: "ArrowLeft", label: "左移", delta: [-1, 0] },
  { key: "ArrowDown", label: "下移", delta: [0, 1] }, { key: "ArrowRight", label: "右移", delta: [1, 0] },
];

function SceneGrid({ label, rows, avatars, badges, predicted, render, onMove, disabled }: {
  label: string; rows: string[]; avatars: [Coord, Coord]; render: (tile: string, point: Coord) => ReactNode;
  onMove: (delta: Coord) => void; disabled: boolean; badges?: Explorer["badges"]; predicted?: Seat;
}) {
  function onKey(event: KeyboardEvent) {
    const direction = directions.find(({ key }) => key === event.key);
    if (!direction) return;
    event.preventDefault();
    if (!disabled) onMove(direction.delta);
  }
  const width = rows[0].length;
  const together = sameCell(avatars[0], avatars[1]);
  return <div className="play-scene" tabIndex={0} role="group" aria-label={label + "。使用方向键移动。"} onKeyDown={onKey}
    style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}>
    {rows.flatMap((row, y) => Array.from(row).map((tile, x) => {
      const key = x + "," + y;
      return <div key={key} data-tile={tile} aria-hidden="true">
        <span>{render(tile, [x, y])}</span>
      </div>;
    }))}
    {avatars.map(([x, y], seat) => <b key={seat} data-avatar={seat} data-flight-badge={badges?.[seat] ?? undefined}
      data-predicting={predicted === seat || undefined} aria-hidden="true"
      style={{ left: (x + 0.5 + (together ? (seat ? 0.19 : -0.19) : 0)) * 100 / width + "%",
        top: (y + 0.5) * 100 / rows.length + "%", width: Math.min(6.5, (together ? 44 : 65) / width) + "%" }}>
      {seat === 0 ? "A" : "B"}</b>)}
  </div>;
}

function Controls({ disabled, move, use, label, pacing, useDisabled }: {
  disabled: boolean; move: (delta: Coord) => void; use?: () => void; label?: string; pacing?: boolean; useDisabled?: boolean;
}) {
  return <div className="play-actions play-controls">
    {directions.map(({ key, delta, label }) => <button key={key} disabled={disabled || pacing} onClick={() => move(delta)}>
      {label}</button>)}
    {use && <button className="primary" disabled={disabled || useDisabled} onClick={use}>{label || "操作机关"}</button>}
  </div>;
}

function moveFrom(from: Coord, delta: Coord): Extract<SceneCommand, { type: "scene.move" }> {
  return { type: "scene.move", from, to: [from[0] + delta[0], from[1] + delta[1]] };
}

const lockIcons = { box: "▣", mirror: "◈", dial: "◉", lamp: "✦", door: "▤" };

function EscapeRoom({ props, game }: { props: Props; game: Escape }) {
  const theme = escapeRooms[game.level];
  const lock = theme.locks[game.solved];
  const [input, enter] = useState("");
  const [inspected, inspect] = useState<number>();
  const current = inspected ?? (lock?.role === props.seat ? game.solved : undefined);
  const object = current === undefined ? undefined : theme.locks[current];
  const stateOf = (index: number) => index < game.solved ? "已打开" : index === game.solved ? "当前机关" : "尚未解锁";
  return <>
    <h3>{theme.name} · {theme.areas[props.seat]}</h3>
    <p key={game.solved} role="status" className={game.solved > 0 ? "play-lock-progress" : undefined}>
      已解开 {game.solved} / {theme.locks.length} 道机关。
    </p>
    <div className="play-pair">
      <article><h4>我这里的机关</h4><div className="play-locks">
        {theme.locks.map((item, index) => item.role === props.seat && <button type="button" key={item.name}
          aria-pressed={current === index} onClick={() => {
            if (current !== index) { inspect(index); enter(""); }
          }}>
          <span aria-hidden="true">{lockIcons[item.kind]}</span><strong>{item.name}</strong><small>{stateOf(index)}</small>
        </button>)}
      </div></article>
      <article><h4>给搭档的线索</h4>{lock && lock.role !== props.seat ? <p>{lock.clue}</p>
        : <p>{lock ? "搭档那边有当前机关的线索。" : "所有机关都打开了。"}</p>}</article>
    </div>
    {object && current !== undefined && <section key={current} className="play-lock-detail" aria-label={object.name + "细节"}>
      <span className="play-lock-symbol" aria-hidden="true">{lockIcons[object.kind]}</span>
      <div><h4>{object.name}</h4><p>{stateOf(current)}</p>
        {current === game.solved && !props.disabled && <>
          <details><summary>需要一点提示</summary><p>{object.hint}</p></details>
          <form className="play-fields" onSubmit={(event) => {
            event.preventDefault();
            void props.submit({ type: "escape.solve", stage: game.solved, value: input }).then((saved) => {
              if (saved) { enter(""); inspect(undefined); }
            });
          }}>
            <label>{object.name}密码<input required maxLength={12} value={input} onChange={(event) => enter(event.target.value)} /></label>
            <button className="primary">试试这组密码</button>
          </form>
        </>}
      </div>
    </section>}
    {!lock && <><article className="play-escape-postcard">
      <small>双人密室 · 通关明信片</small><h3>{theme.name}</h3><p>{props.members.join(" 和 ")}</p>
      <button onClick={() => {
        if (window.confirm("导出的明信片可以直接查看，并包含两位成员的显示名称。确认导出？"))
          void exportEscapePostcard(props.service, theme.name, props.members).catch(props.report);
      }}>导出通关明信片</button>
    </article>
      {game.level + 1 < escapeRooms.length && <button disabled={props.disabled} onClick={() => void props.submit({ type: "scene.next" })}>进入下一间密室</button>}
    </>}
  </>;
}

function useFlightCamera(props: Props, game: Explorer, map: MazeLevel, complete: boolean) {
  const inSpace = game.id === "g12";
  const motion = inSpace && !props.lowEffects && !props.reduceMotion;
  const cacheKey = `us.play.g12.landed.${props.roomId}`;
  const [phase, setPhase] = useState<"landing" | "departure" | undefined>(() => {
    if (!motion || props.disabled || complete || game.stars.length || game.lit.some(Boolean) ||
      !game.avatars.every((avatar, seat) => sameCell(avatar, map.start[seat]))) return undefined;
    try {
      if (sessionStorage.getItem(cacheKey) === String(game.level)) return undefined;
    } catch { /* The cutscene still works when storage is unavailable. */ }
    return "landing";
  });
  const hadCompleted = useRef(complete);
  const scene = motion ? phase : undefined;

  useEffect(() => {
    if (inSpace) {
      try { sessionStorage.setItem(cacheKey, String(game.level)); } catch { /* Camera preference is optional. */ }
    }
  }, [cacheKey, game.level, inSpace]);

  useEffect(() => {
    if (complete && !hadCompleted.current) setPhase(motion ? "departure" : undefined);
    hadCompleted.current = complete;
  }, [complete, motion]);

  useEffect(() => {
    if (!motion) setPhase(undefined);
    if (!scene) return;
    const timer = window.setTimeout(() => setPhase(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [motion, scene]);

  return { scene, skip: () => setPhase(undefined) };
}

function Exploration({ props, game }: { props: Props; game: Explorer }) {
  const levels = levelsFor(game.id);
  const level = levels[game.level];
  const complete = game.solved.includes(game.level);
  const locked = props.disabled || !!props.busy || complete;
  const current = game.avatars[props.seat];
  const isShadow = game.id === "g13";
  const bridgeOpen = game.lit.every(Boolean);
  const onPortal = !!level.portals?.some((cell) => sameCell(cell, current));
  const onControl = isShadow && !game.lit[props.seat] && sameCell(level.controls[props.seat], current);
  const [prediction, setPrediction] = useState<{ from: Coord; to: Coord }>();
  const moving = useRef(false);
  const provisional = props.predictMoves && prediction && sameCell(current, prediction.from) ? prediction.to : undefined;
  const avatars: [Coord, Coord] = [...game.avatars];
  if (provisional) avatars[props.seat] = provisional;
  const position = game.id === "g12" ? `宇航员 ${props.seat === 0 ? "A" : "B"}` : props.seat === 0 ? "光之角色" : "影之角色";
  const { scene, skip } = useFlightCamera(props, game, level, complete);
  const move = (delta: Coord) => {
    if (locked || moving.current) return;
    if (scene) skip();
    const command = moveFrom(current, delta);
    if (game.id === "g12" && props.predictMoves) {
      try {
        const next = applyExplorer(game, command, props.seat);
        setPrediction({ from: current, to: next.avatars[props.seat] });
      } catch { /* Submit still checks the latest confirmed room revision. */ }
    }
    moving.current = true;
    void props.submit(command).finally(() => {
      moving.current = false;
      setPrediction(undefined);
    });
  };
  const grid = <SceneGrid label={level.name} rows={level.rows} avatars={avatars} badges={game.id === "g12" ? game.badges : undefined}
    predicted={provisional ? props.seat : undefined}
    disabled={locked} onMove={move}
    render={(tile, point) => {
      if (sameCell(point, level.exit)) return "🚩";
      if (game.box && sameCell(point, game.box)) return "📦";
      if (level.portals?.some((item) => sameCell(item, point))) return "◉";
      const control = level.controls.findIndex((item) => sameCell(item, point));
      if (control >= 0) return game.lit[control] ? "◆" : (game.id === "g13" && control === 0 ? "✧" : control === 0 ? "◈" : "◇");
      const star = level.stars.findIndex((item) => sameCell(item, point));
      if (star >= 0 && !game.stars.includes(star)) return "✦";
      if (tile === "G") return bridgeOpen ? "·" : "▥";
      if (tile === "D") return "◐";
    }} />;

  return <>
    <h3>{level.name}</h3>
    <p>第 {game.level + 1} / {levels.length} 关 · 你是{position} · 位置 {current[0] + 1}, {current[1] + 1}</p>
    {provisional && <p role="status">位置确认中</p>}
    <p>{game.id === "g12" ? `各踩一块压力板，再收集 ${level.stars.length} 颗星尘。两人抵达同一出口后过关。`
      : "光之角色点亮反光镜，影之角色穿过影门按下按钮。两处机关启动后，两人可从光桥走到出口。"}
      {game.id === "g12" && " 星尘 " + game.stars.length + "/" + level.stars.length}</p>
    {game.id === "g12" ? <div className="play-flight" data-flight-scene={scene} style={{
      "--flight-exit-x": `${(level.exit[0] + 0.5) * 100 / level.rows[0].length}%`,
      "--flight-exit-y": `${(level.exit[1] + 0.5) * 100 / level.rows.length}%`,
    } as CSSProperties}>
      {grid}
      {scene && <div className="play-flight-caption"><strong role="status">{scene === "landing" ? "正在着陆" : "星球探索完成"}</strong>
        <button type="button" onClick={skip}>跳过过场</button></div>}
    </div> : <div className="play-shadow" data-reflector-lit={game.lit[0]} data-bridge-open={bridgeOpen}>
      <p role="status">反光镜{game.lit[0] ? "已点亮" : "待点亮"} · 影之按钮{game.lit[1] ? "已按下" : "待按下"} · 光桥{bridgeOpen ? "已开启" : "未开启"}</p>
      {grid}
    </div>}
    {game.id === "g12" && <FlightJoystick disabled={locked} move={move} />}
    <Controls disabled={locked} move={move}
      use={isShadow || level.portals ? () => void props.submit({ type: "scene.use", from: current }) : undefined}
      useDisabled={!onControl && !onPortal}
      label={!isShadow || (onPortal && !onControl) ? "使用传送点" : props.seat === 0 ? "点亮反光镜" : "按下影之按钮"} />
    {complete && <div className="play-actions"><strong>两个人都到达了出口</strong>
      {game.level + 1 < levels.length && <button className="primary" disabled={props.disabled || props.busy}
        onClick={() => void props.submit({ type: "scene.next" })}>前往下一关</button>}</div>}
    {game.id === "g12" && <>
      <AstronautBadges props={props} game={game} />
      <PlanetMonument props={props} game={game} />
    </>}
  </>;
}

function AstronautBadges({ props, game }: { props: Props; game: Explorer }) {
  const dust = stardust(game);
  const own = game.badges?.[props.seat] ?? null;
  const partner = flightBadges.find(({ id }) => id === game.badges?.[props.seat === 0 ? 1 : 0]);
  return <details>
    <summary>宇航服装饰</summary>
    <p>共同星尘 {dust} 颗。解锁后可随时更换。</p>
    {partner && <p>搭档佩戴 {partner.name}</p>}
    <div className="play-fields"><label>我的装饰<select value={own ?? ""} disabled={props.disabled} onChange={(event) => {
      const badge = flightBadges.find(({ id }) => id === event.target.value)?.id ?? null;
      if (badge !== own) void props.submit({ type: "scene.badge", badge, previous: own });
    }}>
      <option value="">不佩戴</option>
      {flightBadges.map((badge) => <option key={badge.id} value={badge.id} disabled={dust < badge.dust}>
        {badge.name}{dust < badge.dust ? ` · ${badge.dust} 颗星尘解锁` : ""}
      </option>)}
    </select></label></div>
  </details>;
}

function PlanetMonument({ props, game }: { props: Props; game: Explorer }) {
  const [memory, select] = useState(game.tribute ?? "");
  const [photo, selectPhoto] = useState(game.tributePhoto ?? "");
  const records = props.shared.filter(({ data }) => data.kind === "memory");
  const tribute = records.find(({ id }) => id === game.tribute);
  const surface = tribute?.data.photos?.find(({ fileId }) => fileId === game.tributePhoto);
  const source = records.find(({ id }) => id === memory);
  const photos = source?.data.photos?.filter(({ fileId }) => !!fileId) ?? [];
  return <details><summary>星球纪念碑</summary>
    {game.tribute && (tribute ? <>
      {surface?.fileId ? <button className="play-world-linked-photo" onClick={() => props.openMemory(tribute)}>
        <PlayPhoto service={props.service} photo={{ recordId: tribute.id, fileId: surface.fileId }} label="纪念碑上的共同照片" />
        <span>{tribute.data.title}</span>
      </button> : <>
        {game.tributePhoto && <p>纪念碑上的照片已移除。</p>}
        <button onClick={() => props.openMemory(tribute)}>{tribute.data.title}</button>
      </>}
    </> : <p>纪念碑的共同回忆已移除。</p>)}
    {!props.disabled && <div className="play-fields"><label>留下共同回忆<select value={source?.id ?? ""}
      onChange={(event) => { select(event.target.value); selectPhoto(""); }}>
      <option value="">选择一条共同日记</option>
      {records.map(({ id, data }) => <option key={id} value={id}>{data.title}</option>)}
    </select></label>
      {!!photos.length && <label>纪念碑照片<select value={photos.some(({ fileId }) => fileId === photo) ? photo : ""}
        onChange={(event) => selectPhoto(event.target.value)}>
        <option value="">纪念整条回忆</option>
        {photos.map(({ fileId, name }) => <option key={fileId} value={fileId}>{name}</option>)}
      </select></label>}
      <button disabled={!source} onClick={() => {
        if (source) void props.submit({ type: "scene.tribute", id: source.id, photo: photos.find(({ fileId }) => fileId === photo)?.fileId });
      }}>把回忆放在这里</button>
    </div>}
  </details>;
}

const stations: Record<string, string> = { F: "🥕", W: "💧", K: "🔪", T: "▤", C: "🍳", D: "🍽️" };
const stationNames: Record<string, string> = { F: "食材架", W: "水池", K: "案板", T: "交接台", C: "灶台", D: "装盘窗口" };
const stageLabel = { raw: "食材", washed: "已洗净", cut: "已切好", cooked: "已煮好" };
const kitchenStepIntervalMs = 180;

function KitchenRoom({ props, game }: { props: Props; game: Kitchen }) {
  const [map, selectMap] = useState(game.map);
  const [order, selectOrder] = useState(game.order ?? 0);
  const [ingredient, pick] = useState(0);
  const [practice, setPractice] = useState<Kitchen | null>(null);
  const [practiceSeat, setPracticeSeat] = useState<Seat>(0);
  const [stepping, setStepping] = useState(false);
  const stepTimer = useRef<number | undefined>(undefined);
  const [now, setNow] = useState(() => props.gameNow());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(props.gameNow()), 1000);
    return () => window.clearInterval(timer);
  }, [props.gameNow]);
  useEffect(() => () => window.clearTimeout(stepTimer.current), []);
  const current = practice ?? game;
  const seat = practice ? practiceSeat : props.seat;
  const position = current.avatars[seat];
  const recipe = current.order === null ? null : orders[current.order];
  const time = Math.max(0, Math.ceil((current.deadline - now) / 1000));
  const completed = !!recipe && current.plated.length === recipe.items.length;
  const submit = (command: SceneCommand) => {
    if (!practice) { void props.submit(command); return; }
    try { setPractice(applyScene(practice, command, seat) as Kitchen); } catch (error) { props.report(error); }
  };
  const locked = props.disabled && !practice;
  const move = (delta: Coord) => {
    if (stepTimer.current !== undefined) return;
    setStepping(true);
    stepTimer.current = window.setTimeout(() => {
      stepTimer.current = undefined;
      setStepping(false);
    }, kitchenStepIntervalMs);
    submit(moveFrom(position, delta));
  };

  return <>
    <h3>{current.order === null ? "一张新订单" : recipe!.name}</h3>
    <p>{seat === 0 ? "你负责备菜。取食材 → 清洗 → 切配 → 放到交接台。" : "你负责烹饪。从交接台取食材 → 灶台烹饪 → 窗口装盘。"}</p>
    <div className="play-actions">
      <button onClick={() => { setPractice(practice ? null : startScene("g04") as Kitchen); setPracticeSeat(0); }}>{practice ? "退出练习" : "本机双角色练习"}</button>
      {practice && <button onClick={() => setPracticeSeat((seat) => seat === 0 ? 1 : 0)}>切换练习角色</button>}
    </div>
    {(!recipe || completed || time === 0) && !locked && <div className="play-fields">
      <div className="play-fields play-split"><label>厨房地图<select value={map} onChange={(event) => selectMap(Number(event.target.value))}>
        {kitchens.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}</select></label>
        <label>订单<select value={order} onChange={(event) => {
          const value = Number(event.target.value); selectOrder(value); pick(orders[value].items[0]);
        }}>{orders.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}</select></label></div>
      <button className="primary" onClick={() => {
        pick(orders[order].items[0]); submit({ type: "kitchen.start", map, order, at: props.gameNow() });
      }}>{completed ? "开始下一份订单" : recipe ? "重新开火" : "开始备菜"}</button>
    </div>}
    {recipe && <>
      <p>剩余 {time} 秒 · 已装盘 {current.plated.length} / {recipe.items.length} · 交接台 {current.table ? ingredients[current.table.ingredient] : "空"}</p>
      <p>我手里：{current.carrying[seat] ? ingredients[current.carrying[seat]!.ingredient] + " · " + stageLabel[current.carrying[seat]!.stage] : "空"}</p>
      <p>当前位置 {position[0] + 1}, {position[1] + 1} · {position[1] === 2 && position[0] === (seat === 0 ? 4 : 6)
        ? "交接台" : stationNames[kitchens[current.map].rows[position[1]][position[0]]] ?? "通道"}</p>
      <SceneGrid label={kitchens[current.map].name} rows={kitchens[current.map].rows} avatars={current.avatars}
        render={(tile) => stations[tile]} onMove={move} disabled={locked || completed || !time || stepping} />
      {seat === 0 && <div className="play-fields"><label>订单食材<select value={ingredient} onChange={(event) => pick(Number(event.target.value))}>
        {recipe.items.map((id) => <option key={id} value={id}>{ingredients[id]}</option>)}</select></label></div>}
      <Controls disabled={locked || completed || !time} move={move} pacing={stepping}
        use={() => submit({ type: "kitchen.use", ingredient, at: props.gameNow() })} label="使用当前站点" />
      {completed && <div className="play-actions"><strong>这份{recipe.name}可以上桌了</strong>
        {!practice && !props.disabled && <button onClick={() => {
          const round = mealRecord(props.service, props.service.day, "晚餐")?.data.mealPlan?.round ?? 1;
          void updateMealPlan(props.service, props.service.day, "晚餐", { type: "add", name: recipe.name, tags: [], round }).catch(props.report);
        }}>把菜加进今天的晚餐候选</button>}</div>}
    </>}
  </>;
}

const keyId = () => crypto.randomUUID().replaceAll("-", "");
const featureLinks = {
  fridge: ["/app/play/food", "今天吃什么"],
  wardrobe: ["/app/play/wardrobe", "今天穿什么"],
  shelf: ["/app/memories", "共同日记"],
  window: ["/app/memories/galaxy", "回忆银河"],
} as const;

type FurnitureDrag = { pointer: number; source: Decoration; start: Coord; moved: boolean };

export function WorldLayout({ game, choose, current, relocate, touchMoveKey, editable = false, forceFlat = false }: {
  game: World; choose?: (x: number, y: number, item?: Decoration) => void; current?: Coord; editable?: boolean;
  relocate?: (source: Decoration, x: number, y: number) => void;
  touchMoveKey?: string;
  forceFlat?: boolean;
}) {
  const size = worldSize(game.id);
  const planet = game.id === "c17";
  const [origin, setOrigin] = useState<Coord>([0, 0]);
  const [rotation, rotate] = useState(0);
  const [overview, showAll] = useState(false);
  const [flat, setFlat] = useState(false);
  const [dropCell, setDropCell] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  const touchDrag = useRef<FurnitureDrag | undefined>(undefined);
  const mouseDrag = useRef<Decoration | undefined>(undefined);
  const skipTap = useRef(false);
  const width = overview ? size : Math.min(10, size);
  const projection = overview ? "overview" : planet && !flat && !forceFlat ? "isometric" : "flat";
  const objects = useMemo(() => new Map(game.decorations.map((item) => [item.x + "," + item.y, item])), [game.decorations]);
  const icons = useMemo(() => new Map(itemsFor(game.id).map(([id, name, symbol]) => [id as string, { name, symbol }])), [game.id]);

  function cellAt(event: PointerEvent<HTMLButtonElement>) {
    const button = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>("button[data-cell]");
    return button && grid.current?.contains(button) && !button.dataset.kind ? button.dataset.cell : undefined;
  }

  function handleTouchMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = touchDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.start[0], event.clientY - drag.start[1]) < 6) return;
    drag.moved = true;
    setDropCell(cellAt(event));
  }

  function finishTouchMove(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = touchDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    touchDrag.current = undefined;
    setDropCell(undefined);
    if (!drag.moved) return;
    skipTap.current = true;
    const cell = commit && editable && cellAt(event);
    if (cell) {
      const [x, y] = cell.split(",").map(Number);
      relocate?.(drag.source, x, y);
    }
  }

  const point = (index: number): Coord => {
    const a = index % width;
    const b = Math.floor(index / width);
    const end = width - 1;
    const cell = [[a, b], [b, end - a], [end - a, end - b], [end - b, a]][rotation];
    return [cell[0] + (overview ? 0 : origin[0]), cell[1] + (overview ? 0 : origin[1])];
  };
  return <>
    <div className="play-world-stage" data-projection={projection}>
      <div className="play-world" ref={grid} role="group" aria-label={planet ? "小星球地图" : "小屋地图"} data-world={game.id}
        style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}>
        {Array.from({ length: width ** 2 }, (_, index) => {
          const [x, y] = point(index);
          const cell = `${x},${y}`;
          const item = objects.get(cell);
          const icon = item ? icons.get(item.kind) : undefined;
          const name = `第 ${x + 1} 列，第 ${y + 1} 行${icon ? "，" + icon.name : "，空地"}`;
          const facing = (item?.angle ?? 0) + (projection === "isometric" ? 0 : rotation * 90);
          const symbol = icon && !overview ? <span aria-hidden="true" className="play-world-marker">
            <span style={{ transform: `rotate(${facing}deg)` }}>{icon.symbol}</span>
          </span> : null;
          const tile = { "aria-label": name, "data-cell": cell, "data-kind": item?.kind };
          const canTouchMove = !!item && item.key === touchMoveKey && editable && !!relocate;
          return choose ? <button key={cell} {...tile} type="button" disabled={!editable && !item}
            data-touch-move={canTouchMove || undefined} data-drop-cell={dropCell === cell || undefined}
            draggable={!!item && editable && !!relocate}
            onDragStart={(event) => {
              if (!item || touchDrag.current) { event.preventDefault(); return; }
              mouseDrag.current = item;
              event.dataTransfer.setData("text/plain", item.key);
            }} onDragEnd={() => { mouseDrag.current = undefined; }}
            onDragOver={(event) => { if (!item && editable && mouseDrag.current) event.preventDefault(); }}
            onDrop={(event) => {
              const source = mouseDrag.current;
              if (item || !editable || !relocate || !source) return;
              event.preventDefault();
              mouseDrag.current = undefined;
              relocate(source, x, y);
            }}
            onPointerDown={(event) => {
              skipTap.current = false;
              if (!item || !canTouchMove || !event.isPrimary || event.pointerType === "mouse" || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              touchDrag.current = { pointer: event.pointerId, source: item, start: [event.clientX, event.clientY], moved: false };
            }} onPointerMove={handleTouchMove} onPointerUp={(event) => finishTouchMove(event, true)}
            onPointerCancel={(event) => finishTouchMove(event, false)} onLostPointerCapture={(event) => finishTouchMove(event, false)}
            aria-pressed={current?.[0] === x && current[1] === y} onClick={(event) => {
              if (!skipTap.current || event.detail === 0) choose(x, y, item);
              skipTap.current = false;
            }}>{symbol}</button>
            : <div key={cell} {...tile}>{symbol}</div>;
        })}
      </div>
    </div>
    <div className="play-actions">
      <button onClick={() => rotate((value) => (value + 1) % 4)}>转个方向</button>
      {planet && !overview && !forceFlat && <button aria-pressed={flat} onClick={() => setFlat((value) => !value)}>二维网格</button>}
      {size > 10 && <button aria-pressed={overview} onClick={() => showAll((value) => !value)}>{overview ? "查看局部" : "看整个星球"}</button>}
      {size > 10 && !overview && directions.map(({ key, label, delta }) => <button key={key}
        onClick={() => setOrigin(([x, y]) => [Math.max(0, Math.min(size - width, x + delta[0] * 5)), Math.max(0, Math.min(size - width, y + delta[1] * 5))])}>
        地图{label}</button>)}
    </div>
  </>;
}

function WorldRoom({ props, game }: { props: Props; game: World }) {
  const [tile, pickTile] = useState<Coord>([0, 0]);
  const [key, select] = useState("");
  const [kind, setKind] = useState<string>(itemsFor(game.id)[0][0]);
  const [memory, setMemory] = useState("");
  const [photo, setPhoto] = useState("");
  const [move, setMove] = useState(false);
  const [petMotion, setPetMotion] = useState({ action: "idle", index: 0 });
  const item = game.decorations.find((decoration) => decoration.key === key);
  const pet = props.service.active.find(({ data }) => data.kind === "pet")?.data.pet ?? newPet();
  const record = props.shared.find((entry) => entry.id === item?.memory);
  const linkedPhoto = record?.data.photos?.find(({ fileId }) => fileId === item?.photo);
  const memories = props.shared.filter(({ data }) => data.kind === "memory");
  const chosenMemory = memories.find(({ id }) => id === memory);
  const photos = game.id === "c17" ? chosenMemory?.data.photos?.filter(({ fileId }) => !!fileId) ?? [] : [];
  const target = item && Object.hasOwn(featureLinks, item.kind) ? featureLinks[item.kind as keyof typeof featureLinks] : null;
  const size = worldSize(game.id);
  function relocate(source: Decoration, x: number, y: number) {
    void props.submit({ type: "world.edit", key: source.key, version: source.revision, x, y, angle: source.angle, memory: source.memory })
      .then((saved) => { if (saved) { setMove(false); select(source.key); pickTile([x, y]); } });
  }
  return <>
    <p>{game.id === "w23" ? "摆放后点家具，就能打开它对应的日常功能。" : "选择地块，摆放地形或纪念物。可以转动地图或者查看局部。"}
      已摆放 {game.decorations.length} 件。</p>
    <WorldLayout game={game} current={tile} editable={!props.disabled} forceFlat={props.lowEffects} relocate={relocate}
      touchMoveKey={game.id === "w23" && move ? item?.key : undefined} choose={(x, y, decoration) => {
      if (move && item && !props.disabled && !decoration) relocate(item, x, y);
      else {
        select(decoration?.key ?? ""); pickTile([x, y]); setMove(false);
      }
    }} />
    {!props.disabled && <div className="play-fields">
      {game.id === "c17" && !game.stargazingDecorations && <div className="play-actions">
        <button onClick={() => void props.submit({ type: "world.claimStargazingDecorations" })}>领取观星装饰</button>
      </div>}
      <div className="play-fields play-split"><label>物件<select aria-label="物件" value={kind} onChange={(event) => setKind(event.target.value)}>
        {availableWorldItems(game).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>关联共同回忆<select value={chosenMemory?.id ?? ""} onChange={(event) => { setMemory(event.target.value); setPhoto(""); }}>
          <option value="">暂不关联</option>
          {memories.map(({ id, data }) => <option value={id} key={id}>{data.title}</option>)}
        </select></label>
        {!!photos.length && <label>关联回忆中的照片<select value={photos.some(({ fileId }) => fileId === photo) ? photo : ""}
          onChange={(event) => setPhoto(event.target.value)}>
          <option value="">关联整条回忆</option>
          {photos.map(({ fileId, name }) => <option value={fileId} key={fileId}>{name}</option>)}
        </select></label>}
      </div>
      <div className="play-actions">
        <label>列 <input type="number" min={1} max={size} value={tile[0] + 1} onChange={(event) => pickTile([Number(event.target.value) - 1, tile[1]])} /></label>
        <label>行 <input type="number" min={1} max={size} value={tile[1] + 1} onChange={(event) => pickTile([tile[0], Number(event.target.value) - 1])} /></label>
        <button className="primary" onClick={() => void props.submit({ type: "world.put", item: { key: keyId(), kind, x: tile[0], y: tile[1], angle: 0,
          memory: chosenMemory?.id, photo: photos.find(({ fileId }) => fileId === photo)?.fileId } })}>把物件放在这里</button>
      </div>
    </div>}
    <details><summary>家具和布置清单</summary>
      <label>查看物件<select value={key} onChange={(event) => { select(event.target.value); setMove(false); }}>
        <option value="">选择物件</option>
        {game.decorations.map((item) => <option key={item.key} value={item.key}>
          {itemsFor(game.id).find(([kind]) => kind === item.kind)?.[1]} · {item.x + 1}, {item.y + 1}</option>)}
      </select></label>
    </details>
    {item && linkedPhoto?.fileId && record && <figure className="play-world-linked-photo"><PlayPhoto service={props.service}
      photo={{ recordId: record.id, fileId: linkedPhoto.fileId }} label="物件关联的照片" /></figure>}
    {item && <div className="play-actions">
      {target && <a className="play-back" href={target[0]}>{target[1]}</a>}
      {item.kind === "record" && <button onClick={props.openMusic}>打开音乐明信片</button>}
      {item.kind === "easel" && <button onClick={props.openDrawing}>打开无限画布</button>}
      {item.memory && (record ? <button onClick={() => props.openMemory(record)}>{record.data.title}</button> : <span>这条回忆已移除。</span>)}
      {record && item.photo && !linkedPhoto && <span>这张关联照片已移除。</span>}
      {!props.disabled && <>
        <button aria-pressed={move} onClick={() => setMove(!move)}>{move ? "取消移动" : "移动物件"}</button>
        {move && <span>{game.id === "w23" ? "拖动所选家具，或点选空地。" : "点选空地完成移动。"}</span>}
        <button onClick={() => void props.submit({ type: "world.edit", key: item.key, version: item.revision, x: item.x, y: item.y,
          angle: (item.angle + 90) % 360, memory: item.memory })}>旋转物件</button>
        <button onClick={() => void props.submit({ type: "world.remove", key: item.key, version: item.revision })}>取下物件</button>
      </>}
    </div>}
    {game.id === "w23" && <div className="play-garden">
      <span aria-hidden="true" className="play-house-pet" data-motion={petMotion.action} key={petMotion.index}>
        {petMotion.action === "sleep" ? "🐇💤" : petMotion.action === "feed" ? "🐇🥕" : "🐇"}
      </span>
      <h3>{pet.name}在小屋里</h3><p>饱食 {pet.hunger} · 心情 {pet.mood} · 精力 {pet.energy}</p>
      <div className="play-actions">
        <button onClick={() => setPetMotion(({ index }) => ({ action: "walk", index: index + 1 }))}>看它走走</button>
        {([["feed", "喂胡萝卜"], ["pat", "摸摸头"], ["sleep", "让它休息"]] as const).map(([action, label]) =>
          <button key={action} disabled={props.disabled} onClick={() => void props.service.interact(action)
            .then(() => setPetMotion(({ index }) => ({ action, index: index + 1 }))).catch(props.report)}>{label}</button>)}
      </div>
    </div>}
  </>;
}

export function SceneRoom(props: Props) {
  const { game } = props;
  switch (game.id) {
    case "g04": return <KitchenRoom props={props} game={game} />;
    case "g11": return <EscapeRoom key={game.level * 10 + game.solved} props={props} game={game} />;
    case "g12":
    case "g13": return <Exploration key={`${props.roomId}.${game.level}`} props={props} game={game} />;
    case "c17":
    case "w23": return <WorldRoom props={props} game={game} />;
  }
}
