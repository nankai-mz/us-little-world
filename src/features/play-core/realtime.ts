import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { b64, unb64 } from "../../core/crypto";
import type { Envelope } from "../../core/types";
import type { Seat, OperationReceipt, PlayOperation } from "./protocol";

export type CanvasRelay = {
  id: string; roomId: string; spaceId: string; deviceId: string; keyVersion: number; actor: Seat; envelope: Envelope;
};

type SocketProof = { spaceId: string; deviceId: string; roomId: string; nonce: string };
const encoded = (proof: SocketProof) => utf8ToBytes(JSON.stringify([
  "Us/play/ws/v1", proof.spaceId, proof.deviceId, proof.roomId, proof.nonce,
]));

export function signPlaySocket(proof: SocketProof, secret: string) {
  const key = unb64(secret);
  try { return b64(ed25519.sign(encoded(proof), key)); }
  finally { key.fill(0); }
}

export function verifyPlaySocket(proof: SocketProof, signature: unknown, publicKey: string) {
  if (typeof signature !== "string" || !/^[a-zA-Z0-9+/]{86}==$/.test(signature)) return false;
  try { return ed25519.verify(unb64(signature), encoded(proof), unb64(publicKey), { zip215: false }); }
  catch { return false; }
}

export type SocketEvent =
  | { type: "challenge"; nonce: string }
  | { type: "room.joined"; seat: Seat }
  | { type: "room.presence"; seats: Seat[] }
  | { type: "room.changed"; receipt?: OperationReceipt; operation?: PlayOperation }
  | { type: "canvas.preview"; preview: CanvasRelay }
  | { type: "op.ack"; opId: string; receipt: OperationReceipt }
  | { type: "error"; code: string; message: string; opId?: string };
