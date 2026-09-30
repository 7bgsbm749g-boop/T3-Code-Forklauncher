export interface ForkRulesetProjectionInput {
  readonly repository: string;
  readonly targetBranch: string;
  readonly directPushBypass: boolean;
  readonly directPushActorId: number | null;
  readonly nativeIntegration: { readonly appId: number | null };
  readonly aggregateCheck: {
    readonly name: string;
    readonly appId: number | null;
    readonly requiredChecks?: ReadonlyArray<{ readonly name: string; readonly appId: number }>;
  };
  readonly compatibilityEvidence: {
    readonly checkName: string;
    readonly trustedAppId: number | null;
  };
}

export interface ForkRulesetProjection {
  readonly name: string;
  readonly target: "branch";
  readonly enforcement: "disabled";
  readonly bypass_actors: ReadonlyArray<{
    readonly actor_id: number;
    readonly actor_type: "Integration";
    readonly bypass_mode: "always";
  }>;
  readonly conditions: {
    readonly ref_name: {
      readonly include: ReadonlyArray<string>;
      readonly exclude: ReadonlyArray<string>;
    };
  };
  readonly rules: ReadonlyArray<{
    readonly type: string;
    readonly parameters: {
      readonly required_status_checks?: ReadonlyArray<{
        readonly context: string;
        readonly integration_id: number;
      }>;
      readonly strict_required_status_checks_policy?: boolean;
      readonly [key: string]: unknown;
    };
  }>;
}

export function buildForkRuleset(policy: ForkRulesetProjectionInput): ForkRulesetProjection;

export interface ForkRulesetPreflight {
  readonly repository: string | null;
  readonly targetBranch: string | null;
  readonly requiredContext: string;
  readonly expectedAppId: number | null;
  readonly pullRequestNumber: number | null;
  readonly candidateSha: string | null;
  readonly strictUpToDate: true;
  readonly blockers: ReadonlyArray<string>;
  readonly configurationAndCheckIdentityMatch: boolean;
  readonly activationPrerequisitesMissing: ReadonlyArray<string>;
  readonly canApply: false;
}

export function evaluateForkRulesetPreflight(
  policy: ForkRulesetProjectionInput,
  input: {
    readonly repository: { readonly full_name?: string };
    readonly pullRequest?: {
      readonly number?: number;
      readonly state?: string;
      readonly merge_commit_sha?: string | null;
      readonly base?: {
        readonly ref?: string;
        readonly repo?: { readonly full_name?: string };
      };
    };
    readonly checkRuns?: ReadonlyArray<{
      readonly name?: string;
      readonly head_sha?: string;
      readonly app?: { readonly id?: number };
      readonly status?: string;
      readonly conclusion?: string | null;
    }>;
  },
): ForkRulesetPreflight;
