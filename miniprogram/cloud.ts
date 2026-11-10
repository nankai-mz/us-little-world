import { selectCloudTarget } from "../src/core/env";
import { config } from "./config";

function currentEnvVersion(): string | undefined {
  try {
    return wx.getAccountInfoSync?.()?.miniProgram?.envVersion;
  } catch {
    return undefined;
  }
}

export const cloudTarget = selectCloudTarget(
  config.cloudEnv,
  config.devCloudEnv || "",
  config.cloudFunction,
  currentEnvVersion(),
);
