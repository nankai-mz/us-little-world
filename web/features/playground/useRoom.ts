import { useCallback, useEffect, useRef, useState } from "react";
import { AppError } from "../../../src/core/types";
import { playActions, type PlayOperation, type Seat } from "../../../src/features/play-core/protocol";
import { canRebase, type GameCommand } from "../../../src/features/play-core/game";
import type { StrokePreview } from "../../../src/features/canvas-core/canvas";
import { isRetryablePlayError, type PlayClient, type RoomView } from "./client";

export const playError = (error: unknown) => error instanceof Error ? error.message : "活动暂时不可用";

export function useRoom(client: PlayClient, id: string) {
  const [view, setView] = useState<RoomView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const [presence, setPresence] = useState<Seat[]>([]);
  const [preview, setPreview] = useState<StrokePreview | null>(null);
  const [pending, setPending] = useState<PlayOperation | null>(() => {
    try { return client.pending(id); }
    catch { return null; }
  });
  const current = useRef<RoomView>(undefined);
  const operation = useRef(pending);
  const retryOnPoll = useRef(false);
  const request = useRef<Promise<RoomView> | null>(null);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const socket = useRef<ReturnType<PlayClient["socket"]> | null>(null);
  const lastPreview = useRef(0);
  const previewGeneration = useRef(0);
  const updatePending = useCallback((next: PlayOperation | null) => {
    client.storePending(id, next);
    operation.current = next;
    if (!next) retryOnPoll.current = false;
    if (mounted.current) setPending(next);
  }, [client, id]);

  const load = useCallback(function refresh(fresh = false): Promise<RoomView> {
    if (request.current) return fresh ? request.current.catch(() => {}).then(() => refresh()) : request.current;
    request.current = client.readRoom(id, current.current).then((value) => {
      current.current = value;
      if (mounted.current) {
        setView(value);
        setConnected(true);
      }
      return value;
    }).catch((failure) => {
      if (mounted.current) {
        setConnected(false);
        if (failure instanceof AppError && ["ROOM_UNAVAILABLE", "MEMBER_REQUIRED", "DEVICE_REVOKED",
          "DEVICE_UNBOUND", "AUTH_REQUIRED", "LOCKED", "FEATURE_DISABLED", "DECRYPT_FAILED"].includes(failure.code)) {
          current.current = undefined;
          setView(undefined);
        }
      }
      throw failure;
    }).finally(() => { request.current = null; });
    return request.current;
  }, [client, id]);

  const report = useCallback((failure: unknown) => {
    if (mounted.current) setError(playError(failure));
  }, []);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    setError("");
    try { await task(); return true; }
    catch (failure) { report(failure); return false; }
    finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [report]);

  const send = useCallback(async (item: PlayOperation, rebase: boolean) => {
    retryOnPoll.current = false;
    let candidate = item;
    for (let attempt = 0; ; attempt++) {
      try {
        if (socket.current?.ready()) await socket.current.send(candidate);
        else await client.send(candidate);
        updatePending(null);
        break;
      } catch (failure) {
        if (!(failure instanceof AppError && failure.code === "REVISION_CONFLICT") || !rebase) {
          retryOnPoll.current = isRetryablePlayError(failure);
          throw failure;
        }
        if (attempt >= 2) {
          // Concurrent writing can consume this burst of retries before the other peer finishes.
          retryOnPoll.current = true;
          throw failure;
        }
        const latest = await load(true).catch((error) => {
          retryOnPoll.current = isRetryablePlayError(error);
          throw error;
        });
        candidate = await client.rebase(latest, item);
        updatePending(candidate);
      }
    }
    try { await load(true); } catch (failure) { report(failure); }
  }, [client, load, report, updatePending]);

  useEffect(() => {
    mounted.current = true;
    const poll = () => {
      if (document.hidden || mutating.current) return;
      const queued = operation.current;
      if (queued && retryOnPoll.current && navigator.onLine) void run(() => send(queued, true));
      else void load().catch(report);
    };
    const reconnect = () => {
      if (operation.current) void run(() => send(operation.current!, true));
      else poll();
    };
    reconnect();
    const timer = window.setInterval(poll, 2500);
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", poll);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [load, report, run, send]);

  const liveRoom = view?.room.mode === "realtime" && view.room.status !== "completed" && client.canWrite(view.room);
  useEffect(() => {
    if (!liveRoom || typeof WebSocket !== "function") return;
    let previewTimer: number | undefined;
    socket.current = client.socket(id, {
      ready: (ready) => {
        if (!mounted.current) return;
        setRealtime(ready);
        if (!ready) setPreview(null);
        if (ready && operation.current) void run(() => send(operation.current!, true));
      },
      presence: (seats) => {
        setPresence(seats);
        if (seats.length < 2) setPreview(null);
      },
      changed: () => { if (!mutating.current) void load(true).catch(report); },
      error: report,
      preview: (data) => {
        if (!current.current || current.current.room.status !== "active") return;
        try {
          setPreview(client.openPreview(current.current.room, data));
          window.clearTimeout(previewTimer);
          previewTimer = window.setTimeout(() => setPreview(null), 900);
        } catch { /* A damaged or stale preview expires without changing the committed room. */ }
      },
    });
    return () => { socket.current?.close(); socket.current = null; window.clearTimeout(previewTimer); };
  }, [client, id, liveRoom, load, report, run, send]);

  const roomSeq = view?.through ?? 0;
  const roomCheckpoint = view?.room.snapshotThrough ?? 0;
  useEffect(() => {
    if (roomSeq - roomCheckpoint < 200) return;
    let checking = false;
    const check = () => {
      if (checking || mutating.current || !current.current || document.hidden) return;
      checking = true;
      void client.checkpoint(current.current).catch((error) => {
        if (error instanceof AppError && error.code === "CHECKPOINT_MISMATCH") report(error);
      }).finally(() => { checking = false; });
    };
    const first = window.setTimeout(check, 650);
    const recurring = window.setInterval(check, 15000);
    return () => { window.clearTimeout(first); window.clearInterval(recurring); };
  }, [client, report, roomSeq, roomCheckpoint]);

  return {
    view, error, busy, connected, realtime, presence, preview, pending, run, report,
    sendPreview: (data: StrokePreview | null) => {
      if (!socket.current?.ready() || !current.current || current.current.room.status !== "active") return;
      if (data && Date.now() - lastPreview.current < 85) return;
      if (data) lastPreview.current = Date.now();
      const target = socket.current;
      const generation = ++previewGeneration.current;
      void client.preview(current.current.room, data).then((payload) => {
        if (generation === previewGeneration.current && target === socket.current && current.current?.room.status === "active") {
          target.preview(payload);
        }
      }).catch(() => {});
    },
    refresh: () => run(async () => { await load(true); }),
    submit: (command: GameCommand) => run(async () => {
      if (!current.current || operation.current) throw new AppError("PENDING", "请先处理待确认的操作");
      const item = await client.prepare(current.current, command);
      updatePending(item);
      const mayRebase = canRebase(current.current.game, command);
      await send(item, mayRebase);
    }),
    retry: () => run(async () => { if (operation.current) await send(operation.current, true); }),
    discard: () => run(async () => { updatePending(null); await load(true); }),
    lifecycle: (action: typeof playActions.join | typeof playActions.close | typeof playActions.pause |
      typeof playActions.resume | typeof playActions.extend | typeof playActions.useAsync | typeof playActions.approveArchive |
      typeof playActions.approveCleanup | typeof playActions.keepRoom) => run(async () => {
      if (!current.current || operation.current) throw new AppError("PENDING", "请先处理待确认的操作");
      const { revision, lastSeq } = current.current.room;
      await client.call(action, { roomId: id, expectedRevision: revision, expectedSequence: lastSeq });
      await load(true);
    }),
  };
}
