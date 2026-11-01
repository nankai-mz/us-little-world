// WeChat does not consistently expose TextEncoder/TextDecoder. Bundled locally.
import "fast-text-encoding";
if (typeof globalThis.structuredClone !== "function")
  globalThis.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
