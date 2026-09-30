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

The native PR adapter reads the current PR and fetched `merge_commit_sha`
object. The object must be the exact API candidate and have the current
base/head as its two parents. Evidence binds the source SHA, base SHA, candidate
SHA, candidate tree, candidate parents, target ref, exact pinned profile digest,
and each exact command/argument tuple with successful exit metadata. The policy
rejects extra/missing commands, stale profile revisions, wrong candidate
identities, and check runs with a different deterministic external id.

Before publication, the trusted adapter rereads the PR/base and candidate
object and compares the identity tuple. A moved head, base, merge SHA, or tree
yields no successful check. Check identity includes PR number, source, base,
candidate, tree and profile revision; reruns cannot overwrite a different
identity. Ref updates use native Git transport with an exact
`--force-with-lease=<ref>:<expected-old-sha>` after fast-forward ancestry
verification. This rejects any movement of the expected old ref and differs
from GitHub REST `force:false`, which lacks old-SHA CAS. Windows mutation
remains unsupported.

Do not treat ordinary Actions workflow success as compatibility acceptance.
The native coordinator loads its validation profile from server-owned code and
executes configured arguments against the candidate. Durable Check Run
publication exists in the native PR evidence path, with local Git/SQLite and
adapter coverage. It has not been proven in one authenticated production RPC →
candidate validation → publication flow, and the repository has no configured
App or active branch gate. The `.github` policy evaluator is not authoritative;
the ruleset helper remains hard-disabled. No live custom-PR required check is
currently produced. Neither the publication implementation nor a Published
state in Settings enables a merge gate.

Candidate artifacts also bind an immutable workflow-control identity. Trusted
configuration pins the dispatch workflow commit and SHA-256 digests for the
caller workflow, local reusable desktop workflow, composite apt action, and
artifact assembly scripts. The Actions run control SHA and each file fetched at
that SHA must match the pins; the candidate SHA remains a separate package
input. The v1 pins are protected and validated; App-backed build and draft
operations remain unavailable until the App is configured. GitHub exposes the
workflow commit SHA and resolves same-repository reusable workflows from the caller's commit; the adapter also
fetches and hashes each local source file at that pinned commit ([workflow
contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[reusable workflow configuration](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)).

## Ref updates and direct-push policy

The reviewed ruleset payload restricts writes to the dedicated App, its only
bypass actor, because GitHub bypass applies to the whole ruleset. PR evidence
and Check Run publication code exist, but ruleset activation remains blocked as
described below. No human, write-role, or Actions actor is included.

`directPushBypass` defaults to false and is captured in the trusted operator
policy digest. The native adapter has a custom-PR-only action that can use the
durable action journal and exact expected-old Git lease when that operator bit
is true. It still binds the configured repository/branch and current PR
head/base/merge/tree, retains non-compatibility required checks, and does not
change the stable promotion path. This adapter primitive is not yet accepted or
exposed by the native operation worker/RPC, so no user-facing direct-update
request path is active. Do not change the operator file or use the primitive as
a generic ref update. Stable metadata and ancestry come from the trusted
GitHub/Git adapter, not caller labels.

## Ruleset generation and provisioning

Read-only inspection:

```sh
node .github/scripts/fork-ruleset.mjs --verify
```

The checked-in App id is unset, so `--payload` fails closed. With a provisioned
App ID, the payload binds `T3 Fork Compatibility` to that App but stays
disabled. The script hardcodes custom-PR support off, and `--apply` refuses
regardless of App configuration. `--verify` is read-only. Do not enable
direct-push bypass or branch rules yet.

The App registration and installation need Actions write (dispatch and run/
artifact access), Checks write (Check Run API), Contents write (pinned source
reads, mediated ref updates and draft assets), Pull requests read (PR snapshot
inspection), and Commit statuses write. GitHub requires the installed App to
have `statuses:write`, to have recently submitted a Check Run, and to be
associated with an existing required-check context before it can be selected as
that ruleset context's expected source. The runtime does not call the commit
statuses API: its short-lived installation token is repository-scoped and
explicitly requests only Actions write, Checks write, Contents write and Pull
requests read. Do not add `statuses:write` to that token unless an implemented
runtime API call needs it. Keep the App private key in the native server's
secret store, never in Actions candidate jobs. The ruleset setup API separately
needs repository Administration write; that remains an operator credential,
not a runtime permission.

Required-check identity is exactly `T3 Fork Compatibility` from the configured
App, and the native producer targets the current GitHub PR `merge_commit_sha`
(the test-merge candidate). The generated ruleset binds that name to the App's
integration id and sets strict/up-to-date checking, so a moved base requires a
fresh candidate/check. The ruleset generator still hardcodes custom-PR support
off: `--apply` refuses and the payload is disabled. The App, recent check-run
association and active control-tag ruleset do not make a PR gate active. Do
not interpret an individual Published Check Run or the Settings display as
merge eligibility; the production authenticated validation-to-publication
proof and reviewed gate activation are still prerequisites.

The generated branch ruleset grants its sole bypass actor to the dedicated
Integration App in `always` mode; a ruleset bypass actor can bypass the whole
ruleset. Keep that App credential server-only and expose updates only through
the native mediator. Do not add human, repository-role or Actions bypasses.
`directPushBypass` remains false in the checked-in operator config. The current PR evidence path
has no merge-queue `merge_group` implementation; do not enable a merge queue
until the producer and required-check identity are extended and verified for
queue candidates. Its default PR Git fetch uses an unauthenticated
`https://github.com/{owner}/{repo}.git` remote; private-repository PR fetch is
not configured or proven. Treat private PR sources as unsupported until a
short-lived authenticated fetch path is explicitly implemented and tested.

No App key/installation or active branch ruleset was provisioned by this
revision. The already-applied ruleset protects only the immutable
`forklauncher-control-v1` tag; it is not a branch merge gate.

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
loader rejects unknown fields. The opt-in only authorizes the custom direct-update
adapter action; it does not activate a public request path.

Scheduled stable validation remains non-mutating by default. Set
`automaticStablePromotion: true` to opt eligible scheduled requests into the
durable promotion → candidate build → draft preparation path. The opt-in,
schedule generation and policy are captured at request acceptance; manual and
pre-opt-in history cannot be authorized later. Each new promotion, build and
draft acceptance rechecks that snapshot, with SQLite guards at the write
boundaries. Startup recovery resumes accepted stages from their journals, not
the mutable latest request pointer. The server prepares a prerelease draft only;
it never publishes the release or installs it.

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
  "automaticStablePromotion": false,
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
    "workflowRef": "refs/tags/forklauncher-control-v1",
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
the target, App/check identities, profile digest and workflow pins. The
candidate workflow control ref is a separately provisioned immutable tag;
the server resolves it before dispatch and refuses to dispatch if its peeled
commit differs from `workflowCommitSha`. Protect that tag from updates in the
repository. The production build dispatcher and draft preparation are composed
into the server-scoped follow-through worker. Actions visibility is reconciled
with bounded backoff; unresolved runs remain durable and are retried on a later
wake or restart. Configure
`fork-github-app-id`, `fork-github-installation-id` and
`fork-github-app-private-key` through the existing server secret store. The App
needs Checks write, Actions write (for workflow dispatch and run/artifact reads),
Pull requests read, and Contents write for the currently implemented promotion
and draft operations. Workflow jobs retain only `contents: read`; App
credentials are not passed to Actions. GitHub documents that `workflow_dispatch`
accepts a branch or tag ref and requires Actions write. This is a configuration path,
not provisioning: the App, secrets, workflow pins, protected rules,
production custom-PR check publication and Windows ref mutation remain separate
unfinished work.

The server-scoped Fork Compatibility settings status includes the latest
scheduled pipeline stage, candidate version, and exact Actions run/artifact IDs
when available. Web/desktop and mobile refresh this read-only status on connect
and when the operator requests refresh; reads do not reconcile or trigger
mutations. Diagnostics are fixed public codes/messages, not candidate output or
raw GitHub errors. A prepared result is explicitly a draft and is never
published or installed by this path. The display requires the remaining App,
workflow-control and production check-gate provisioning described above.

## GitHub API references

- [Ruleset REST API](https://docs.github.com/en/rest/repos/rules): required checks accept an optional `integration_id`; rulesets support `update` restrictions and App bypass actors.
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): restrict updates permits only bypass actors to push; required checks can be bound to an expected App.
- [Check Runs REST API](https://docs.github.com/en/rest/checks/runs): creating/updating Check Runs requires a GitHub App and Checks write permission.
- [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls): open PR metadata includes `merge_commit_sha` for the test merge candidate.
- [Git references REST API](https://docs.github.com/en/rest/git/refs): GitHub's REST update endpoint has no expected-old-SHA compare-and-swap field; the native adapter uses Git's exact force-with-lease instead.
