import { AppError, type Secrets } from "../../../src/core/types";
import { type OperationReceipt, type PlayOperation, type Seat } from "../../../src/features/play-core/protocol";
import { signPlaySocket, type CanvasRelay, type SocketEvent } from "../../../src/features/play-core/realtime";

export function connectRoomSocket(
  roomId: string, secrets: Secrets, current: () => boolean,
  callbacks: { ready: (ready: boolean) => void; presence: (seats: Seat[]) => void; changed: () => void;
    error: (error: AppError) => void; preview: (value: CanvasRelay) => void },
) {
  const url = new URL("/ws/play", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomId);
  let socket: WebSocket | undefined;
  let verified = false;
  let stopped = false;
  let reconnect = 500;
  let timer: number | undefined;
  let inflight: { id: string; accept: (result: OperationReceipt) => void; fail: (error: AppError) => void; timer: number } | undefined;

  function disconnected() {
    verified = false;
    callbacks.ready(false);
    callbacks.presence([]);
    if (inflight) {
      window.clearTimeout(inflight.timer);
      inflight.fail(new AppError("NETWORK_ERROR", "实时连接中断，操作待确认"));
      inflight = undefined;
    }
  }

  function connect() {
    if (stopped || !current()) return;
    const ws = socket = new WebSocket(url);
    ws.onmessage = ({ data }) => {
      if (socket !== ws || stopped || !current() || typeof data !== "string") return;
      let event: SocketEvent;
      try { event = JSON.parse(data) as SocketEvent; } catch { ws.close(); return; }
      switch (event.type) {
        case "challenge":
          if (verified || typeof event.nonce !== "string" || !/^[a-f0-9]{64}$/.test(event.nonce)) { ws.close(); return; }
          ws.send(JSON.stringify({ type: "room.join", signature: signPlaySocket({
            spaceId: secrets.spaceId, deviceId: secrets.deviceId, roomId, nonce: event.nonce,
          }, secrets.signingSecret) }));
          break;
        case "room.joined":
          verified = true;
          reconnect = 500;
          callbacks.ready(true);
          callbacks.changed();
          break;
        case "room.presence":
          if (verified) callbacks.presence(event.seats);
          break;
        case "room.changed":
          if (verified) callbacks.changed();
          break;
        case "canvas.preview":
          if (verified) callbacks.preview(event.preview);
          break;
        case "op.ack":
        case "error": {
          const error = event.type === "error" ? new AppError(event.code, event.message) : null;
          const pending = inflight;
          if (pending && event.opId === pending.id) {
            window.clearTimeout(pending.timer);
            inflight = undefined;
            if (event.type === "op.ack") pending.accept(event.receipt);
            else pending.fail(error!);
          } else if (error) callbacks.error(error);
          break;
        }
      }
    };
    ws.onclose = ({ code }) => {
      if (socket !== ws || stopped) return;
      disconnected();
      if (code === 1008) { callbacks.changed(); return; }
      timer = window.setTimeout(connect, reconnect);
      reconnect = Math.min(reconnect * 2, 10000);
    };
  }

  connect();
  return {
    ready: () => verified && socket?.readyState === WebSocket.OPEN,
    preview(value: CanvasRelay) {
      if (verified && socket?.readyState === WebSocket.OPEN && current() && socket.bufferedAmount < 20000)
        socket.send(JSON.stringify({ type: "canvas.preview", preview: value }));
    },
    send(operation: PlayOperation) {
      return new Promise<OperationReceipt>((accept, fail) => {
        const ws = socket;
        if (!verified || ws?.readyState !== WebSocket.OPEN || inflight || !current()) {
          fail(new AppError("NETWORK_ERROR", "实时连接尚未就绪"));
          return;
        }
        const timer = window.setTimeout(() => {
          if (inflight?.id === operation.header.opId) inflight = undefined;
          fail(new AppError("TIMEOUT", "尚未收到实时同步回执"));
          ws.close();
        }, 6000);
        inflight = { id: operation.header.opId, accept, fail, timer };
        try { ws.send(JSON.stringify({ type: "op.submit", operation })); }
        catch { disconnected(); ws.close(); }
      });
    },
    close() {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      disconnected();
      socket?.close();
    },
  };
}
