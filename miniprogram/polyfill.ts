// Must run before fast-text-encoding: it reads globalThis at module load.
import { root } from "./bootstrap";
import "fast-text-encoding";
if (typeof Object.hasOwn !== "function") {
  (Object as any).hasOwn = (obj: any, prop: PropertyKey): boolean =>
    Object.prototype.hasOwnProperty.call(obj, prop);
}
if (typeof root.structuredClone !== "function")
  root.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
