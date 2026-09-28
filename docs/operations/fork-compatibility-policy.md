# Fork compatibility policy

`.github/fork-policy.json` describes
`7bgsbm749g-boop/T3-Code-Forklauncher:forklauncher`. The native App id is
intentionally `null`; no branch rules are active. The generated ruleset review
payload is disabled, and `--apply` refuses remote changes.

## Trusted producer and evidence

The native adapter emits one GitHub Check Run named `T3 Fork Compatibility`,
attributed to the configured native GitHub App. It resolves proof from the
durable native coordinator; it does not accept Actions output or caller-authored
evidence. There is no separate native `T3 Fork Compatibility Evidence` run.
GitHub documents that only GitHub Apps can create Check Runs; a workflow job
cannot impersonate this App identity.

The intended PR adapter must read the current PR and fetched
`merge_commit_sha` object. The object must be the exact API candidate and have
the current base/head as its two parents. Evidence binds the source SHA, base
SHA, candidate SHA, candidate tree, candidate parents, target ref, exact pinned
profile digest, and each exact command/argument tuple with successful exit
metadata. The policy rejects extra/missing commands, stale profile revisions,
wrong candidate identities, and check runs with a different deterministic
external id.

Before a future PR producer can publish this check, the trusted adapter must reread
the PR/base and candidate object and compares the identity tuple. A moved head,
base, merge SHA, or tree yields no successful check. Check identity includes PR
number, source, base, candidate, tree and profile revision; reruns cannot
overwrite a different identity. Ref updates use native Git transport with an
exact `--force-with-lease=<ref>:<expected-old-sha>` after fast-forward ancestry
verification. This rejects any movement of the expected old ref and differs
from GitHub REST `force:false`, which lacks old-SHA CAS. Windows mutation
remains unsupported.

Do not treat ordinary Actions workflow success as compatibility acceptance.
The native coordinator loads its validation profile from server-owned code and
executes configured arguments against the candidate. Custom-PR evidence
production is still unsupported. The `.github` policy evaluator is not wired to
the native coordinator; its fixture tests do not prove that a PR can produce a
passing check. The ruleset helper uses the actual native check context but emits
only a disabled review payload until a native custom-PR producer exists.

Candidate artifacts also bind an immutable workflow-control identity. Trusted
configuration pins the dispatch workflow commit and SHA-256 digests for the
caller workflow, local reusable desktop workflow, composite apt action, and
artifact assembly scripts. The Actions run control SHA and each file fetched at
that SHA must match the pins; the candidate SHA remains a separate package
input. Artifact preparation stays inert until those pins are provisioned from a
reviewed workflow revision. GitHub exposes the workflow commit SHA and resolves
same-repository reusable workflows from the caller's commit; the adapter also
fetches and hashes each local source file at that pinned commit ([workflow
contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[reusable workflow configuration](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)).

## Ref updates and direct-push policy

The eventual ruleset restricts writes to the dedicated App, the only possible
bypass actor because GitHub bypass applies to the whole ruleset. Custom-PR merge
evidence is not implemented. Direct-push bypass is not implemented. No human,
write-role, or Actions actor is included.

`directPushBypass` is false and the native config rejects `true`; mediated
custom direct updates are not exposed. Any future bypass must be limited to a
native direct-update action. It must never waive published upstream stable
validation. Stable metadata and ancestry come from the trusted GitHub/Git
adapter, not caller labels.

## Ruleset generation and provisioning

Read-only inspection:

```sh
node .github/scripts/fork-ruleset.mjs --verify
```

The checked-in App id is unset, so `--payload` fails closed. With a provisioned
App ID, the payload requires `T3 Fork Compatibility` from that same App but is
still disabled; `--apply` is hard-disabled until native custom-PR evidence
production is implemented. `--verify` is read-only. Do not enable direct-push
bypass or branch rules yet.

The provisioned App needs Actions read for candidate artifact metadata and
downloads, Checks write for trusted status publication, Pull requests read for
PR identity inspection, and Contents write for workflow source reads, mediated
ref updates, and draft releases. Keep its private key in the native
server's secret store, never GitHub Actions PR workflows. The ruleset setup API
separately needs repository Administration write; it is an operator credential
and not a runtime secret. No App, key, installation or remote ruleset mutation
has been made in this slice.

## Downstream repositories

Each downstream configures its own repository slug, target branch and installed
native App identity. Install/configure the App separately in that repository;
Checks are repository-scoped. A contribution branch inside the downstream base
repo is the least surprising PR path. Same-owner forks remain part of a GitHub
fork network and inherit fork-originated Actions restrictions/approval behavior;
the downstream base repository must own the trusted App installation and
validation. If independent repository/network policy is needed, create a
standalone repository from the code instead of assuming a fork is isolated.

## Native server configuration

The server reads optional `T3CODE_FORK_GITHUB_CONFIG` at startup and passes it
to `makeForkGithubNativeServiceFromOperatorConfig`. An unset path leaves trust
providers absent. Invalid files keep the service unavailable with a bounded
reason from `read`; the loader snapshots a regular file capped at 128 KiB. There
is no watcher; restart after edits. Existing accepted operations retain their
original snapshot and fail freshness checks if trust configuration changes.

`generateForkGithubOperatorConfig` assembles a sanitized file from the exported
`SERVER_VALIDATION_PROFILE`, actual native check identity, and explicit
repository/App/workflow pins. Without an App ID it returns `incomplete`; it
never invents trust. Repository slug/id, branch, profile, check App identity,
workflow control commit and required file digests are validated together. The
loader rejects unknown fields and `directPushBypass: true`.

Illustrative generated shape (verify every ID and digest from the trusted
repository and reviewed workflow revision; do not copy a hand-maintained
profile):

```json
{
  "schemaVersion": 1,
  "target": {
    "repository": "7bgsbm749g-boop/T3-Code-Forklauncher",
    "repositoryId": 123456789,
    "branch": "forklauncher"
  },
  "nativeAppId": 123456,
  "directPushBypass": false,
  "validationProfile": {
    "id": "t3-server-default",
    "revision": "3",
    "commands": [
      { "command": "vp", "args": ["i", "--frozen-lockfile"], "timeoutMs": 1800000 },
      { "command": "vp", "args": ["run", "--filter", "t3", "typecheck"], "timeoutMs": 1800000 },
      { "command": "vp", "args": ["run", "--filter", "t3", "build:bundle"], "timeoutMs": 1800000 }
    ]
  },
  "requiredChecks": [{ "name": "T3 Fork Compatibility", "appId": 123456 }],
  "candidateWorkflow": {
    "repository": "7bgsbm749g-boop/T3-Code-Forklauncher",
    "repositoryId": 123456789,
    "workflowId": 987654,
    "workflowPath": ".github/workflows/fork-candidate.yml",
    "workflowRef": "refs/heads/forklauncher",
    "workflowCommitSha": "<40-hex-reviewed-control-commit>",
    "workflowFiles": [
      { "path": ".github/actions/setup-apt-mirrors/action.yml", "sha256": "<64-hex-digest>" },
      { "path": ".github/scripts/fork-candidate-metadata.mjs", "sha256": "<64-hex-digest>" },
      { "path": ".github/scripts/fork-candidate-versions.mjs", "sha256": "<64-hex-digest>" },
      { "path": ".github/workflows/fork-candidate.yml", "sha256": "<64-hex-digest>" },
      { "path": ".github/workflows/release-desktop.yml", "sha256": "<64-hex-digest>" },
      { "path": "scripts/smoke-cli-archive.ts", "sha256": "<64-hex-digest>" },
      { "path": "scripts/update-release-package-versions.ts", "sha256": "<64-hex-digest>" }
    ]
  }
}
```

The profile digest comes from `forkCompatibility/model.ts::validationProfileJson`;
the policy snapshot hash is derived from the validated file contents, including
the target, App/check identities, profile digest and workflow pins. Configure
`fork-github-app-id`, `fork-github-installation-id` and
`fork-github-app-private-key` through the existing server secret store. The App
needs Checks write, Actions read, Pull requests read, and Contents write for the
currently implemented promotion/draft operations. This is a configuration path,
not provisioning: the App, secrets, workflow pins, protected rules, custom-PR
evidence producer and Windows ref mutation remain separate unfinished work.

## GitHub API references

- [Ruleset REST API](https://docs.github.com/en/rest/repos/rules): required checks accept an optional `integration_id`; rulesets support `update` restrictions and App bypass actors.
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): restrict updates permits only bypass actors to push; required checks can be bound to an expected App.
- [Check Runs REST API](https://docs.github.com/en/rest/checks/runs): creating/updating Check Runs requires a GitHub App and Checks write permission.
- [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls): open PR metadata includes `merge_commit_sha` for the test merge candidate.
- [Git references REST API](https://docs.github.com/en/rest/git/refs): GitHub's REST update endpoint has no expected-old-SHA compare-and-swap field; the native adapter uses Git's exact force-with-lease instead.
