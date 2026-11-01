import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (p) => JSON.parse(await readFile(join(root, p), "utf8"));
const sha = async (p) =>
  createHash("sha256")
    .update(await readFile(join(root, p)))
    .digest("hex");
const checks = [];
function check(name, passed, detail) {
  checks.push({ name, status: passed ? "pass" : "fail", detail });
}
async function latest(paths) {
  let result = 0;
  for (const p of paths) {
    const full = join(root, p);
    const info = await stat(full);
    if (info.isDirectory())
      result = Math.max(
        result,
        await latest((await readdir(full)).map((name) => `${p}/${name}`)),
      );
    else result = Math.max(result, info.mtimeMs);
  }
  return result;
}
async function audit(prefix, name) {
  const npmCli =
    process.env.npm_execpath ||
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  return new Promise((resolveAudit) => {
    execFile(
      process.execPath,
      [
        npmCli,
        "audit",
        "--prefix",
        join(root, prefix),
        ...(name === "cloud" ? ["--omit=dev"] : []),
        "--registry=https://registry.npmjs.org",
        "--json",
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 3 * 1024 * 1024 },
      async (error, stdout) => {
        try {
          const report = JSON.parse(stdout);
          if (!report.metadata?.vulnerabilities)
            throw new Error("audit unavailable");
          await writeFile(
            join(root, `artifacts/audit-${name}.json`),
            JSON.stringify(report, null, 2),
          );
          resolveAudit(report.metadata.vulnerabilities);
        } catch {
          resolveAudit({ unavailable: true });
        }
      },
    );
  });
}
async function main() {
  await mkdir(join(root, "artifacts"), { recursive: true });
  const pkg = await json("package.json");
  const cloudPkg = await json("cloudfunctions/usApi/package.json");
  const project = await json("project.config.json");
  const app = await json("miniprogram/app.json");
  const config = await readFile(join(root, "miniprogram/config.ts"), "utf8");
  const cloudEnv =
    config.match(/["']?cloudEnv["']?\s*:\s*["']([^"']*)["']/)?.[1] || "";
  const configuredAppId = /^wx[a-fA-F0-9]{16}$/.test(project.appid || "");
  const configuredEnv = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(cloudEnv);
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    "node",
    major > 22 || (major === 22 && minor >= 12),
    `Node ${process.versions.node}; root requirement >=22.12`,
  );
  const protocol = await readFile(join(root, "src/core/protocol.ts"), "utf8");
  check(
    "version",
    cloudPkg.version === pkg.version &&
      (protocol.includes(`APP_VERSION = '${pkg.version}'`) ||
        protocol.includes(`APP_VERSION = "${pkg.version}"`)),
    `package ${pkg.version}; cloud ${cloudPkg.version}`,
  );
  const rules = await json("database/deny-client.rules.json");
  check(
    "client-permission-template",
    rules.read === false && rules.write === false,
    "Template denies direct client access; actual cloud rules are not verified",
  );
  check(
    "location-permissions",
    JSON.stringify(app.requiredPrivateInfos || []) ===
      JSON.stringify(["chooseLocation"]) &&
      !app.requiredBackgroundModes?.includes("location"),
    "Only active chooseLocation is declared",
  );
  const outputs = [
    "dist/index.html",
    "miniprogram/app.js",
    "miniprogram/generated/controller.js",
    "miniprogram/generated/platform.js",
    "cloudfunctions/usApi/index.js",
  ];
  const hashes = {};
  const sourceTime = await latest([
    "src",
    "web",
    "miniprogram/config.ts",
    "miniprogram/controller.ts",
    "miniprogram/platform.ts",
    "miniprogram/app.ts",
    "miniprogram/media.ts",
    "miniprogram/presentation.ts",
    "miniprogram/templates",
    "miniprogram/app.wxss",
    "miniprogram/app.json",
    "public/assets",
    "scripts/build-mini.mjs",
    "scripts/build-cloud.mjs",
  ]);
  for (const output of outputs) {
    try {
      const built = await stat(join(root, output));
      hashes[output] = await sha(output);
      check(
        `build:${output}`,
        built.mtimeMs >= sourceTime,
        built.mtimeMs >= sourceTime
          ? "Built after current source changes"
          : "Rebuild required",
      );
    } catch {
      check(`build:${output}`, false, "Build output missing");
    }
  }
  try {
    const result = await json("artifacts/tests-report.json");
    const expectedTests = (await readdir(join(root, "tests"))).filter((name) =>
      /\.test\.[tj]sx?$/.test(name),
    );
    const coveredFiles = new Set(
      (result.testResults || []).map((item) => resolve(item.name)),
    );
    const testTime = await latest([
      "src",
      "tests",
      "web/platform.ts",
      "web/photos.ts",
      "miniprogram/media.ts",
      "miniprogram/presentation.ts",
      "scripts/wxml-check.mjs",
    ]);
    check(
      "tests",
      result.success === true &&
        result.numFailedTests === 0 &&
        result.numPendingTests === 0 &&
        expectedTests.every((name) =>
          coveredFiles.has(resolve(root, "tests", name)),
        ) &&
        result.startTime >= testTime,
      `${result.numPassedTests || 0} passed across ${coveredFiles.size}/${expectedTests.length} files; full suite and current sources required`,
    );
  } catch {
    check("tests", false, "Run npm test to produce the test report");
  }
  try {
    const result = await json("artifacts/mini-contract.json");
    check(
      "mini-contract",
      result.success === true &&
        result.templateSha256 ===
          (await sha("miniprogram/templates/screen.wxml")),
      `${result.routes} routes; ${result.conditionalBindings} conditional bindings; ${result.packageBytes} bytes; source/Node VM only`,
    );
  } catch {
    check("mini-contract", false, "Run npm run check:mini");
  }
  try {
    const result = await json("artifacts/cloud-sdk-contract.json");
    check(
      "sdk-contract",
      result.success &&
        result.sdkVersion === cloudPkg.dependencies["wx-server-sdk"] &&
        result.lockSha256 ===
          (await sha("cloudfunctions/usApi/package-lock.json")),
      "Installed official SDK wrapper contract only; no cloud network test",
    );
  } catch {
    check("sdk-contract", false, "Run npm run check:sdk");
  }
  const [rootAudit, cloudAudit] = await Promise.all([
    audit(".", "root"),
    audit("cloudfunctions/usApi", "cloud"),
  ]);
  check(
    "root-dependencies",
    rootAudit.total === 0,
    rootAudit.unavailable
      ? "Audit unavailable; cannot report a clean result"
      : `${rootAudit.total} advisories`,
  );
  check(
    "cloud-dependencies",
    cloudAudit.total === 0,
    cloudAudit.unavailable
      ? "Audit unavailable; cannot report a clean result"
      : `${cloudAudit.total} advisories`,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    version: pkg.version,
    scope: "local-release-preparation",
    localBuildReady: checks.every((c) => c.status === "pass"),
    configurationComplete: configuredAppId && configuredEnv,
    configuration: {
      appIdConfigured: configuredAppId,
      cloudEnvironmentConfigured: configuredEnv,
    },
    sdk: {
      version: cloudPkg.dependencies["wx-server-sdk"],
      prerelease: cloudPkg.dependencies["wx-server-sdk"].includes("-"),
      axiosOverride: cloudPkg.overrides?.axios || null,
    },
    externalValidation: {
      cloud: "not_recorded",
      ios: "not_recorded",
      android: "not_recorded",
      ai: "not_recorded",
    },
    checks,
    audit: { root: rootAudit, cloud: cloudAudit },
    outputSha256: hashes,
    nextStep:
      configuredAppId && configuredEnv
        ? "Deploy into a test environment and perform real two-account/device acceptance"
        : "Obtain AppID and CloudBase environment ID, then run npm run configure; no cloud resources have been created",
  };
  await writeFile(
    join(root, "docs/release-readiness.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Us ${pkg.version}: local build ${report.localBuildReady ? "PASS" : "FAIL"}; cloud configuration ${report.configurationComplete ? "complete" : "pending"}`,
  );
  for (const item of checks)
    console.log(
      `${item.status === "pass" ? "PASS" : "FAIL"} ${item.name}: ${item.detail}`,
    );
  console.log(
    `SDK ${report.sdk.version}${report.sdk.prerelease ? " (official prerelease; real cloud/device verification still required)" : ""}`,
  );
  console.log(
    "Real cloud, iOS, Android and AI verification: not recorded. Report: docs/release-readiness.json",
  );
  process.exitCode = report.localBuildReady ? 0 : 1;
  if (
    process.argv.includes("--require-cloud-config") &&
    !report.configurationComplete
  )
    process.exitCode = 2;
}
main().catch(() => {
  console.error(
    "Preflight could not complete. No configuration or secrets were printed.",
  );
  process.exitCode = 1;
});
