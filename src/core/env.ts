export function selectCloudEnv(
  production: string,
  development: string,
  envVersion: string | undefined,
) {
  if (envVersion === "release") return production;
  return (development || "").trim() || production;
}
