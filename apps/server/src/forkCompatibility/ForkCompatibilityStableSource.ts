import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type { GitCommandError, VcsError } from "@t3tools/contracts";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import {
  isExactStableTag,
  isGitSha,
  selectOfficialStableRelease,
  STABLE_RELEASES_URL,
} from "./model.ts";

const RELEASES_PER_PAGE = 100;
const RELEASE_INDEX_MAX_PAGES = 10;
const RELEASE_INDEX_TIMEOUT = Duration.seconds(20);
const StableReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
    published_at: Schema.NullOr(Schema.String),
  }),
);
const decodeStableReleaseIndex = Schema.decodeEffect(Schema.fromJsonString(StableReleaseIndex));

export const latestOfficialStableTag = (http: HttpClient.HttpClient, repositoryRoot: string) =>
  Effect.gen(function* () {
    const allReleases: Array<(typeof StableReleaseIndex.Type)[number]> = [];
    for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
      const url = `${STABLE_RELEASES_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`;
      const body = yield* http
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.timeoutOrElse({
            duration: RELEASE_INDEX_TIMEOUT,
            orElse: () =>
              Effect.fail(forkCompatibilityError("Timed out listing official stable releases.")),
          }),
        );
      const releases = yield* decodeStableReleaseIndex(body);
      allReleases.push(...releases);
      if (releases.length < RELEASES_PER_PAGE) {
        const selected = selectOfficialStableRelease(allReleases);
        if (selected) return selected.tag;
        return yield* forkCompatibilityError(
          `No published official stable release was found for ${repositoryRoot}.`,
        );
      }
    }
    return yield* forkCompatibilityError(
      `Official stable release listing exceeded ${RELEASE_INDEX_MAX_PAGES} pages; refusing a potentially stale selection for ${repositoryRoot}.`,
    );
  });

export interface ForkCompatibilityStableSourceShape {
  readonly latestStableTag: (input: {
    readonly repositoryRoot: string;
  }) => Effect.Effect<
    string,
    ForkCompatibilityError | HttpClientError.HttpClientError | Schema.SchemaError
  >;
  readonly resolveStableTagCommit: (input: {
    readonly repositoryRoot: string;
    readonly remote: string;
    readonly tag: string;
  }) => Effect.Effect<string, ForkCompatibilityError | VcsError | GitCommandError>;
}

export class ForkCompatibilityStableSource extends Context.Service<
  ForkCompatibilityStableSource,
  ForkCompatibilityStableSourceShape
>()("t3/forkCompatibility/ForkCompatibilityStableSource") {}

/** @public Service construction is part of the canonical Effect module API. */
export const makeForkCompatibilityStableSource = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const latestStableTag: ForkCompatibilityStableSourceShape["latestStableTag"] = Effect.fn(
    "ForkCompatibilityStableSource.latestStableTag",
  )(function* ({ repositoryRoot }) {
    return yield* latestOfficialStableTag(http, repositoryRoot);
  });

  const resolveStableTagCommit: ForkCompatibilityStableSourceShape["resolveStableTagCommit"] =
    Effect.fn("ForkCompatibilityStableSource.resolveStableTagCommit")(function* ({
      repositoryRoot,
      remote,
      tag,
    }) {
      if (!isExactStableTag(tag) || remote.trim().startsWith("-")) {
        return yield* forkCompatibilityError("Invalid stable tag or upstream remote.");
      }
      const peeledRef = `refs/tags/${tag}^{}`;
      const directRef = `refs/tags/${tag}`;
      const result = yield* git.execute({
        operation: "ForkCompatibilityStableSource.resolveStableTagCommit",
        cwd: repositoryRoot,
        args: ["ls-remote", "--tags", remote, directRef, peeledRef],
      });
      const refs = new Map(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts.length === 2)
          .map(([sha, ref]) => [ref ?? "", sha ?? ""] as const),
      );
      const commitSha = refs.get(peeledRef) ?? refs.get(directRef);
      if (!commitSha || !isGitSha(commitSha)) {
        return yield* forkCompatibilityError(`Could not resolve peeled commit for ${tag}.`);
      }
      return commitSha.toLowerCase();
    });

  return { latestStableTag, resolveStableTagCommit } satisfies ForkCompatibilityStableSourceShape;
});

export const ForkCompatibilityStableSourceLive = Layer.effect(
  ForkCompatibilityStableSource,
  makeForkCompatibilityStableSource,
);
