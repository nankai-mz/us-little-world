import { useState } from "react";
import type { Entry } from "../src/core/types";

export function ExternalMap({ entries }: { entries: Entry[] }) {
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState("");
  const places = entries.flatMap((entry) => {
    const { latitude, longitude, title, kind } = entry.data;
    return entry.visibility === "shared" && !entry.deletedAt && kind === "place" &&
      latitude !== undefined && Math.abs(latitude) <= 90 && longitude !== undefined && Math.abs(longitude) <= 180
      ? [{ id: entry.id, title, coordinates: `${longitude},${latitude}` }] : [];
  });
  if (!places.length) return null;
  const place = places.find(({ id }) => id === selected);
  return <section className="map-privacy" aria-label="外部地图">
    <button type="button" className="secondary" aria-expanded={show} onClick={() => {
      setShow(!show);
      setSelected("");
    }}>{show ? "关闭地图选项" : "查看外部地图选项"}</button>
    {show && <>
      <label>选择共同足迹 <select value={place?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
        <option value="">请选择</option>
        {places.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      {place && <>
        <p>继续后将向高德地图提供以下经纬度。地图在新标签页打开。</p>
        <output aria-label="将发送的经纬度">{place.coordinates}</output>
        <a className="secondary" target="_blank" rel="noopener noreferrer"
          href={`https://uri.amap.com/marker?${new URLSearchParams({ position: place.coordinates })}`}>
          确认坐标并打开高德地图
        </a>
        <button type="button" className="secondary" onClick={() => setSelected("")}>取消打开地图</button>
      </>}
    </>}
  </section>;
}
