import type { Envelope } from "./types";

export type WebProfile = { userId: string; envelope: Envelope };
export const webProfiles = "web_profiles";
export const profileContext = (spaceId: string, userId: string) =>
  JSON.stringify(["Us/web/profile/1", spaceId, userId]);

export function validDisplayName(name: unknown): name is string {
  return typeof name === "string" && [...name].length <= 16 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name);
}
