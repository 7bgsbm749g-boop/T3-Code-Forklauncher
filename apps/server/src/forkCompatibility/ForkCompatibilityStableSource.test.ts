// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ForkCompatibilityStableSource from "./ForkCompatibilityStableSource.ts";

const release = (
  tag_name: string,
  overrides: Partial<{
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }> = {},
) => ({
  tag_name,
  draft: overrides.draft ?? false,
  prerelease: overrides.prerelease ?? false,
  published_at:
    overrides.published_at === undefined ? "2026-09-01T00:00:00Z" : overrides.published_at,
});

it.effect("discovers the maximum published stable version across official API pages", () => {
  const requestedPages: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => release(`v0.0.${100 - index}`));
  firstPage[0] = release("v9.0.0", { draft: true });
  firstPage[1] = release("v8.0.0", { prerelease: true });
  firstPage[2] = release("v7.0.0", { published_at: null });
  const secondPage = [release("v10.0.0")];
  const http = HttpClient.make((request) => {
    requestedPages.push(new URL(request.url).searchParams.get("page") ?? "");
    const page = requestedPages.at(-1) === "1" ? firstPage : secondPage;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(page)));
  });

  return Effect.gen(function* () {
    const selected = yield* ForkCompatibilityStableSource.latestOfficialStableTag(
      http,
      "/fixture/repository",
    );
    assert.equal(selected, "v10.0.0");
    assert.deepEqual(requestedPages, ["1", "2"]);
  });
});
