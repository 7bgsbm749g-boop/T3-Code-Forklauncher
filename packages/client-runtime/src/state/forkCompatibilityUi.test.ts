import { describe, expect, it } from "vite-plus/test";
import {
  forgetPendingForkCheck,
  IdentityEpoch,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
} from "./forkCompatibilityUi.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fork compatibility UI state", () => {
  it("reuses an uncertain key for the same source snapshot and clears it only after acknowledgement", () => {
    const first = { sourceDirectory: "/srv/a", idempotencyKey: "key-a" };
    const second = { sourceDirectory: "/srv/b", idempotencyKey: "key-b" };
    const pending = rememberPendingForkCheck([first], second);
    expect(pendingForkCheckForSource(pending, "/srv/a")).toEqual(first);
    expect(pendingForkCheckForSource(pending, "/srv/b")).toEqual(second);
    expect(forgetPendingForkCheck(pending, "key-a")).toEqual([second]);
    expect(rememberPendingForkCheck(pending, { ...first, idempotencyKey: "key-a-retry" })).toEqual([
      { ...first, idempotencyKey: "key-a-retry" },
      second,
    ]);
  });

  it("drops delayed completion after switching server/request away and back", async () => {
    const epoch = new IdentityEpoch("server-a/request-1");
    const oldToken = epoch.update("server-a/request-1");
    const obsolete = deferred<string>();
    let applied = "";
    const oldCompletion = obsolete.promise.then((value) => {
      if (epoch.isCurrent(oldToken)) applied = value;
    });

    epoch.update("server-b/request-2");
    const currentToken = epoch.update("server-a/request-1");
    obsolete.resolve("obsolete A");
    await oldCompletion;
    expect(applied).toBe("");

    if (epoch.isCurrent(currentToken)) applied = "current A";
    expect(applied).toBe("current A");
  });
});
