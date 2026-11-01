import { AppError, type ApiReply, type Transport } from "./types";
const READ_ACTIONS = new Set([
  "health",
  "bootstrap",
  "getSpace",
  "listRecords",
  "listDevices",
  "getTransfers",
  "fileGet",
]);
export function createTransport(
  invoke: (action: string, data: Record<string, unknown>) => Promise<unknown>,
  options: { timeoutMs?: number; retries?: number } = {},
): Transport {
  return {
    async call<T>(action: string, data = {}): Promise<T> {
      const attempts = READ_ACTIONS.has(action)
        ? 1 + (options.retries ?? 1)
        : 1;
      const timeoutMs =
        options.timeoutMs ?? (action === "aiGenerate" ? 35000 : 15000);
      for (let attempt = 0; attempt < attempts; attempt++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let raw: unknown;
        try {
          raw = await Promise.race([
            invoke(action, data),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new AppError(
                      "TIMEOUT",
                      READ_ACTIONS.has(action)
                        ? "连接超时，请稍后刷新"
                        : "操作结果尚未确认，请联网刷新后查看，避免重复提交",
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]);
        } catch (error) {
          if (
            attempt + 1 < attempts &&
            (!(error instanceof AppError) ||
              ["NETWORK_ERROR", "TIMEOUT"].includes(error.code))
          )
            continue;
          if (error instanceof AppError) throw error;
          throw new AppError(
            "NETWORK_ERROR",
            READ_ACTIONS.has(action)
              ? "网络暂时不可用，请检查连接后刷新"
              : "网络中断，操作结果尚未确认；请联网刷新后查看，避免重复提交",
          );
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        const reply = raw as ApiReply<T>;
        if (!reply || typeof reply.success !== "boolean")
          throw new AppError(
            "INVALID_RESPONSE",
            "云端返回格式不正确，请检查云函数版本",
          );
        if (!reply.success)
          throw new AppError(
            reply.error?.code || "SERVER_ERROR",
            reply.error?.message || "服务暂时不可用",
          );
        return reply.data as T;
      }
      throw new AppError("NETWORK_ERROR", "网络暂时不可用");
    },
  };
}
