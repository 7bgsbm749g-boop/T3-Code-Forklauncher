// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ForkCompatibilityStableSource from "../forkCompatibility/ForkCompatibilityStableSource.ts";
import * as ForkGithubAdapterModule from "./ForkGithubAdapter.ts";
import { validationProfileJson } from "../forkCompatibility/model.ts";

const sha = (letter: string) => letter.repeat(40);
const appId = 87421;
const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const noEvidence = () => Effect.as(Effect.void, undefined);
const baseSha = sha("a");
const headSha = sha("b");
const candidateSha = sha("c");
const treeSha = sha("d");
const gatePolicy: ForkGithubAdapterModule.ForkGithubGatePolicySnapshot = {
  sha256: "e".repeat(64),
  requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
};
const profileDefinition: ForkGithubAdapterModule.TrustedValidationProfile = {
  id: "fork-ci",
  revision: "2",
  commands: [
    {
      command: "vp",
      args: ["test", "run", "apps/server/src/forkGithub"],
      timeoutMs: 30_000,
    },
  ],
};
const profile: ForkGithubAdapterModule.TrustedValidationProfileWithHash = {
  ...profileDefinition,
  sha256: ForkGithubAdapterModule.validationProfileSha256(profileDefinition),
};
let resolvedStableRemote: string | undefined;
const evidence: ForkGithubAdapterModule.CompatibilityEvidence = {
  kind: "custom-pr",
  requestId: "fixture-request",
  runId: "fixture-run",
  sourceSha: headSha,
  targetSha: baseSha,
  candidateSha,
  profileId: profile.id,
  profileRevision: profile.revision,
  profileSha256: profile.sha256,
  results: [
    {
      command: "vp",
      args: ["test", "run", "apps/server/src/forkGithub"],
      timeoutMs: 30_000,
      exitCode: 0,
      signal: null,
      timedOut: false,
    },
  ],
};
const durableActionRows = new Map<string, ForkGithubAdapterModule.DurableRefAction>();

const fakeServices = {
  [ForkGithubAdapterModule.ForkGithubCredentialResolver.key]:
    ForkGithubAdapterModule.ForkGithubCredentialResolver.of({
      resolve: () => Effect.succeed({ appId, installationId: 500, privateKeyPem }),
    }),
  [ForkGithubAdapterModule.ForkGithubDurableActionStore.key]:
    ForkGithubAdapterModule.ForkGithubDurableActionStore.of({
      reserve: (action) => {
        const existing = durableActionRows.get(action.actionId);
        if (existing && existing.fingerprint !== action.fingerprint)
          return Effect.fail(
            new ForkGithubAdapterModule.ForkGithubAdapterError({
              reason: "action id fingerprint conflict",
            }),
          );
        if (existing) return Effect.succeed({ role: "joined" as const, action: existing });
        durableActionRows.set(action.actionId, action);
        return Effect.succeed({ role: "owner" as const, action });
      },
      markApplied: ({ actionId, resultSha, ownerId }) => {
        const current = durableActionRows.get(actionId);
        if (!current)
          return Effect.fail(
            new ForkGithubAdapterModule.ForkGithubAdapterError({ reason: "action not reserved" }),
          );
        durableActionRows.set(actionId, { ...current, ownerId, state: "applied", resultSha });
        return Effect.void;
      },
      beginPush: ({ actionId }) => {
        const current = durableActionRows.get(actionId);
        if (current) durableActionRows.set(actionId, { ...current, state: "pushing" });
        return Effect.void;
      },
      get: (actionId) => Effect.succeed(durableActionRows.get(actionId) ?? null),
      cancel: ({ actionId, ownerId }) => {
        const action = durableActionRows.get(actionId);
        if (action) durableActionRows.set(actionId, { ...action, ownerId, state: "cancelled" });
        return Effect.void;
      },
      fail: ({ actionId, ownerId, reason }) => {
        const action = durableActionRows.get(actionId);
        if (action)
          durableActionRows.set(actionId, {
            ...action,
            ownerId,
            state: "failed",
            resultSha: reason,
          });
        return Effect.void;
      },
    }),
  [ForkGithubAdapterModule.ForkGithubValidationProfile.key]:
    ForkGithubAdapterModule.ForkGithubValidationProfile.of({
      get: () => Effect.succeed(profile),
    }),
  [ForkGithubAdapterModule.ForkGithubEvidenceResolver.key]:
    ForkGithubAdapterModule.ForkGithubEvidenceResolver.of({
      resolve: (identity) =>
        identity.kind === evidence.kind &&
        identity.sourceSha === evidence.sourceSha &&
        identity.targetSha === evidence.targetSha &&
        identity.candidateSha === evidence.candidateSha
          ? Effect.succeed(evidence)
          : noEvidence(),
    }),
  [ForkCompatibilityStableSource.ForkCompatibilityStableSource.key]:
    ForkCompatibilityStableSource.ForkCompatibilityStableSource.of({
      latestStableTag: () => Effect.succeed("v0.0.42"),
      resolveStableTagCommit: ({ remote }) => {
        resolvedStableRemote = remote;
        return Effect.succeed(sha("e"));
      },
    }),
  [GitVcsDriver.GitVcsDriver.key]: {
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as unknown as GitVcsDriver.GitVcsDriver["Service"],
};

const snapshotJson = () => ({
  state: "open",
  head: { sha: headSha },
  base: { ref: "forklauncher", sha: baseSha },
  merge_commit_sha: candidateSha,
  mergeable: true,
});

const serviceLayer = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  push: ForkGithubAdapterModule.ForkGithubRefUpdateTransport["Service"]["push"] = () =>
    Effect.succeed({ ok: false }),
  getPolicy: ForkGithubAdapterModule.ForkGithubGatePolicy["Service"]["get"] = () =>
    Effect.succeed(gatePolicy),
  resolveEvidence: ForkGithubAdapterModule.ForkGithubEvidenceResolver["Service"]["resolve"] = fakeServices[
    ForkGithubAdapterModule.ForkGithubEvidenceResolver.key
  ].resolve,
) => {
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      ForkGithubAdapterModule.ForkGithubCredentialResolver,
      fakeServices[ForkGithubAdapterModule.ForkGithubCredentialResolver.key],
    ),
    Layer.succeed(
      ForkGithubAdapterModule.ForkGithubDurableActionStore,
      fakeServices[ForkGithubAdapterModule.ForkGithubDurableActionStore.key],
    ),
    Layer.succeed(
      ForkGithubAdapterModule.ForkGithubValidationProfile,
      fakeServices[ForkGithubAdapterModule.ForkGithubValidationProfile.key],
    ),
    Layer.succeed(ForkGithubAdapterModule.ForkGithubGatePolicy, {
      get: getPolicy,
    }),
    Layer.succeed(ForkGithubAdapterModule.ForkGithubEvidenceResolver, { resolve: resolveEvidence }),
    Layer.succeed(
      ForkCompatibilityStableSource.ForkCompatibilityStableSource,
      fakeServices[ForkCompatibilityStableSource.ForkCompatibilityStableSource.key],
    ),
    Layer.succeed(GitVcsDriver.GitVcsDriver, fakeServices[GitVcsDriver.GitVcsDriver.key]),
    Layer.succeed(ForkGithubAdapterModule.ForkGithubRefUpdateTransport, { push }),
  );
  const adapter = Layer.effect(
    ForkGithubAdapterModule.ForkGithubAdapter,
    ForkGithubAdapterModule.makeForkGithubAdapter,
  ).pipe(Layer.provide(dependencies));
  return Layer.mergeAll(dependencies, adapter);
};

const tokenResponse = () =>
  Response.json({
    token: "fixture-installation-token",
    repositories: [{ full_name: "downstream/project" }],
  });

it.effect(
  "requests repository-scoped Actions write permission and checks exact run/workflow/artifact metadata",
  () => {
    let permissions: Record<string, unknown> | undefined;
    const layer = serviceLayer((request) => {
      if (request.url.includes("access_tokens")) {
        const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
        if (body._tag === "Uint8Array" && body.body) {
          const decoded = decodeJson(new TextDecoder().decode(body.body)) as {
            permissions: Record<string, unknown>;
          };
          permissions = decoded.permissions;
        }
        return tokenResponse();
      }
      if (request.url.endsWith("/actions/runs/91"))
        return Response.json({
          id: 91,
          workflow_id: 82,
          path: ".github/workflows/fork-candidate.yml@forklauncher",
          status: "completed",
          conclusion: "success",
          head_sha: candidateSha,
          head_branch: "forklauncher",
          event: "workflow_dispatch",
          repository: { id: 1, full_name: "downstream/project" },
        });
      if (request.url.endsWith("/actions/workflows/82"))
        return Response.json({
          id: 82,
          path: ".github/workflows/fork-candidate.yml",
          state: "active",
        });
      if (request.url.endsWith("/actions/artifacts/92"))
        return Response.json({
          id: 92,
          size_in_bytes: 128,
          expired: false,
          expires_at: "2099-01-01T00:00:00Z",
          digest: `sha256:${"a".repeat(64)}`,
          workflow_run: {
            id: 91,
            repository_id: 1,
            head_repository_id: 1,
            head_branch: "forklauncher",
            head_sha: candidateSha,
          },
        });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      const metadata = yield* adapter.getCandidateArtifactMetadata({
        owner: "downstream",
        repository: "project",
        workflowRunId: "91",
        artifactId: "92",
      });
      assert.equal(metadata.run.id, 91);
      assert.equal(metadata.workflow.id, 82);
      assert.equal(metadata.artifact.workflow_run.id, 91);
      assert.deepEqual(permissions, {
        actions: "write",
        checks: "write",
        contents: "write",
        pull_requests: "read",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "dispatches only to the pinned workflow tag and reconciles exact run/artifact metadata",
  () => {
    const control = sha("e");
    const annotated = sha("d");
    const marker = `fork-candidate-v1-${"a".repeat(64)}`;
    const artifactName = `fork-candidate-0.0.43-fork.abcdef123456-${sha("c")}`;
    let dispatchBody: Record<string, unknown> | undefined;
    const layer = serviceLayer((request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.endsWith("/git/ref/tags/forklauncher-control-v1"))
        return Response.json({ object: { sha: annotated, type: "tag" } });
      if (request.url.endsWith(`/git/tags/${annotated}`))
        return Response.json({ object: { sha: control } });
      if (request.url.endsWith("/actions/workflows/82/dispatches")) {
        const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
        if (body._tag === "Uint8Array" && body.body)
          dispatchBody = decodeJson(new TextDecoder().decode(body.body)) as Record<string, unknown>;
        return Response.json({ workflow_run_id: 901 });
      }
      if (request.url.includes("/actions/workflows/82/runs?"))
        return Response.json({
          workflow_runs: [
            {
              id: 901,
              workflow_id: 82,
              display_title: marker,
              path: ".github/workflows/fork-candidate.yml@forklauncher-control-v1",
              status: "completed",
              conclusion: "success",
              head_sha: control,
              head_branch: "forklauncher-control-v1",
              event: "workflow_dispatch",
              repository: { id: 71, full_name: "downstream/project" },
            },
          ],
        });
      if (request.url.endsWith("/actions/runs/901/artifacts?per_page=100"))
        return Response.json({
          artifacts: [
            {
              id: 902,
              name: artifactName,
              size_in_bytes: 64,
              expired: false,
              expires_at: "2099-01-01T00:00:00Z",
              digest: `sha256:${"b".repeat(64)}`,
              workflow_run: {
                id: 901,
                repository_id: 71,
                head_repository_id: 71,
                head_branch: "forklauncher-control-v1",
                head_sha: control,
              },
            },
          ],
        });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      assert.equal(
        yield* adapter.resolveCandidateWorkflowRef({
          owner: "downstream",
          repository: "project",
          ref: "refs/tags/forklauncher-control-v1",
        }),
        control,
      );
      const workflowRunId = yield* adapter.dispatchCandidateWorkflow({
        owner: "downstream",
        repository: "project",
        workflowId: 82,
        ref: "refs/tags/forklauncher-control-v1",
        dispatchRequestId: marker,
        inputs: { candidate_sha: sha("c") },
      });
      assert.equal(workflowRunId, "901");
      assert.deepEqual(dispatchBody, {
        ref: "forklauncher-control-v1",
        inputs: { candidate_sha: sha("c"), dispatch_request_id: marker },
      });
      const [run] = yield* adapter.listCandidateWorkflowRuns({
        owner: "downstream",
        repository: "project",
        workflowId: 82,
        headSha: control,
      });
      assert.equal(run?.display_title, marker);
      const [artifact] = yield* adapter.listCandidateWorkflowArtifacts({
        owner: "downstream",
        repository: "project",
        runId: workflowRunId,
      });
      assert.equal(artifact?.id, 902);
      assert.equal(artifact?.name, artifactName);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("paginates candidate runs and artifacts within a fixed ten-page bound", () => {
  const seen = new Set<string>();
  const run = (id: number) => ({
    id,
    workflow_id: 82,
    path: ".github/workflows/fork-candidate.yml",
    status: "completed",
    conclusion: "success",
    head_sha: sha("e"),
    head_branch: "forklauncher-control-v1",
    event: "workflow_dispatch",
    repository: { id: 71, full_name: "downstream/project" },
  });
  const artifact = (id: number) => ({
    id,
    name: `artifact-${id}`,
    size_in_bytes: 1,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    digest: null,
    workflow_run: {
      id: 901,
      repository_id: 71,
      head_repository_id: 71,
      head_branch: "forklauncher-control-v1",
      head_sha: sha("e"),
    },
  });
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.includes("/actions/workflows/82/runs?")) {
      const page = request.url.includes("page=2") ? 2 : 1;
      seen.add(`runs:${page}`);
      return Response.json({
        total_count: 101,
        workflow_runs: page === 1 ? Array.from({ length: 100 }, (_, i) => run(i + 1)) : [run(101)],
      });
    }
    if (request.url.includes("/actions/runs/901/artifacts?")) {
      const page = request.url.includes("page=2") ? 2 : 1;
      seen.add(`artifacts:${page}`);
      return Response.json({
        total_count: 101,
        artifacts:
          page === 1 ? Array.from({ length: 100 }, (_, i) => artifact(i + 1)) : [artifact(101)],
      });
    }
    throw new Error(`Unexpected fixture request ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const runs = yield* adapter.listCandidateWorkflowRuns({
      owner: "downstream",
      repository: "project",
      workflowId: 82,
      headSha: sha("e"),
    });
    const artifacts = yield* adapter.listCandidateWorkflowArtifacts({
      owner: "downstream",
      repository: "project",
      runId: "901",
    });
    assert.equal(runs.length, 101);
    assert.equal(artifacts.length, 101);
    assert.deepEqual([...seen].sort(), ["artifacts:1", "artifacts:2", "runs:1", "runs:2"]);
  }).pipe(Effect.provide(layer));
});

it.effect("streams artifact redirects without forwarding the App token", () => {
  const archive = Buffer.from("bounded fixture archive");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : input.toString();
    requests.push(init ? { url, init } : { url });
    if (requests.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifact.example/signed?secret=fixture" },
      });
    return new Response(archive);
  };
  return Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-download-test-")),
      catch: () =>
        new ForkGithubAdapterModule.ForkGithubAdapterError({
          reason: "fixture temp creation failed",
        }),
    });
    const path = NodePath.join(directory, "archive.zip");
    try {
      const result = yield* ForkGithubAdapterModule.downloadActionsArtifactZip({
        url: "https://api.github.com/repos/downstream/project/actions/artifacts/92/zip",
        token: "fixture-private-token",
        path,
        maxBytes: 1024,
        fetcher,
      });
      assert.equal(result.size, archive.length);
      assert.equal(result.sha256, NodeCrypto.createHash("sha256").update(archive).digest("hex"));
      assert.equal(
        new Headers(requests[0]?.init?.headers).get("authorization"),
        "Bearer fixture-private-token",
      );
      assert.equal(requests[1]?.init?.headers, undefined);
      assert.equal(requests[1]?.init?.redirect, "error");
      const downloadedText = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(path, "utf8"),
        catch: () =>
          new ForkGithubAdapterModule.ForkGithubAdapterError({
            reason: "fixture file read failed",
          }),
      });
      assert.equal(downloadedText, archive.toString("utf8"));
    } finally {
      yield* Effect.tryPromise({
        try: () => NodeFSP.rm(directory, { recursive: true, force: true }),
        catch: () =>
          new ForkGithubAdapterModule.ForkGithubAdapterError({ reason: "fixture cleanup failed" }),
      });
    }
  });
});

it.effect("accepts a draft target commit when GitHub has not exposed a tag ref yet", () => {
  let createBody: Record<string, unknown> | undefined;
  const release = {
    id: 402,
    tag_name: "v0.0.43-fork.1",
    target_commitish: candidateSha,
    draft: true,
    prerelease: true,
    name: "T3 Code Forklauncher 0.0.43-fork.1",
    assets: [],
  };
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.method === "POST" && request.url.endsWith("/releases")) {
      const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
      if (body._tag === "Uint8Array" && body.body)
        createBody = decodeJson(new TextDecoder().decode(body.body)) as Record<string, unknown>;
      return Response.json(release, { status: 201 });
    }
    if (request.url.endsWith("/releases/tags/v0.0.43-fork.1")) return Response.json(release);
    if (request.url.endsWith("/git/ref/tags/v0.0.43-fork.1"))
      return Response.json({ message: "Not Found" }, { status: 404 });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* adapter.createDraftRelease({
      owner: "downstream",
      repository: "project",
      tag: release.tag_name,
      targetSha: candidateSha,
      name: release.name,
      prerelease: true,
    });
    assert.equal(result.targetSha, candidateSha);
    assert.deepEqual(createBody, {
      tag_name: release.tag_name,
      target_commitish: candidateSha,
      name: release.name,
      draft: true,
      prerelease: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "rejects a mismatched tag target even when its draft release claims the candidate SHA",
  () => {
    const release = {
      id: 403,
      tag_name: "v0.0.43-fork.1",
      target_commitish: candidateSha,
      draft: true,
      prerelease: true,
      name: "T3 Code Forklauncher 0.0.43-fork.1",
      assets: [],
    };
    const layer = serviceLayer((request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.endsWith("/releases/tags/v0.0.43-fork.1")) return Response.json(release);
      if (request.url.endsWith("/git/ref/tags/v0.0.43-fork.1"))
        return Response.json({ object: { sha: baseSha, type: "commit" } });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      const result = yield* Effect.exit(
        adapter.getReleaseByTag({
          owner: "downstream",
          repository: "project",
          tag: release.tag_name,
        }),
      );
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(layer));
  },
);

it("checks every command and exact argument against the trusted profile", () => {
  assert.equal(
    ForkGithubAdapterModule.validationProfileSha256(profileDefinition),
    NodeCrypto.createHash("sha256").update(validationProfileJson(profileDefinition)).digest("hex"),
  );
  assert.isTrue(ForkGithubAdapterModule.validateEvidence(evidence, profile));
  assert.isFalse(
    ForkGithubAdapterModule.validateEvidence(
      { ...evidence, results: [{ ...evidence.results[0]!, args: ["test", "run"] }] },
      profile,
    ),
  );
  assert.isFalse(
    ForkGithubAdapterModule.validateEvidence(
      { ...evidence, results: [{ ...evidence.results[0]!, exitCode: 1 }] },
      profile,
    ),
  );
  assert.isFalse(
    ForkGithubAdapterModule.validateEvidence(
      { ...evidence, results: [{ ...evidence.results[0]!, signal: "SIGTERM" }] },
      profile,
    ),
  );
  assert.isFalse(
    ForkGithubAdapterModule.validateEvidence(
      { ...evidence, results: [{ ...evidence.results[0]!, timedOut: true }] },
      profile,
    ),
  );
  assert.isFalse(ForkGithubAdapterModule.validateEvidence({ ...evidence, results: [] }, profile));
  assert.isFalse(
    ForkGithubAdapterModule.validateEvidence(evidence, { ...profile, sha256: "f".repeat(64) }),
  );
});

it.effect("rejects an installation token whose repository attribution differs", () => {
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens"))
      return Response.json({
        token: "fixture-token",
        repositories: [{ full_name: "another/repo" }],
      });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      adapter.inspectPullRequest({ owner: "downstream", repository: "project", number: 7 }),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect("does not push when required-check policy changes after evidence validation", () => {
  let policyReads = 0;
  let pushed = false;
  const ext = `t3-fork:v1:${NodeCrypto.createHash("sha256")
    .update(
      [
        evidence.kind,
        evidence.requestId,
        evidence.runId,
        evidence.sourceSha,
        evidence.targetSha,
        evidence.candidateSha,
        evidence.profileId,
        evidence.profileRevision,
        evidence.profileSha256,
      ].join(":"),
    )
    .digest("hex")}`;
  const layer = serviceLayer(
    (request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
      if (request.url.endsWith(`/commits/${candidateSha}`))
        return Response.json({
          sha: candidateSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }, { sha: headSha }],
        });
      if (request.url.includes("check-runs?"))
        return Response.json({
          check_runs: [
            {
              id: 1,
              name: "T3 Fork Compatibility",
              head_sha: candidateSha,
              external_id: ext,
              status: "completed",
              conclusion: "success",
              app: { id: appId },
            },
          ],
        });
      if (request.url.endsWith("/git/ref/heads/forklauncher"))
        return Response.json({ object: { sha: baseSha } });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    },
    () => {
      pushed = true;
      return Effect.succeed({ ok: true });
    },
    () => {
      policyReads += 1;
      return Effect.succeed(
        policyReads === 1 ? gatePolicy : { ...gatePolicy, sha256: "f".repeat(64) },
      );
    },
  );
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      adapter.advancePullRequestBase({
        repositoryRoot: "/tmp/fixture",
        snapshot: {
          owner: "downstream",
          repository: "project",
          number: 7,
          state: "open",
          headSha,
          baseRef: "forklauncher",
          baseSha,
          mergeCandidateSha: candidateSha,
          mergeTreeSha: treeSha,
        },
        identity: {
          kind: "custom-pr",
          requestId: "fixture-request",
          runId: "fixture-run",
          sourceSha: headSha,
          targetSha: baseSha,
          candidateSha,
        },
        actionId: "policy-moved",
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.isFalse(pushed);
  }).pipe(Effect.provide(layer));
});

it.effect("honors cancellation while the action is reserved and before the push phase", () => {
  durableActionRows.clear();
  let evidenceReads = 0;
  let pushed = false;
  const layer = serviceLayer(
    (request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
      if (request.url.endsWith(`/commits/${candidateSha}`))
        return Response.json({
          sha: candidateSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }, { sha: headSha }],
        });
      if (request.url.includes("check-runs?")) {
        const canonical = [
          evidence.kind,
          evidence.requestId,
          evidence.runId,
          evidence.sourceSha,
          evidence.targetSha,
          evidence.candidateSha,
          evidence.profileId,
          evidence.profileRevision,
          evidence.profileSha256,
        ].join(":");
        return Response.json({
          check_runs: [
            {
              id: 1,
              name: "T3 Fork Compatibility",
              head_sha: candidateSha,
              external_id: `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`,
              status: "completed",
              conclusion: "success",
              app: { id: appId },
            },
          ],
        });
      }
      if (request.url.endsWith("/git/ref/heads/forklauncher"))
        return Response.json({ object: { sha: baseSha } });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    },
    () => {
      pushed = true;
      return Effect.succeed({ ok: true });
    },
    undefined,
    (identity) => {
      evidenceReads += 1;
      if (evidenceReads === 2) {
        const action = durableActionRows.get("cancel-before-push");
        if (action) durableActionRows.set("cancel-before-push", { ...action, state: "cancelled" });
      }
      return identity.candidateSha === candidateSha ? Effect.succeed(evidence) : noEvidence();
    },
  );
  return Effect.gen(function* () {
    const service = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      service.advancePullRequestBase({
        repositoryRoot: "/tmp/fixture",
        snapshot: {
          owner: "downstream",
          repository: "project",
          number: 7,
          state: "open",
          headSha,
          baseRef: "forklauncher",
          baseSha,
          mergeCandidateSha: candidateSha,
          mergeTreeSha: treeSha,
        },
        identity: {
          kind: "custom-pr",
          requestId: "fixture-request",
          runId: "fixture-run",
          sourceSha: headSha,
          targetSha: baseSha,
          candidateSha,
        },
        actionId: "cancel-before-push",
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.isFalse(pushed);
    assert.equal(durableActionRows.get("cancel-before-push")?.state, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "requires the stable candidate to descend from both fork source and official target",
  () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) => {
      calls.push([...input.args]);
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(input.args[2] === sha("e") ? 1 : 0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    };
    return Effect.gen(function* () {
      const result = yield* Effect.exit(
        ForkGithubAdapterModule.verifyCandidateAncestry(execute, {
          repositoryRoot: "/tmp/fixture",
          requiredParents: [baseSha, sha("e")],
          candidateSha,
        }),
      );
      assert.isTrue(result._tag === "Failure");
      assert.deepEqual(calls, [
        ["merge-base", "--is-ancestor", baseSha, candidateSha],
        ["merge-base", "--is-ancestor", sha("e"), candidateSha],
      ]);
    });
  },
);

it("signs a short-lived RS256 App JWT without exposing credential material", () => {
  const { privateKey: signingKey, publicKey: verificationKey } = NodeCrypto.generateKeyPairSync(
    "rsa",
    {
      modulusLength: 2048,
    },
  );
  const jwt = ForkGithubAdapterModule.signGithubAppJwt(
    {
      appId,
      installationId: 500,
      privateKeyPem: signingKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    1_700_000_000,
  );
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString("utf8")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), {
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: appId,
  });
  assert.isTrue(
    NodeCrypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      verificationKey,
      Buffer.from(signature!, "base64url"),
    ),
  );
  assert.notInclude(jwt, "PRIVATE KEY");
});

it.effect(
  "keeps the adapter inert until native App and validation configuration is installed",
  () =>
    Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      const result = yield* Effect.exit(adapter.latestOfficialStable({ repositoryRoot: "." }));
      assert.isTrue(result._tag === "Failure");
    }).pipe(Effect.provide(ForkGithubAdapterModule.ForkGithubAdapterInert)),
);

it.effect("resolves official stable tags only against the official upstream remote", () => {
  resolvedStableRemote = undefined;
  const layer = serviceLayer(() => {
    throw new Error("Stable discovery uses the injected official source, not the GitHub App API.");
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const stable = yield* adapter.latestOfficialStable({ repositoryRoot: "/tmp/repo" });
    assert.deepEqual(stable, { tag: "v0.0.42", sha: sha("e") });
    assert.equal(resolvedStableRemote, "https://github.com/pingdotgg/t3code.git");
  }).pipe(Effect.provide(layer));
});

it.effect("binds PR metadata to the exact GitHub test merge and ordered parents", () => {
  const httpRequests: string[] = [];
  const layer = serviceLayer((request) => {
    httpRequests.push(`${request.method} ${request.url}`);
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
    if (request.url.endsWith(`/commits/${candidateSha}`))
      return Response.json({
        sha: candidateSha,
        tree: { sha: treeSha },
        parents: [{ sha: baseSha }, { sha: headSha }],
      });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const value = yield* adapter.inspectPullRequest({
      owner: "downstream",
      repository: "project",
      number: 7,
    });
    assert.deepEqual(value, {
      owner: "downstream",
      repository: "project",
      number: 7,
      state: "open",
      headSha,
      baseRef: "forklauncher",
      baseSha,
      mergeCandidateSha: candidateSha,
      mergeTreeSha: treeSha,
    });
    assert.equal(httpRequests.length, 3);
  }).pipe(Effect.provide(layer));
});

it.effect("fails closed when PR test-merge parents do not match the current head and base", () => {
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
    if (request.url.endsWith(`/commits/${candidateSha}`))
      return Response.json({
        sha: candidateSha,
        tree: { sha: treeSha },
        parents: [{ sha: sha("f") }, { sha: headSha }],
      });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const exit = yield* adapter
      .inspectPullRequest({ owner: "downstream", repository: "project", number: 7 })
      .pipe(Effect.exit);
    assert.isTrue(exit._tag === "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect("rejects promotion when the trusted App check is missing", () => {
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.endsWith("/check-runs")) {
      return Response.json({ id: 300, app: { id: appId } }, { status: 201 });
    }
    if (request.url.includes("check-runs?")) return Response.json({ check_runs: [] });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const identity = {
      kind: "custom-pr" as const,
      requestId: "fixture-request",
      runId: "fixture-run",
      sourceSha: headSha,
      targetSha: baseSha,
      candidateSha,
    };
    const created = yield* adapter.publishCompatibilityCheck({
      owner: "downstream",
      repository: "project",
      identity,
    });
    assert.equal(created.appId, appId);
    assert.equal(created.checkRunId, 300);
    assert.match(created.externalId, /^t3-fork:v1:/);
    const result = yield* Effect.exit(
      adapter.advancePullRequestBase({
        repositoryRoot: "/tmp/fixture",
        snapshot: {
          owner: "downstream",
          repository: "project",
          number: 7,
          state: "open",
          headSha,
          baseRef: "forklauncher",
          baseSha,
          mergeCandidateSha: candidateSha,
          mergeTreeSha: treeSha,
        },
        identity,
        actionId: "action-1",
      }),
    );
    assert.isTrue(result._tag === "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to report a check run attributed to a different App", () => {
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.endsWith("/check-runs"))
      return Response.json({ id: 302, app: { id: appId + 1 } }, { status: 201 });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      adapter.publishCompatibilityCheck({
        owner: "downstream",
        repository: "project",
        identity: {
          kind: "custom-pr",
          requestId: "fixture-request",
          runId: "fixture-run",
          sourceSha: headSha,
          targetSha: baseSha,
          candidateSha,
        },
      }),
    );
    assert.isTrue(result._tag === "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "publishes only a fresh exact PR merge identity and reconciles an ambiguous result",
  () => {
    const captured = {
      owner: "downstream",
      repository: "project",
      number: 7,
      state: "open" as const,
      headSha,
      baseRef: "forklauncher",
      targetBranch: "forklauncher",
      baseSha,
      mergeCandidateSha: candidateSha,
      mergeTreeSha: treeSha,
    };
    let current = snapshotJson();
    let created: Record<string, unknown> | undefined;
    let posts = 0;
    const layer = serviceLayer((request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.endsWith("/pulls/7")) return Response.json(current);
      if (request.url.endsWith(`/commits/${candidateSha}`))
        return Response.json({
          sha: candidateSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }, { sha: headSha }],
        });
      if (request.url.includes("check-runs?"))
        return Response.json({
          check_runs: created
            ? [
                {
                  id: 440,
                  name: "T3 Fork Compatibility",
                  head_sha: candidateSha,
                  external_id: created.external_id,
                  status: "completed",
                  conclusion: "success",
                  app: { id: appId },
                },
              ]
            : [],
        });
      if (request.method === "POST" && request.url.endsWith("/check-runs")) {
        posts += 1;
        const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
        assert.equal(body._tag, "Uint8Array");
        created = decodeJson(new TextDecoder().decode(body.body)) as Record<string, unknown>;
        return Response.json({ id: 440, app: { id: appId } }, { status: 201 });
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      const first = yield* adapter.publishPullRequestCompatibilityCheck({
        snapshot: captured,
        evidence,
        identitySha256: "9".repeat(64),
        reconcileOnly: false,
      });
      assert.equal(first?.checkRunId, 440);
      assert.equal(first?.appId, appId);
      assert.equal(posts, 1);
      assert.equal(created?.head_sha, candidateSha);
      assert.equal(created?.conclusion, "success");
      const recovered = yield* adapter.publishPullRequestCompatibilityCheck({
        snapshot: captured,
        evidence,
        identitySha256: "9".repeat(64),
        reconcileOnly: true,
      });
      assert.equal(recovered?.checkRunId, 440);
      assert.equal(posts, 1, "recovery discovers the remote result without posting twice");
      current = { ...snapshotJson(), base: { ref: "forklauncher", sha: sha("f") } };
      const moved = yield* Effect.exit(
        adapter.publishPullRequestCompatibilityCheck({
          snapshot: captured,
          evidence,
          identitySha256: "9".repeat(64),
          reconcileOnly: false,
        }),
      );
      assert.isTrue(moved._tag === "Failure");
      assert.equal(posts, 1, "a changed PR base cannot create a success check");
      current = {
        ...snapshotJson(),
        head: { sha: sha("8") },
      };
      const movedHead = yield* Effect.exit(
        adapter.publishPullRequestCompatibilityCheck({
          snapshot: captured,
          evidence,
          identitySha256: "9".repeat(64),
          reconcileOnly: false,
        }),
      );
      assert.isTrue(movedHead._tag === "Failure");
      assert.equal(posts, 1, "a changed PR head cannot create a success check");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "rejects custom PR check attribution when the configured policy names another App",
  () => {
    let posts = 0;
    const layer = serviceLayer(
      (request) => {
        if (request.url.includes("access_tokens")) return tokenResponse();
        if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
        if (request.url.endsWith(`/commits/${candidateSha}`))
          return Response.json({
            sha: candidateSha,
            tree: { sha: treeSha },
            parents: [{ sha: baseSha }, { sha: headSha }],
          });
        if (request.url.includes("check-runs?")) return Response.json({ check_runs: [] });
        if (request.method === "POST" && request.url.endsWith("/check-runs")) posts += 1;
        throw new Error(`Unexpected request ${request.method} ${request.url}`);
      },
      undefined,
      () =>
        Effect.succeed({
          ...gatePolicy,
          requiredChecks: [{ name: "T3 Fork Compatibility", appId: appId + 1 }],
        }),
    );
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      const result = yield* Effect.exit(
        adapter.publishPullRequestCompatibilityCheck({
          snapshot: {
            owner: "downstream",
            repository: "project",
            number: 7,
            state: "open",
            headSha,
            baseRef: "forklauncher",
            targetBranch: "forklauncher",
            baseSha,
            mergeCandidateSha: candidateSha,
            mergeTreeSha: treeSha,
          },
          evidence,
          identitySha256: "8".repeat(64),
          reconcileOnly: false,
        }),
      );
      assert.isTrue(result._tag === "Failure");
      assert.equal(posts, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects a matching check name and SHA published by another App", () => {
  const layer = serviceLayer((request) => {
    if (request.url.includes("access_tokens")) return tokenResponse();
    if (request.url.includes("check-runs?"))
      return Response.json({
        check_runs: [
          {
            id: 301,
            name: "T3 Fork Compatibility",
            head_sha: candidateSha,
            external_id: "t3-fork:v1:spoofed",
            status: "completed",
            conclusion: "success",
            app: { id: appId + 1 },
          },
        ],
      });
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      adapter.advancePullRequestBase({
        repositoryRoot: "/tmp/fixture",
        snapshot: {
          owner: "downstream",
          repository: "project",
          number: 7,
          state: "open",
          headSha,
          baseRef: "forklauncher",
          baseSha,
          mergeCandidateSha: candidateSha,
          mergeTreeSha: treeSha,
        },
        identity: {
          kind: "custom-pr",
          requestId: "fixture-request",
          runId: "fixture-run",
          sourceSha: headSha,
          targetSha: baseSha,
          candidateSha,
        },
        actionId: "action-spoof",
      }),
    );
    assert.isTrue(result._tag === "Failure");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "does not promote after a target branch advances between final read and non-force update",
  () => {
    let pushCalled = false;
    const advancedSha = sha("f");
    let currentRef = baseSha;
    const requests: string[] = [];
    const canonical = [
      evidence.kind,
      evidence.requestId,
      evidence.runId,
      evidence.sourceSha,
      evidence.targetSha,
      evidence.candidateSha,
      evidence.profileId,
      evidence.profileRevision,
      evidence.profileSha256,
    ].join(":");
    const checkExternalId = `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`;
    const layer = serviceLayer(
      (request) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.url.includes("access_tokens")) return tokenResponse();
        if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
        if (request.url.endsWith(`/commits/${candidateSha}`))
          return Response.json({
            sha: candidateSha,
            tree: { sha: treeSha },
            parents: [{ sha: baseSha }, { sha: headSha }],
          });
        if (request.url.includes("check-runs?"))
          return Response.json({
            check_runs: [
              {
                id: 300,
                name: "T3 Fork Compatibility",
                head_sha: candidateSha,
                external_id: checkExternalId,
                status: "completed",
                conclusion: "success",
                app: { id: appId },
              },
            ],
          });
        if (request.method === "GET" && request.url.endsWith("/git/ref/heads/forklauncher"))
          return Response.json({ object: { sha: currentRef } });
        throw new Error(`Unexpected request ${request.method} ${request.url}`);
      },
      () => {
        pushCalled = true;
        currentRef = advancedSha;
        return Effect.succeed({ ok: false });
      },
    );
    return Effect.gen(function* () {
      const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
      // The transport models the receive-pack lease rejecting a moved old ref.
      const result = yield* Effect.exit(
        adapter.advancePullRequestBase({
          repositoryRoot: "/tmp/fixture",
          snapshot: {
            owner: "downstream",
            repository: "project",
            number: 7,
            state: "open",
            headSha,
            baseRef: "forklauncher",
            baseSha,
            mergeCandidateSha: candidateSha,
            mergeTreeSha: treeSha,
          },
          identity: {
            kind: "custom-pr",
            requestId: "fixture-request",
            runId: "fixture-run",
            sourceSha: headSha,
            targetSha: baseSha,
            candidateSha,
          },
          actionId: "action-race",
        }),
      );
      assert.isTrue(
        pushCalled,
        `${requests.length} requests; ${result._tag === "Failure" ? String(result.cause) : "succeeded"}`,
      );
      assert.isTrue(result._tag === "Failure");
      assert.equal(currentRef, advancedSha);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("retries the same durable ref action without applying it twice", () => {
  durableActionRows.clear();
  const canonical = [
    evidence.kind,
    evidence.requestId,
    evidence.runId,
    evidence.sourceSha,
    evidence.targetSha,
    evidence.candidateSha,
    evidence.profileId,
    evidence.profileRevision,
    evidence.profileSha256,
  ].join(":");
  const externalId = `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`;
  let branchSha = baseSha;
  let patchCount = 0;
  const layer = serviceLayer(
    (request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.includes("check-runs?"))
        return Response.json({
          check_runs: [
            {
              id: 300,
              name: "T3 Fork Compatibility",
              head_sha: candidateSha,
              external_id: externalId,
              status: "completed",
              conclusion: "success",
              app: { id: appId },
            },
          ],
        });
      if (request.url.endsWith("/pulls/7")) return Response.json(snapshotJson());
      if (request.url.endsWith(`/commits/${candidateSha}`))
        return Response.json({
          sha: candidateSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }, { sha: headSha }],
        });
      if (request.method === "GET" && request.url.endsWith("/git/ref/heads/forklauncher"))
        return Response.json({ object: { sha: branchSha } });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    },
    () => {
      patchCount += 1;
      branchSha = candidateSha;
      return Effect.succeed({ ok: true });
    },
  );
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const action = {
      snapshot: {
        owner: "downstream",
        repository: "project",
        number: 7,
        state: "open" as const,
        headSha,
        baseRef: "forklauncher",
        baseSha,
        mergeCandidateSha: candidateSha,
        mergeTreeSha: treeSha,
      },
      identity: {
        kind: "custom-pr" as const,
        requestId: "fixture-request",
        runId: "fixture-run",
        sourceSha: headSha,
        targetSha: baseSha,
        candidateSha,
      },
      repositoryRoot: "/tmp/fixture",
      actionId: "action-retry",
    };
    const first = yield* adapter.advancePullRequestBase(action);
    const retry = yield* adapter.advancePullRequestBase(action);
    assert.deepEqual(first, { sha: candidateSha, alreadyApplied: false });
    assert.deepEqual(retry, { sha: candidateSha, alreadyApplied: true });
    assert.equal(patchCount, 1);
    assert.equal(branchSha, candidateSha);
  }).pipe(Effect.provide(layer));
});

it.effect("re-reads PR identity after branch read and cancels if head moves", () => {
  let pullReads = 0;
  let patchCalled = false;
  const movedHead = sha("e");
  const movedCandidate = sha("f");
  const canonical = [
    evidence.kind,
    evidence.requestId,
    evidence.runId,
    evidence.sourceSha,
    evidence.targetSha,
    evidence.candidateSha,
    evidence.profileId,
    evidence.profileRevision,
    evidence.profileSha256,
  ].join(":");
  const externalId = `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`;
  const layer = serviceLayer(
    (request) => {
      if (request.url.includes("access_tokens")) return tokenResponse();
      if (request.url.includes("check-runs?"))
        return Response.json({
          check_runs: [
            {
              id: 300,
              name: "T3 Fork Compatibility",
              head_sha: candidateSha,
              external_id: externalId,
              status: "completed",
              conclusion: "success",
              app: { id: appId },
            },
          ],
        });
      if (request.url.endsWith("/pulls/7")) {
        pullReads += 1;
        return Response.json({
          ...snapshotJson(),
          head: { sha: pullReads > 1 ? movedHead : headSha },
          merge_commit_sha: pullReads > 1 ? movedCandidate : candidateSha,
          mergeable: true,
        });
      }
      if (request.url.endsWith(`/commits/${candidateSha}`))
        return Response.json({
          sha: candidateSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }, { sha: headSha }],
        });
      if (request.url.endsWith(`/commits/${movedCandidate}`))
        return Response.json({
          sha: movedCandidate,
          tree: { sha: sha("1") },
          parents: [{ sha: baseSha }, { sha: movedHead }],
        });
      if (request.method === "GET" && request.url.endsWith("/git/ref/heads/forklauncher"))
        return Response.json({ object: { sha: baseSha } });
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    },
    () => {
      patchCalled = true;
      return Effect.succeed({ ok: true });
    },
  );
  return Effect.gen(function* () {
    const adapter = yield* ForkGithubAdapterModule.ForkGithubAdapter;
    const result = yield* Effect.exit(
      adapter.advancePullRequestBase({
        repositoryRoot: "/tmp/fixture",
        snapshot: {
          owner: "downstream",
          repository: "project",
          number: 7,
          state: "open",
          headSha,
          baseRef: "forklauncher",
          baseSha,
          mergeCandidateSha: candidateSha,
          mergeTreeSha: treeSha,
        },
        identity: {
          kind: "custom-pr",
          requestId: "fixture-request",
          runId: "fixture-run",
          sourceSha: headSha,
          targetSha: baseSha,
          candidateSha,
        },
        actionId: "action-head-move",
      }),
    );
    assert.equal(pullReads, 2);
    assert.isFalse(patchCalled);
    assert.isTrue(result._tag === "Failure");
  }).pipe(Effect.provide(layer));
});
