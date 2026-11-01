export const APP_VERSION = "1.2.0";
export const API_PROTOCOL = 1;
export interface ConnectionStatus {
  appVersion: string;
  protocol: number;
  mode: "cloud" | "local" | "test";
  serverTime: number;
  aiConfigured: boolean;
  sdkVersion: string | null;
  sdkPrerelease: boolean;
}
