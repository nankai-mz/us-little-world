import { selectCloudEnv } from "../src/core/env";
import { config } from "./config";

function currentEnvVersion(): string | undefined {
  try {
    return wx.getAccountInfoSync?.()?.miniProgram?.envVersion;
  } catch {
    return undefined;
  }
}

// Release builds use production; development/trial builds use the dev env
// when configured, otherwise fall back to production.
export const cloudEnv = selectCloudEnv(
  config.cloudEnv,
  config.devCloudEnv || "",
  currentEnvVersion(),
);
