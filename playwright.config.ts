import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "artifacts/playwright",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: {
    channel: process.env.US_WEB_BROWSER_CHANNEL,
    actionTimeout: 10000,
    navigationTimeout: 15000,
    trace: "retain-on-failure",
  },
});
