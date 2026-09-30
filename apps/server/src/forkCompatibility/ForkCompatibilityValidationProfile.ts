import type { ValidationProfile } from "./model.ts";

/** Shared by the compatibility worker and trusted GitHub validation adapters. */
export const SERVER_VALIDATION_PROFILE: ValidationProfile = {
  id: "t3-server-default",
  revision: "3",
  commands: [
    {
      command: "vp",
      args: ["i", "--frozen-lockfile"],
      timeoutMs: 30 * 60_000,
    },
    { command: "vp", args: ["run", "--filter", "t3", "typecheck"], timeoutMs: 30 * 60_000 },
    {
      command: "vp",
      args: ["run", "--filter", "t3", "build:bundle"],
      timeoutMs: 30 * 60_000,
    },
  ],
};
