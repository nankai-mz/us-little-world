// Older WeChat base libraries may not expose globalThis. Resolve the global
// object before any dependency reads it, then expose it under the standard name.
export const root: any =
  typeof globalThis !== "undefined"
    ? globalThis
    : Function("return this")();
if (typeof root.globalThis === "undefined") root.globalThis = root;
