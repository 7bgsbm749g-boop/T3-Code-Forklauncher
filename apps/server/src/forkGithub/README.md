# Native fork GitHub adapter

Server startup and RPC now compose the command service, but startup still supplies
inert trust providers. `makeForkGithubNativeServiceFromOperatorConfig(path)` is the
validated local-file layer factory for a future explicit startup selection;
until the shared startup owner selects it, remote promotion remains unavailable.
It snapshots one operator file at runtime start and provides the existing trusted
profile, gate policy, repository target, and workflow pin services. Credentials
remain resolved only from ServerSecretStore references; neither the file nor RPC
accepts private keys or tokens. `read` reports bounded configuration failures.

`submitPromotion` and `submitDraft` persist an immutable operation ID and snapshot
before returning `pending`. Repeating that ID with the same identity joins the
existing row; changing its request, run, artifact, target, profile, policy,
credential installation, credential secret fingerprint, or workflow pin is
rejected. A single capacity-one wake queue is only a coalesced signal; SQLite is
the backlog. A server-scoped worker claims each operation with an owner token and
lease CAS, renews while active, and is interrupted before dependent database
layers close. Another service instance cannot steal an active same-process claim.
After scope shutdown, a pending operation becomes claimable; after process restart,
dead-owner claims can be reclaimed. Caller disconnection does not cancel accepted
work. The worker rechecks the accepted snapshot before delegation and passes
expected target/profile/policy and workflow commit guards into the promotion and
draft services.

Adapter errors and interruption never turn an uncertain remote action into a
terminal `failed` result. The native row remains `pending`, records the worker
failure where possible, and delegates retry/reconciliation to the existing
idempotent action/release journals. Disabled or incomplete current configuration
also leaves accepted work pending; re-enabling signals the worker. Stable policy,
target, profile, credential, workflow, or candidate changes invalidate an accepted
snapshot before new delegated work can start. Operation result contracts are
discriminated promotion/draft schemas rather than arbitrary JSON.

The typed RPC schemas and native handlers are registered by shared startup/RPC
integration. Configure/submit require `orchestration:operate`; reads require
`orchestration:read`. The service remains unavailable for remote operations
until startup selects operator configuration and a dedicated App is provisioned.

The native layer composes the SQLite action journal, Git transport, and native evidence resolver. The resolver follows
the persisted request-to-run link and calls the coordinator's freshness-checked
read immediately before check publication and ref advancement. A repaired run
is usable only when its completed native repair row and eligibility binding
match the captured policy, failed baseline, repaired SHA, and fresh validation
run. `review-required`, stale, missing, or mismatched rows remain denied. Custom
PR evidence remains unsupported. Candidate Actions jobs are never accepted as
evidence. Stable promotion requires an injected fork target, App credentials,
trusted profile and policy.

Draft preparation is a separate operation after the durable ref action is
`applied`. It verifies an exact successful `fork-candidate.yml` run/artifact and
the v2 candidate manifest, then creates or resumes a prerelease draft at the
exact candidate and uploads only the Linux CLI archive, server distribution,
Windows installer, blockmap, and update manifest. The GitHub release adapter verifies the peeled tag
target and uploaded asset digests. It has no publish or install operation. The
Actions artifact source is composed into the draft backing layer. Server startup
reads an operator-owned configuration file only when a path is explicitly
configured; missing or invalid configuration leaves remote operations unavailable.

The profile digest uses `forkCompatibility/model.ts::validationProfileJson`.
Evidence must match every configured command, argument, timeout, zero exit,
null signal and non-timeout result. Mutation rereads the profile, required
checks, policy snapshot and PR or stable identity immediately before writing.

Git ref advancement uses an explicit
`--force-with-lease=<ref>:<expected-old-sha>` receive-pack lease after an
independent fast-forward ancestry check. A temporary bare Git directory has
isolated config and references only the trusted coordinator checkout's object
store. The checkout's metadata is queried only to locate its object directory;
ancestry and credentialed transport use the isolated directory. URL rewrites,
proxy, trace, credential and hook settings are not used. Production accepts only validated
`https://github.com/<owner>/<repo>.git` targets. The repository-scoped App token
is passed to Git in a short-lived askpass environment, never in arguments or
logs. Cancellation and lost push responses are reconciled against the exact
remote ref before journaling; an uncertain action is never recorded as applied
from the subprocess result alone.

Credentialed ref mutation is disabled on Windows until its process-tree
termination path receives an equivalent hosted lifecycle proof. Linux runs use
a captured process group and wait for close before removing askpass material.

Migration `056_ForkGithubActions.ts` creates the operation, action, release, and
configuration journals but remains unregistered in `Migrations.ts`. Reservations pin action fingerprint and
policy snapshot; only the current, unexpired lease owner may begin a write. An
expired reservation can be reclaimed after reopen, observe an already advanced
ref and record the applied result without pushing again. Cancellation is
terminal before the write; receive-pack cannot be rolled back after acceptance.

The `.github` policy CLI is an orchestration and evidence adapter, not a second
authority. Native profile bytes use the shared model canonicalizer. The CLI's
custom PR evidence producer and check identity still need consolidation with
native receipts before custom PR gating is enabled.

Draft preparation now includes a bounded Actions artifact source. It requires
explicit trusted repository ID/slug, workflow ID, workflow path/ref, exact
workflow-control commit, and SHA-256 pins for the caller, local reusable
workflow, composite action, and build/attestation scripts. It checks the run
control commit independently from the packaged candidate SHA, fetches each
pinned source file at that commit, and compares its digest. It also checks exact
run/artifact linkage and GitHub's archive digest, then extracts a capped ZIP using
`yauzl` without following links or executing files. Candidate assets remain in
an owned temporary directory and stream to the draft upload API; the directory
is removed after success or failure. Its manifest must include only the
version-matched Linux CLI and server archives plus hosted Windows installer,
blockmap, and update metadata. Archive download redirects are followed without
forwarding the App token.

To activate later, register migration 056 after migration 055, wire the
configured layer from native startup, pin the reviewed workflow-control commit
and file digests, and provision a dedicated GitHub App with Actions: read,
Checks: write, Pull requests: read, and Contents: write permissions. Store App
ID, installation ID and private key only as
`fork-github-app-id`, `fork-github-installation-id` and
`fork-github-app-private-key` in the server secret store. Set repository and
workflow identity from trusted repository administration, not candidate
metadata. Keep the App identity unset and branch rules inactive until the
coordinator integration and trusted workflow branch rules are validated.

GitHub's create-release API says `target_commitish` selects the commit from
which a missing release tag is created, but does not document when a draft
materializes its Git ref. The adapter therefore accepts an exact SHA recorded
on the draft when the tag ref is not yet visible, and checks any visible ref
for the exact candidate SHA. See the [create release API](https://docs.github.com/en/rest/releases/releases)
and [Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts).
