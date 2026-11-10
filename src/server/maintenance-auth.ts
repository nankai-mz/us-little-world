import { timingSafeEqual } from "node:crypto";

export function isMaintenanceEvent(event: any) {
  return event?.Type === "Timer" && event?.TriggerName === "usMaintenance";
}
export function authorizeMaintenance(
  event: any,
  openId: string | undefined,
  secret: string | undefined,
) {
  if (openId || !secret || secret.length < 32 || !isMaintenanceEvent(event))
    return false;
  try {
    const message = JSON.parse(event.Message);
    if (typeof message.maintenanceToken !== "string") return false;
    const supplied = Buffer.from(message.maintenanceToken, "utf8");
    const expected = Buffer.from(secret, "utf8");
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  } catch {
    return false;
  }
}
