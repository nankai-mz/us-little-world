import { useEffect, useMemo, useState, type FormEvent } from "react";
import { buildGalaxy } from "../../../src/core/galaxy";
import type { UsService } from "../../../src/core/service";
import { AppError, type Entry } from "../../../src/core/types";
import { connectTiles, pickPair, tileArt } from "../../../src/features/puzzle-core/grid";
import {
  flowers, gardenCard, growthStage, officialMusicLink, puzzleFinished, skyCardFingerprint, type BloomCard, type MediaCommand, type MediaGame, type Music,
  type PhotoReference, type Sky, type StarPosition, type Stars,
} from "../../../src/features/play-core/media-games";
import type { Seat } from "../../../src/features/play-core/protocol";
import { prepareBrowserPhoto } from "../../photos";
import { acquirePhotoUrl } from "../../photoUrls";
import type { PlayClient, RoomView } from "./client";
import { authorizedConstellation, StarMap } from "./ConstellationMap";
import { MemoryTreeEditor } from "./MemoryTree";

type Props = {
  service: UsService; client: PlayClient; view: RoomView; game: MediaGame; seat: Seat; disabled: boolean; reduceMotion?: boolean;
  shared: Entry[]; members: [string, string]; submit: (command: MediaCommand) => Promise<boolean>;
  openMemory: (entry: Entry) => void; report: (error: unknown) => void;
};

function options(entries: Entry[]) {
  return entries.flatMap((entry) => (entry.data.photos ?? []).flatMap((photo) => photo.fileId
    ? [{ recordId: entry.id, fileId: photo.fileId, name: entry.data.title + " · " + photo.name, entry }] : []));
}
function lookup(service: UsService, ref: PhotoReference | null) {
  if (!ref) return undefined;
  const record = service.active.find((item) => item.id === ref.recordId && item.visibility === "shared");
  return record?.data.photos?.find((photo) => photo.fileId === ref.fileId);
}

export function usePlayPhoto(service: UsService, ref: PhotoReference | null) {
  const [result, setResult] = useState<{ id: string; src: string }>();
  const [, refresh] = useState(0);
  const photo = lookup(service, ref);
  useEffect(() => {
    if (!ref || photo) return;
    let live = true;
    void service.refresh().then(() => { if (live) refresh((value) => value + 1); }).catch(() => {});
    return () => { live = false; };
  }, [service, ref?.recordId, ref?.fileId, !!photo]);
  useEffect(() => {
    if (!photo) return;
    let live = true;
    const token = acquirePhotoUrl(service, photo, "shared");
    void token.loaded.then((src) => { if (live) setResult({ id: photo.fileId!, src }); }).catch(() => {});
    return () => { live = false; token.release(); };
  }, [service, photo?.id, photo?.fileId]);
  return photo && result?.id === photo.fileId ? result?.src : undefined;
}

export function PlayPhoto({ service, photo, label }: { service: UsService; photo: PhotoReference; label: string }) {
  const src = usePlayPhoto(service, photo);
  return src ? <img className="play-photo" src={src} alt={label} /> : <p>照片暂不可用。</p>;
}

function ReferenceLink({ props, refId }: { props: Props; refId: string }) {
  const record = props.shared.find(({ id }) => id === refId);
  return record ? <button onClick={() => props.openMemory(record)}>打开回忆 · {record.data.title}</button> : <p>这段回忆已移除。</p>;
}

function PhotoPuzzle({ props, game }: { props: Props; game: Extract<MediaGame, { id: "g02" }> }) {
  const [selection, select] = useState("");
  const [size, setSize] = useState(3);
  const [active, setActive] = useState<number>();
  const photoOptions = options(props.shared.filter(({ data }) => data.kind === "memory"));
  const src = usePlayPhoto(props.service, game.photo);
  const done = puzzleFinished(game);
  const swap = (first: number, second: number) => {
    setActive(undefined);
    if (first !== second) void props.submit({ type: "puzzle.swap", a: first, b: second, values: [game.tiles[first], game.tiles[second]] });
  };
  if (!game.photo) return <form className="play-fields" onSubmit={(event) => {
    event.preventDefault();
    const item = photoOptions.find(({ fileId }) => fileId === selection);
    if (item) void props.submit({ type: "puzzle.pick", size, photo: { recordId: item.recordId, fileId: item.fileId } });
  }}>
    <h3>从共同相册选择照片</h3>
    {!photoOptions.length ? <p>共同相册里还没有可用照片。</p> : <>
      <label>拼图照片<select value={selection} required onChange={(event) => select(event.target.value)}>
        <option value="">选择照片</option>{photoOptions.map((item) => <option key={item.fileId} value={item.fileId}>{item.name}</option>)}
      </select></label>
      <label>拼图大小<select value={size} onChange={(event) => setSize(Number(event.target.value))}>
        {[3, 4, 6].map((value) => <option key={value} value={value}>{value} × {value}</option>)}
      </select></label>
      <button className="primary" disabled={props.disabled}>开始拼图</button>
    </>}
  </form>;
  if (done) return <><h3>一起把照片拼回来了</h3><PlayPhoto service={props.service} photo={game.photo} label="还原后的共同照片" />
    <ReferenceLink props={props} refId={game.photo.recordId} /></>;
  return <>
    <p>拖动拼块，或依次选择两个位置交换。已移动 {game.moves} 步。</p>
    {!src ? <p>拼图照片正在读取，或已从共同相册移除。</p> : <div className="play-photo-grid" style={{ gridTemplateColumns: `repeat(${game.size}, minmax(0, 1fr))` }}>
      {game.tiles.map((tile, index) => <button key={index} aria-pressed={active === index} disabled={props.disabled}
        aria-label={`拼块 ${tile + 1}，位置 ${index + 1}`}
        draggable={!props.disabled} onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault();
          const value = event.dataTransfer.getData("text/plain");
          if (!props.disabled && /^\d+$/.test(value) && Number(value) < game.tiles.length) swap(Number(value), index);
        }}
        style={{ backgroundImage: `url("${src}")`, backgroundSize: `${100 * game.size}%`,
          backgroundPosition: `${tile % game.size * 100 / (game.size - 1)}% ${Math.floor(tile / game.size) * 100 / (game.size - 1)}%` }}
        onClick={() => active === undefined ? setActive(index) : swap(active, index)} />)}
    </div>}
  </>;
}

function TileGame({ props, game }: { props: Props; game: Extract<MediaGame, { id: "g08" }> }) {
  const [start, select] = useState<number>();
  const [feedback, setFeedback] = useState("");
  const [hint, setHint] = useState<readonly [number, number] | null>(null);
  return <>
    <h3>{game.cleared === 24 ? "整盘都消掉了" : "找到相同的图案"}</h3>
    <p>同样图案之间的连线最多两次转弯，可以绕过棋盘边缘。{game.cleared} / 24 对 · 接力 {game.together} 次。</p>
    <div className="play-tiles">{game.tiles.map((value, index) => <button key={index} disabled={value === null || props.disabled}
      aria-pressed={start === index} data-hint={hint?.includes(index) || undefined}
      aria-label={`格子 ${index + 1}${value === null ? " 已消除" : " " + tileArt[value]}`}
      onClick={() => {
        setHint(null);
        if (start === undefined || game.tiles[start] === null || start === index) { select(index); return; }
        select(undefined);
        if (!connectTiles(game.tiles, start, index)) { setFeedback("这两个图案之间没有合适的连线。"); return; }
        setFeedback("");
        void props.submit({ type: "link.clear", a: start, b: index });
      }}>{value !== null ? tileArt[value] : ""}</button>)}</div>
    <div className="play-actions">
      {game.cleared < 24 && <button onClick={() => {
        const pair = pickPair(game.tiles);
        setHint(pair); setFeedback(pair ? "" : "棋盘需要重新摆放。");
      }}>提示一对</button>}
      {game.cleared < 24 && !pickPair(game.tiles) && <button disabled={props.disabled} onClick={() => void props.submit({ type: "link.shuffle" })}>重排剩余图案</button>}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  </>;
}

function DateRoom({ props, game }: { props: Props; game: Extract<MediaGame, { id: "g10" }> }) {
  const [file, setFile] = useState("");
  const [value, setValue] = useState("");
  const [precision, setPrecision] = useState<"year" | "month" | "date">("month");
  const author = game.author === props.seat;
  const available = options(props.shared.filter((entry) => entry.data.kind === "memory" && /^\d{4}(?:-\d{2}){1,2}$/.test(entry.data.date)));
  if (!game.photo) return author && !props.disabled ? <form className="play-fields" onSubmit={(event) => {
    event.preventDefault();
    const chosen = available.find((item) => item.fileId === file);
    if (!chosen) return;
    void props.client.sealAnswer(props.view.room, game.match, { text: chosen.entry.data.date }).then((hidden) =>
      props.submit({ type: "date.pick", photo: { recordId: chosen.recordId, fileId: chosen.fileId }, hidden })).catch(props.report);
  }}>
    <h3>选一张过去拍的共同照片</h3>
    {available.length ? <><label>题目照片<select value={file} onChange={(event) => setFile(event.target.value)} required>
      <option value="">请选择</option>{available.map((item) => <option key={item.fileId} value={item.fileId}>{item.name}</option>)}
    </select></label>
      <div className="play-actions"><button type="button" onClick={() =>
        setFile(available[crypto.getRandomValues(new Uint32Array(1))[0] % available.length].fileId)}>抽取一张</button>
        <button className="primary">把照片设为题目</button></div>
    </> : <p>需要一张有记录日期的共同照片。</p>}
  </form> : <p>等 {props.members[game.author]} 选一张照片。</p>;

  return <>
    <PlayPhoto service={props.service} photo={game.photo} label="待竞猜的照片" />
    {game.answer ? <>
      <h3>{game.answer.startsWith(game.guess!) ? "猜中了！" : "记忆里的那一天"}</h3>
      <p>你的猜测　{game.guess} · 回忆日期　{game.answer}</p>
      <ReferenceLink props={props} refId={game.photo.recordId} />
      <button disabled={props.disabled || game.match >= 12} onClick={() => void props.submit({ type: "date.next" })}>交换出题</button>
    </> : game.guess ? <>
      <p>已猜　{game.guess}</p>
      {author && game.hidden && !props.disabled ? <button onClick={() => {
        try {
          const answer = props.client.openAnswer(props.view.room, game.match, game.hidden!).text;
          void props.submit({ type: "date.reveal", answer });
        } catch (error) { props.report(error); }
      }}>揭晓日期</button> : <p>等出题者揭晓。</p>}
    </> : author ? <p>等对方猜日期。</p> : !props.disabled && <form className="play-fields" onSubmit={(event) => {
      event.preventDefault();
      void props.submit({ type: "date.guess", value });
    }}>
      <label>猜测精度<select value={precision} onChange={(event) => { setPrecision(event.target.value as typeof precision); setValue(""); }}>
        <option value="year">年份</option><option value="month">月份</option><option value="date">日期</option>
      </select></label>
      <label>猜是什么时候<input type={precision === "date" ? "date" : "text"} placeholder={precision === "year" ? "2024" : "2024-06"}
        inputMode={precision !== "date" ? "text" : undefined} maxLength={precision === "year" ? 4 : precision === "month" ? 7 : undefined}
        value={value} required onChange={(event) => setValue(event.target.value)} /></label>
      <button className="primary">提交日期猜测</button>
    </form>}
  </>;
}

export function GardenCard({ value, experience }: { value: BloomCard; experience?: number }) {
  const flower = flowers[value.seed];
  if (!flower) return null;
  return <article className="play-garden play-bloom-card" aria-label="花朵纪念卡">
    <span aria-hidden="true">{flower.symbol}</span>
    <h3>{flower.name} · 开花</h3>
    <p>{value.decoration || "你们的小花盆"} · 这株花照料了 {value.growth} 次</p>
    {experience !== undefined && <small>累计照料 {experience} 次</small>}
  </article>;
}

function GardenRoom({ props, game }: { props: Props; game: Extract<MediaGame, { id: "g14" }> }) {
  const [seed, setSeed] = useState(0);
  const bloom = gardenCard(game);
  return <>
    {bloom ? <GardenCard value={bloom} experience={game.experience} /> : <div className="play-garden">
      <span aria-hidden="true">{game.seed === null ? "🪴" : game.growth < 3 ? "🫘" : "🌱"}</span>
      <h3>{game.seed === null ? "准备播种" : flowers[game.seed].name + " · " + growthStage(game)}</h3>
      <p>{game.decoration || "你们的小花盆"} · 累计照料 {game.experience} 次</p>
    </div>}
    {game.seed === null ? <div className="play-fields">
      <label>选择花种<select value={seed} onChange={(event) => setSeed(Number(event.target.value))}>
        {flowers.map((flower, index) => <option key={flower.name} value={index} disabled={game.experience < flower.unlock}>
          {flower.name}{game.experience < flower.unlock ? ` · 照料 ${flower.unlock} 次解锁` : ""}</option>)}
      </select></label>
      <button disabled={props.disabled} onClick={() => void props.submit({ type: "garden.plant", seed })}>把种子种下</button>
    </div> : <>
      <div className="play-actions"><button disabled={props.disabled} onClick={() => void props.submit({ type: "garden.tend", action: "水" })}>浇水</button>
        <button disabled={props.disabled} onClick={() => void props.submit({ type: "garden.tend", action: "日照" })}>晒晒太阳</button>
        <label>花盆装饰<select value={game.decoration} disabled={props.disabled} onChange={(event) =>
          void props.submit({ type: "garden.decorate", value: event.target.value })}>
          {["", "条纹", "蝴蝶结", "晚安贴纸", "贝壳"].map((item) => <option key={item} value={item}>{item || "素面"}</option>)}
        </select></label>
        <button disabled={props.disabled} onClick={() => {
          if (window.confirm("结束这株花的培育？照料次数会保留。")) void props.submit({ type: "garden.reset" });
        }}>腾出花盆</button>
      </div>
      {game.actions.length > 0 && <details><summary>最近的照料</summary>
        <ul>{game.actions.slice().reverse().map(({ by, action }, index) =>
          <li key={index}>{props.members[by]} · {action === "水" ? "浇水" : "日照"}</li>)}</ul></details>}
    </>}
  </>;
}

function StarRoom({ props, game }: { props: Props; game: Stars }) {
  const [year, setYear] = useState("");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [photo, setPhoto] = useState("");
  const [selected, setSelected] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState(game.name);
  const [story, setStory] = useState(game.story);
  const all = useMemo(() => buildGalaxy(props.shared).filter((item) => item.photo.fileId), [props.shared]);
  const tags = useMemo(() => [...new Set(all.flatMap(({ memory }) => memory.data.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh-CN")), [all]);
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const available = all.filter((item) => (!year || item.year === year) && (!tag || item.memory.data.tags?.includes(tag)) &&
    (!needle || [item.memory.data.title, item.photo.name, ...(item.memory.data.tags ?? [])].some((text) => text.normalize("NFKC").toLowerCase().includes(needle))) &&
    !game.stars.some((star) => star.photo.fileId === item.photo.fileId));
  const visible = authorizedConstellation(game, props.shared);
  const star = visible.stars.find((item) => item.photo.fileId === selected);
  const candidate = available.find((item) => item.photo.fileId === photo);
  const move = (id: string, { x, y }: StarPosition, from: StarPosition) => void props.submit({ type: "stars.move", id,
    x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)), from: { x: from.x, y: from.y } });
  return <>
    <StarMap service={props.service} game={game} selected={selected} choose={setSelected} move={props.disabled ? undefined : move} />
    <p>{visible.stars.length} / 20 颗星。选择至少 3 颗并命名，便可收藏。</p>
    {visible.stars.length > 0 && <div className="play-fields"><label>选中星点<select aria-label="选中星点"
      value={star?.photo.fileId ?? ""} onChange={(event) => setSelected(event.target.value)}>
      <option value="">请选择星点</option>
      {visible.stars.map(({ photo }, index) => {
        const entry = all.find((item) => item.photo.fileId === photo.fileId);
        return <option key={photo.fileId} value={photo.fileId}>第 {index + 1} 颗星{entry ? ` · ${entry.photo.name}` : ""}</option>;
      })}
    </select></label></div>}
    {!props.disabled && game.stars.length > visible.stars.length && <div className="play-actions">
      {game.stars.map(({ photo }, index) => !visible.stars.some((item) => item.photo.fileId === photo.fileId) &&
        <button key={photo.fileId} onClick={() => void props.submit({ type: "stars.remove", id: photo.fileId })}>移除第 {index + 1} 个失效星点</button>)}
    </div>}
    {star && <div className="play-fields">
      <ReferenceLink props={props} refId={star.photo.recordId} />
      {!props.disabled && <>
        <div className="play-actions">
          <button onClick={() => move(selected, { x: star.x - 5, y: star.y }, star)}>向左</button><button onClick={() => move(selected, { x: star.x + 5, y: star.y }, star)}>向右</button>
          <button onClick={() => move(selected, { x: star.x, y: star.y - 5 }, star)}>向上</button><button onClick={() => move(selected, { x: star.x, y: star.y + 5 }, star)}>向下</button>
          <button onClick={() => void props.submit({ type: "stars.remove", id: selected })}>移除星点</button>
        </div>
        <label>连向另一颗星<select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">选择目标星</option>
          {visible.stars.flatMap((item, index) => item.photo.fileId !== selected
            ? [<option value={item.photo.fileId} key={item.photo.fileId}>第 {index + 1} 颗星</option>] : [])}
        </select></label>
        <button disabled={!target || target === selected} onClick={() => void props.submit({ type: "stars.link", from: selected, to: target })}>切换两星连线</button>
      </>}
    </div>}
    {!props.disabled && <div className="play-fields">
      <div className="play-fields play-split"><label>年份<select aria-label="年份" value={year} onChange={(event) => setYear(event.target.value)}>
        <option value="">所有年份</option>{[...new Set(all.map((item) => item.year))].map((value) => <option key={value}>{value}</option>)}
      </select></label><label>标签<select aria-label="标签" value={tag} onChange={(event) => setTag(event.target.value)}>
        <option value="">全部标签</option>{tags.map((value) => <option key={value}>{value}</option>)}
      </select></label></div>
      <label>搜索照片或标签<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label>从银河选星<select value={candidate?.photo.fileId ?? ""} onChange={(event) => setPhoto(event.target.value)}>
        <option value="">选择照片星</option>{available.map((item) => <option key={item.id} value={item.photo.fileId}>{item.memory.data.title} · {item.photo.name}</option>)}
      </select></label>
      <button disabled={!candidate || game.stars.length >= 20} onClick={() => {
        if (candidate) void props.submit({ type: "stars.add", star: { x: candidate.x, y: candidate.y,
          photo: { recordId: candidate.memory.id, fileId: candidate.photo.fileId! } } }).then((saved) => { if (saved) setPhoto(""); });
      }}>摘下这颗星</button>
      <label>星座名称<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <label>星座故事<textarea value={story} maxLength={1000} onChange={(event) => setStory(event.target.value)} /></label>
      <button disabled={!name.trim()} onClick={() => void props.submit({ type: "stars.story", name, story })}>保存星座名称与故事</button>
    </div>}
  </>;
}

export function SongCards({ service, value }: { service: UsService; value: Music }) {
  return <div className="play-pair">{value.cards.flatMap((card, index) => card ? [<article key={index}>
    <h3>{card.track}</h3><p>{card.artist}</p>
    {card.photos.map((photo) => <PlayPhoto key={photo.fileId} service={service} photo={photo} label="明信片配图" />)}
    <p>{card.note}</p>
    {card.link && <button onClick={() => {
      const external = officialMusicLink(card.link);
      if (window.confirm(`即将打开 ${new URL(external).hostname}。继续？`)) window.open(external, "_blank", "noopener,noreferrer");
    }}>打开曲目 · {new URL(officialMusicLink(card.link)).hostname}</button>}
  </article>] : [])}</div>;
}

function MusicRoom({ props, game }: { props: Props; game: Music }) {
  const own = game.cards[props.seat];
  const [track, setTrack] = useState(own?.track ?? "");
  const [artist, setArtist] = useState(own?.artist ?? "");
  const [link, setLink] = useState(own?.link ?? "");
  const [note, setNote] = useState(own?.note ?? "");
  const [files, select] = useState(own?.photos.map(({ fileId }) => fileId) ?? []);
  const photos = options(props.shared.filter(({ data }) => data.kind === "memory"));
  return <>
    <SongCards service={props.service} value={game} />
    {!props.disabled && <form className="play-fields" onSubmit={(event) => {
      event.preventDefault();
      void props.submit({ type: "music.put", value: { track, artist, link, note,
        photos: photos.filter(({ fileId }) => files.includes(fileId)).map(({ recordId, fileId }) => ({ recordId, fileId })) } });
    }}>
      <label>歌曲名<input required maxLength={100} value={track} onChange={(event) => setTrack(event.target.value)} /></label>
      <label>演唱者<input required maxLength={100} value={artist} onChange={(event) => setArtist(event.target.value)} /></label>
      <label>官方曲目链接<input type="url" maxLength={512} value={link} onChange={(event) => setLink(event.target.value)} placeholder="可留空" /></label>
      <label>为什么推荐<textarea maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {!!photos.length && <label>明信片配图（最多三张）<select multiple value={files} onChange={(event) =>
        select(Array.from(event.target.selectedOptions).map(({ value }) => value).slice(0, 3))}>
        {photos.map(({ fileId, name }) => <option key={fileId} value={fileId}>{name}</option>)}
      </select></label>}
      <button className="primary">保存我的音乐卡片</button>
    </form>}
  </>;
}

export function SkyCards({ service, value }: { service: UsService; value: Sky }) {
  return <div className="play-sky" data-layout={value.layout}>
    {value.cards.map((card, index) => card ? <figure key={index}>
      <PlayPhoto service={service} photo={card.photo} label="一边的天空" />
      {(card.city || card.note) && <figcaption>{[card.city, card.note].filter(Boolean).join(" · ")}</figcaption>}
    </figure> : <p key={index}>等待这边的天空</p>)}
  </div>;
}

function SkyRoom({ props, game }: { props: Props; game: Sky }) {
  const existing = game.cards[props.seat];
  const [file, setFile] = useState<File>();
  const [city, setCity] = useState(existing?.city ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<{ file: File; reference: PhotoReference }>();
  async function send(event: FormEvent) {
    event.preventDefault();
    if (uploading) return;
    setUploading(true);
    try {
      let reference: PhotoReference | undefined = existing?.photo;
      if (file) {
        if (file === uploaded?.file) reference = uploaded.reference;
        else {
          const blob = await prepareBrowserPhoto(file);
          const photo = await props.service.addPhoto(new Uint8Array(await blob.arrayBuffer()), blob.type, "天空照片", "shared", () => {});
          if (!photo.fileId) throw new AppError("UPLOAD_FAILED", "照片尚未上传完成");
          const entry = await props.service.save({ kind: "play-media", title: "天空照片", date: props.service.day,
            playMediaRoomId: props.view.room.id, photos: [photo] }, "shared");
          reference = { recordId: entry.id, fileId: photo.fileId };
          setUploaded({ file, reference });
        }
      }
      if (reference && await props.submit({ type: "sky.put", previous: skyCardFingerprint(existing),
        value: { photo: reference, note, city } })) setFile(undefined);
    } catch (error) { props.report(error); }
    finally { setUploading(false); }
  }
  return <>
    <SkyCards service={props.service} value={game} />
    {!props.disabled && <form className="play-fields" onSubmit={send}>
      <label>拼贴样式<select value={game.layout} onChange={(event) => void props.submit({ type: "sky.layout", layout: event.target.value as Sky["layout"] })}>
        <option value="side">左右两张</option><option value="stack">上下拼贴</option><option value="round">圆窗</option>
      </select></label>
      <label>我拍的天空<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0])} /></label>
      <p>照片会去除拍摄元数据，作为房间素材加密保存。城市可以留空。</p>
      <label>城市<input maxLength={60} value={city} onChange={(event) => setCity(event.target.value)} /></label>
      <label>留一句话<input maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <button className="primary" disabled={uploading || (!file && !existing)}>{uploading ? "正在加密并提交…" : "交给对方看"}</button>
    </form>}
  </>;
}

export function MediaRoom(props: Props) {
  const { game } = props;
  switch (game.id) {
    case "g02": return <PhotoPuzzle props={props} game={game} />;
    case "g08": return <TileGame props={props} game={game} />;
    case "g10": return <DateRoom key={game.match} props={props} game={game} />;
    case "g14": return <GardenRoom props={props} game={game} />;
    case "c18": return <StarRoom props={props} game={game} />;
    case "c20": return <MusicRoom props={props} game={game} />;
    case "c21": return <SkyRoom props={props} game={game} />;
    case "w24": return <MemoryTreeEditor service={props.service} game={game} disabled={props.disabled}
      submit={props.submit} openMemory={props.openMemory} report={props.report} reduceMotion={props.reduceMotion} />;
  }
}
