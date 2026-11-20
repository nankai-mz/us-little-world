export const APP_VERSION = "1.2.11";
export const API_PROTOCOL = 2;
export const RECORD_RECEIPT_TTL_MS = 7 * 86400000;
export interface ConnectionStatus {
  appVersion: string;
  protocol: number;
  mode: "cloud" | "local" | "test";
  serverTime: number;
  aiConfigured: boolean;
  sdkVersion: string | null;
  sdkPrerelease: boolean;
}
