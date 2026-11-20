import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { b64, fromHex, hashText, unb64 } from "./crypto";

export type WebDevice = {
  spaceId: string;
  id: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  label: string;
  sharedOnly?: true;
};

type RecoverySource = { deviceId: string; signingSecret: string };

export type WebDeviceProof = {
  nonce: string;
  signature: string;
  recoveryPublicKey?: string;
  recoverySignature?: string;
  sourceId?: string;
  sourceSignature?: string;
};

export const webRecoveryKeys = "web_recovery_keys";

function enrollmentMessage(device: WebDevice, proof: Omit<WebDeviceProof, "signature">) {
  return utf8ToBytes(JSON.stringify([
    "Us/web/device-enrollment/1", proof.nonce, device.spaceId, device.id,
    device.encryptionPublicKey, device.signingPublicKey, device.label,
    device.sharedOnly === true, proof.recoveryPublicKey ?? null, proof.sourceId ?? null,
  ]));
}

export function signWebDevice(
  device: WebDevice,
  nonce: string,
  signingSecret: string,
  recovery?: { userId: string; key: string },
  source?: RecoverySource,
): WebDeviceProof {
  const recoverySeed = recovery ? fromHex(hashText(JSON.stringify([
    "Us/web/recovery-key/1", recovery.userId, device.spaceId,
    recovery.key.replace(/\s/g, "").toLowerCase(),
  ]))) : undefined;
  try {
    const recoveryPublicKey = recoverySeed && b64(ed25519.getPublicKey(recoverySeed));
    const fields = { nonce, recoveryPublicKey, sourceId: source?.deviceId };
    const message = enrollmentMessage(device, fields);
    return {
      ...fields,
      signature: b64(ed25519.sign(message, unb64(signingSecret))),
      ...(recoverySeed ? { recoverySignature: b64(ed25519.sign(message, recoverySeed)) } : {}),
      ...(source ? { sourceSignature: b64(ed25519.sign(message, unb64(source.signingSecret))) } : {}),
    };
  } finally {
    recoverySeed?.fill(0);
  }
}

export function verifyWebDeviceSignature(
  device: WebDevice, proof: WebDeviceProof, key: unknown, signature: unknown,
) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
    return false;
  try {
    return ed25519.verify(unb64(signature), enrollmentMessage(device, proof), unb64(key), { zip215: false });
  } catch {
    return false;
  }
}
