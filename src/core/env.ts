export const SHARED_TEST_FUNCTION = "usApiTest";

export function selectCloudTarget(
  production: string,
  development: string,
  cloudFunction: string,
  envVersion: string | undefined,
) {
  if (envVersion === "release")
    return { env: production, functionName: cloudFunction, localScope: "" };
  const devEnv = development.trim();
  if (devEnv && devEnv !== production)
    return { env: devEnv, functionName: cloudFunction, localScope: `env.${devEnv}` };
  return {
    env: production,
    functionName: SHARED_TEST_FUNCTION,
    localScope: `test.${production}`,
  };
}
