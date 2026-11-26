import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { AppError } from "../../core/types";
import { playActions, playIdPattern, type OperationReceipt, type PlayOperation, type Seat } from "../../features/play-core/protocol";
import type { CanvasRelay, SocketEvent } from "../../features/play-core/realtime";
import type { createPlayApi } from "../activities/api";
import type { PlayActor } from "../activities/rooms";
import { cipher, counter, object, playId } from "../activities/validation";

type Connection = { actor: PlayActor; valid: () => boolean };
type Peer = Connection & { roomId: string; socket: WebSocket; seat?: Seat; alive: boolean; processing: boolean;
  lastPreviewAt: number; messages: number; windowEnds: number };

function reject(socket: Duplex, status: "401 Unauthorized" | "403 Forbidden" | "404 Not Found" | "429 Too Many Requests") {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachPlayGateway(
  server: Server, origin: string, api: ReturnType<typeof createPlayApi>,
  authenticate: (request: IncomingMessage) => Connection | null,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false, autoPong: false });
  const peers = new Set<Peer>();

  function send(peer: Peer, event: SocketEvent) {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 256 * 1024) {
      peer.socket.terminate();
      return;
    }
    peer.socket.send(JSON.stringify(event), (error) => { if (error) peer.socket.terminate(); });
  }

  async function authorizedPeers(roomId: string) {
    const authorized = await Promise.all([...peers].filter((peer) => peer.roomId === roomId && peer.seat !== undefined)
      .map(async (peer) => {
        try {
          await api.authorizeSocket(peer.actor, roomId, peer.valid);
          return peer;
        } catch {
          peer.socket.close(1008, "Room authorization ended");
          return null;
        }
      }));
    return authorized.filter((peer): peer is Peer => !!peer && peer.valid() && peers.has(peer));
  }

  async function presence(roomId: string) {
    const authorized = await authorizedPeers(roomId);
    const seats = [...new Set(authorized.map(({ seat }) => seat!))].sort();
    for (const peer of authorized) send(peer, { type: "room.presence", seats });
  }

  async function changed(roomId: string, receipt?: OperationReceipt, operation?: PlayOperation) {
    for (const peer of await authorizedPeers(roomId)) {
      const relay = peer.actor.deviceId === operation?.header.deviceId ? undefined : operation;
      send(peer, { type: "room.changed", receipt, operation: relay });
    }
  }

  async function relayPreview(peer: Peer, raw: unknown) {
    const now = Date.now();
    if (peer.seat === undefined || now - peer.lastPreviewAt < 55) return;
    peer.lastPreviewAt = now;
    const data = object(raw);
    const keyVersion = counter(data.keyVersion);
    const candidate: CanvasRelay = { id: playId(data.id), keyVersion,
      roomId: peer.roomId, spaceId: peer.actor.spaceId, deviceId: peer.actor.deviceId, actor: peer.seat,
      envelope: cipher(data.envelope, keyVersion, 12000) };
    await api.authorizeSocket(peer.actor, peer.roomId, peer.valid, undefined, keyVersion);
    for (const other of await authorizedPeers(peer.roomId)) {
      if (other.seat !== peer.seat) send(other, { type: "canvas.preview", preview: candidate });
    }
  }

  server.on("upgrade", (request, socket, head) => {
    const match = /^\/ws\/play\?room=([a-f0-9]{32})$/.exec(request.url ?? "");
    if (!api.realtime || !match) return reject(socket, "404 Not Found");
    if (request.headers.origin !== origin) return reject(socket, "403 Forbidden");
    const connection = authenticate(request);
    if (!connection?.valid()) return reject(socket, "401 Unauthorized");
    if (peers.size >= 16 || [...peers].filter((peer) => peer.actor.accountId === connection.actor.accountId).length >= 6)
      return reject(socket, "429 Too Many Requests");
    wss.handleUpgrade(request, socket, head, (ws) => {
      const roomId = match[1];
      const peer: Peer = { ...connection, roomId, socket: ws, alive: true, processing: false, lastPreviewAt: 0,
        messages: 0, windowEnds: Date.now() + 1000 };
      const nonce = randomBytes(32).toString("hex");
      const deadline = setTimeout(() => ws.close(1008, "Device verification timed out"), 5000);
      peers.add(peer);
      ws.on("error", () => ws.terminate());
      ws.on("pong", () => { peer.alive = true; });
      ws.on("close", () => {
        clearTimeout(deadline);
        peers.delete(peer);
        if (peer.seat !== undefined) void presence(roomId);
      });
      ws.on("message", async (raw, binary) => {
        // A client sends one request at a time and waits for its acknowledgement.
        if (ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now >= peer.windowEnds) { peer.messages = 0; peer.windowEnds = now + 1000; }
        if (++peer.messages > 80 || binary || !peer.valid()) { ws.close(1008, "Invalid room message"); return; }
        let message: Record<string, unknown>;
        try { message = object(JSON.parse(raw.toString())); }
        catch { ws.close(1008, "Invalid room message"); return; }
        if (message.type === "canvas.preview") {
          if (peer.seat === undefined) { ws.close(1008, "Device verification required"); return; }
          void relayPreview(peer, message.preview).catch(() => {});
          return;
        }
        if (peer.processing) { ws.close(1008, "Invalid room message"); return; }
        peer.processing = true;
        let opId: string | undefined;
        try {
          if (peer.seat === undefined) {
            if (message.type !== "room.join") { ws.close(1008, "Device verification required"); return; }
            peer.seat = await api.authorizeSocket(peer.actor, roomId, peer.valid, { nonce, signature: message.signature });
            clearTimeout(deadline);
            send(peer, { type: "room.joined", seat: peer.seat });
            void presence(roomId);
          } else if (message.type === "op.submit") {
            const operation = object(message.operation) as unknown as PlayOperation;
            if (typeof operation.header?.opId === "string" && playIdPattern.test(operation.header.opId)) opId = operation.header.opId;
            const result = await api.call(peer.actor, playActions.submit, { roomId,
              header: operation.header, envelope: operation.envelope }, peer.valid);
            if (!result.success) {
              const code = result.error?.code ?? "INTERNAL_ERROR";
              send(peer, { type: "error", code, message: result.error?.message ?? "暂时无法同步活动", opId });
              if (["DEVICE_REVOKED", "MEMBER_REQUIRED", "AUTH_REQUIRED", "KEY_VERSION_CHANGED", "ROOM_UNAVAILABLE"].includes(code))
                ws.close(1008, "Room authorization ended");
              return;
            }
            const { sequence, revision, operation: stored } = result.data as OperationReceipt & { operation?: PlayOperation };
            const receipt = { sequence, revision };
            send(peer, { type: "op.ack", opId: opId!, receipt });
            if (stored) void changed(roomId, receipt, stored);
          } else {
            ws.close(1008, "Unknown room message");
          }
        } catch (error) {
          const code = error instanceof AppError ? error.code : "INVALID_REQUEST";
          send(peer, { type: "error", code, message: "实时房间请求未通过校验", opId });
          ws.close(1008, "Invalid room message");
        } finally { peer.processing = false; }
      });
      send(peer, { type: "challenge", nonce });
    });
  });

  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive || !peer.valid()) { peer.socket.terminate(); continue; }
      peer.alive = false;
      if (peer.socket.readyState === WebSocket.OPEN) peer.socket.ping();
    }
    for (const roomId of new Set([...peers].map(({ roomId }) => roomId))) void presence(roomId);
  }, 10000);
  heartbeat.unref();
  return {
    changed,
    close() {
      clearInterval(heartbeat);
      for (const peer of peers) peer.socket.terminate();
      wss.close();
    },
  };
}
