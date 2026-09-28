// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import {
  ForkGithubOperatorConfigurationService,
  generateForkGithubOperatorConfig,
  makeForkGithubOperatorConfigurationLayer,
} from "./ForkGithubOperatorConfiguration.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityNativeService.ts";
import { buildForkRuleset } from "../../../../.github/scripts/fork-ruleset.mjs";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const profile = {
  id: "forklauncher-server",
  revision: "1",
  commands: [{ command: "vp", args: ["test", "run", "focused"], timeoutMs: 30_000 }],
};
const repository = "7bgsbm749g-boop/T3-Code-Forklauncher";
const appId = 123456;
const makeFile = () => ({
  schemaVersion: 1,
  target: { repository, repositoryId: 987654321, branch: "forklauncher" },
  nativeAppId: appId,
  directPushBypass: false,
  validationProfile: profile,
  requiredChecks: [
    { name: "T3 Fork Compatibility", appId },
    { name: "Fork CI", appId },
  ],
  candidateWorkflow: {
    repository,
    repositoryId: 987654321,
    workflowId: 246810,
    workflowPath: ".github/workflows/fork-candidate.yml",
    workflowRef: "refs/heads/forklauncher",
    workflowCommitSha: "a".repeat(40),
    workflowFiles: Artifacts.trustedCandidateWorkflowPaths.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64),
    })),
  },
});

const configuredServiceReader = (path: string | undefined) =>
  Effect.gen(function* () {
    const profileService = yield* Github.ForkGithubValidationProfile;
    const policyService = yield* Github.ForkGithubGatePolicy;
    const targetService = yield* Promotion.ForkGithubStablePromotionTarget;
    const workflowService = yield* Artifacts.ForkGithubCandidateWorkflowTrust;
    const operatorConfiguration = yield* ForkGithubOperatorConfigurationService;
    return () =>
      Effect.gen(function* () {
        return {
          configuration: yield* operatorConfiguration.get(),
          profile: yield* profileService.get(),
          policy: yield* policyService.get(),
          target: yield* targetService.get(),
          workflow: yield* workflowService.get(),
        };
      });
  }).pipe(
    Effect.provide(
      makeForkGithubOperatorConfigurationLayer(path).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

const readConfiguredServices = (path: string | undefined) =>
  configuredServiceReader(path).pipe(Effect.flatMap((read) => read()));

it.effect("keeps operator trust absent and inert when no file is selected", () =>
  Effect.gen(function* () {
    const values = yield* readConfiguredServices(undefined);
    assert.isUndefined(values.profile);
    assert.isUndefined(values.policy);
    assert.isUndefined(values.target);
    assert.isUndefined(values.workflow);
  }),
);

it.effect("loads a coherent profile, policy, target and immutable workflow pin", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-config-"));
  const configPath = NodePath.join(root, "fork-github.json");
  NodeFS.writeFileSync(configPath, encodeJson(makeFile()));
  return readConfiguredServices(configPath).pipe(
    Effect.tap((values) =>
      Effect.sync(() => {
        assert.equal(values.profile?.id, profile.id);
        assert.equal(values.profile?.sha256, Github.validationProfileSha256(profile));
        assert.equal(values.policy?.sha256.length, 64);
        assert.equal(values.policy?.requiredChecks[0]?.appId, appId);
        assert.deepEqual(values.target, {
          owner: "7bgsbm749g-boop",
          repository: "T3-Code-Forklauncher",
          branch: "forklauncher",
        });
        assert.equal(values.workflow?.repository, repository);
        assert.equal(values.workflow?.workflowCommitSha, "a".repeat(40));
        assert.equal(
          values.workflow?.workflowFiles.length,
          Artifacts.trustedCandidateWorkflowPaths.length,
        );
      }),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect(
  "generates native-profile config whose trusted check maps to a disabled ruleset context",
  () => {
    const generated = generateForkGithubOperatorConfig({
      repository,
      repositoryId: 987654321,
      nativeAppId: appId,
      workflowId: 246810,
      workflowCommitSha: "a".repeat(40),
      workflowFiles: Artifacts.trustedCandidateWorkflowPaths.map((path, index) => ({
        path,
        sha256: String(index + 1).repeat(64),
      })),
    });
    assert.equal(generated.status, "ready");
    if (generated.status !== "ready") return Effect.void;

    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-fork-github-generated-config-"),
    );
    const configPath = NodePath.join(root, "fork-github.json");
    NodeFS.writeFileSync(configPath, encodeJson(generated.config));
    return configuredServiceReader(configPath)
      .pipe(
        Effect.flatMap((read) => read()),
        Effect.tap(({ configuration }) =>
          Effect.sync(() => {
            const { sha256: profileSha, ...configuredProfile } =
              configuration?.validationProfile ?? {};
            assert.deepEqual(configuredProfile, SERVER_VALIDATION_PROFILE);
            assert.equal(profileSha, Github.validationProfileSha256(SERVER_VALIDATION_PROFILE));
            assert.equal(configuration?.gatePolicy.requiredChecks.length, 1);
            assert.deepEqual(configuration?.gatePolicy.requiredChecks[0], {
              name: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
              appId,
            });
            const nativePolicy = {
              repository: `${configuration?.target.owner}/${configuration?.target.repository}`,
              targetBranch: configuration?.target.branch ?? "",
              directPushBypass: false,
              directPushActorId: null,
              nativeIntegration: { appId: configuration?.nativeAppId ?? null },
              aggregateCheck: {
                name: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
                appId: configuration?.nativeAppId ?? null,
                requiredChecks: configuration?.gatePolicy.requiredChecks ?? [],
              },
              compatibilityEvidence: {
                checkName: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
                trustedAppId: configuration?.nativeAppId ?? null,
              },
            };
            const ruleset = buildForkRuleset(nativePolicy);
            assert.equal(ruleset.enforcement, "disabled");
            assert.deepEqual(ruleset.rules[2]?.parameters.required_status_checks, [
              { context: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME, integration_id: appId },
            ]);
          }),
        ),
      )
      .pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      );
  },
);

it("keeps the checked-in policy's native check and profile identity aligned", () => {
  const policy = JSON.parse(
    NodeFS.readFileSync(new URL("../../../../.github/fork-policy.json", import.meta.url), "utf8"),
  );
  assert.equal(policy.aggregateCheck.name, Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME);
  assert.equal(policy.compatibilityEvidence.checkName, Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME);
  assert.equal(policy.nativeIntegration.appId, null);
  assert.equal(policy.aggregateCheck.appId, null);
  assert.equal(policy.compatibilityEvidence.trustedAppId, null);
  assert.equal(policy.compatibilityEvidence.profileId, SERVER_VALIDATION_PROFILE.id);
  assert.equal(policy.compatibilityEvidence.profileRevision, SERVER_VALIDATION_PROFILE.revision);
  assert.equal(
    policy.compatibilityEvidence.profileSha256,
    Github.validationProfileSha256(SERVER_VALIDATION_PROFILE),
  );
  assert.deepEqual(
    policy.compatibilityEvidence.commands,
    SERVER_VALIDATION_PROFILE.commands.map(({ command, args }) => ({ command, args })),
  );
});

it.effect(
  "keeps generated config incomplete without App identity and invalidates changed control pins",
  () => {
    const input = {
      repository,
      repositoryId: 987654321,
      nativeAppId: appId as number | null,
      workflowId: 246810,
      workflowCommitSha: "a".repeat(40),
      workflowFiles: Artifacts.trustedCandidateWorkflowPaths.map((path, index) => ({
        path,
        sha256: String(index + 1).repeat(64),
      })),
    };
    const unprovisioned = generateForkGithubOperatorConfig({ ...input, nativeAppId: null });
    assert.deepEqual(unprovisioned, { status: "incomplete", missing: ["nativeAppId"] });

    const first = generateForkGithubOperatorConfig(input);
    const moved = generateForkGithubOperatorConfig({ ...input, workflowCommitSha: "b".repeat(40) });
    assert.equal(first.status, "ready");
    assert.equal(moved.status, "ready");
    if (first.status !== "ready" || moved.status !== "ready") return Effect.void;

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-control-pin-"));
    const configPath = NodePath.join(root, "fork-github.json");
    const getHash = (config: typeof first.config) => {
      NodeFS.writeFileSync(configPath, encodeJson(config));
      return configuredServiceReader(configPath).pipe(
        Effect.flatMap((read) => read()),
        Effect.map((value) => value.configuration?.gatePolicy.sha256),
      );
    };
    return Effect.gen(function* () {
      const firstHash = yield* getHash(first.config);
      const movedHash = yield* getHash(moved.config);
      assert.notEqual(firstHash, movedHash);

      const wrongCheck = {
        ...first.config,
        requiredChecks: first.config.requiredChecks.map((check, index) =>
          index === 0 ? { ...check, name: "T3 Fork Compatibility Gate" } : check,
        ),
      };
      const wrongCheckResult = yield* getHash(wrongCheck).pipe(Effect.result);
      assert.isTrue(Result.isFailure(wrongCheckResult));
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect(
  "captures missing, oversized and non-regular selected files as unavailable provider errors",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-file-errors-"));
    const missingPath = NodePath.join(root, "missing.json");
    const oversizedPath = NodePath.join(root, "oversized.json");
    const directoryPath = NodePath.join(root, "directory");
    NodeFS.writeFileSync(oversizedPath, Buffer.alloc(128 * 1024 + 1));
    NodeFS.mkdirSync(directoryPath);

    return Effect.gen(function* () {
      for (const [path, expected] of [
        [missingPath, "Could not read the selected fork GitHub config file"],
        [oversizedPath, "Selected fork GitHub config exceeds 128 KiB"],
        [directoryPath, "Selected fork GitHub config must be a regular file"],
      ] as const) {
        // Acquiring the layer must succeed; only the returned provider read is unavailable.
        const read = yield* configuredServiceReader(path);
        const unavailable = yield* read().pipe(Effect.result);
        assert.isTrue(Result.isFailure(unavailable));
        if (Result.isFailure(unavailable)) assert.equal(unavailable.failure.message, expected);
      }

      if (HostProcessPlatform.defaultValue() === "linux") {
        const fifoPath = NodePath.join(root, "config.fifo");
        NodeChildProcess.execFileSync("mkfifo", [fifoPath]);
        const read = yield* configuredServiceReader(fifoPath);
        const unavailable = yield* read().pipe(Effect.result);
        assert.isTrue(Result.isFailure(unavailable));
        if (Result.isFailure(unavailable))
          assert.equal(
            unavailable.failure.message,
            "Selected fork GitHub config must be a regular file",
          );
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect("treats a Windows absolute path as selected rather than a relative path", () => {
  const windowsPath = "C:\\trusted\\fork-github.json";
  return configuredServiceReader(windowsPath).pipe(
    Effect.flatMap((read) => read().pipe(Effect.result)),
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.equal(
            result.failure.message,
            "Could not read the selected fork GitHub config file",
          );
      }),
    ),
  );
});

it.effect("includes workflow id/path/ref in the canonical policy identity", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-workflow-id-"));
  const configPath = NodePath.join(root, "fork-github.json");
  NodeFS.writeFileSync(configPath, encodeJson(makeFile()));
  return Effect.gen(function* () {
    const firstRead = yield* configuredServiceReader(configPath);
    const first = yield* firstRead();
    const changedWorkflow = makeFile();
    changedWorkflow.candidateWorkflow.workflowId += 1;
    NodeFS.writeFileSync(configPath, encodeJson(changedWorkflow));
    const secondRead = yield* configuredServiceReader(configPath);
    const second = yield* secondRead();
    assert.notEqual(first.policy?.sha256, second.policy?.sha256);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect(
  "reports invalid schema and mismatched trust identities without enabling providers",
  () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-fork-github-invalid-config-"),
    );
    const configPath = NodePath.join(root, "fork-github.json");
    const runCase = (value: unknown) => {
      NodeFS.writeFileSync(configPath, encodeJson(value));
      return configuredServiceReader(configPath).pipe(
        Effect.flatMap((read) => read().pipe(Effect.result)),
      );
    };
    return Effect.gen(function* () {
      const invalidJson = yield* runCase({ ...makeFile(), unexpected: "credential-like value" });
      assert.isTrue(Result.isFailure(invalidJson));
      if (Result.isFailure(invalidJson))
        assert.equal(
          invalidJson.failure.message,
          "Selected fork GitHub config JSON/schema is invalid",
        );

      const mismatch = makeFile();
      mismatch.candidateWorkflow.repositoryId = 999;
      const invalidIdentity = yield* runCase(mismatch);
      assert.isTrue(Result.isFailure(invalidIdentity));
      if (Result.isFailure(invalidIdentity))
        assert.equal(
          invalidIdentity.failure.message,
          "candidateWorkflow repository slug/id must match target repository identity",
        );

      const bypass = makeFile();
      bypass.directPushBypass = true;
      const invalidBypass = yield* runCase(bypass);
      assert.isTrue(Result.isFailure(invalidBypass));
      if (Result.isFailure(invalidBypass))
        assert.equal(
          invalidBypass.failure.message,
          "directPushBypass is unsupported; custom updates remain gated",
        );

      const malformedPin = makeFile();
      malformedPin.candidateWorkflow.workflowFiles[0]!.sha256 = "bad";
      const invalidPin = yield* runCase(malformedPin);
      assert.isTrue(Result.isFailure(invalidPin));
      if (Result.isFailure(invalidPin))
        assert.equal(
          invalidPin.failure.message,
          "candidateWorkflow must pin the exact trusted workflow commit and file digests",
        );
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
