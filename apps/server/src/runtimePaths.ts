const DEFAULT_RELEASE_REPOSITORY = "7bgsbm749g-boop/T3-Code-Forklauncher";
const RELEASE_REPOSITORY_ENV = "T3CODE_RELEASE_REPOSITORY";
const RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";
declare const __T3CODE_BUILD_RELEASE_REPOSITORY__: string | undefined;

function selectedRepository(repository?: string): string {
  const fallback =
    typeof __T3CODE_BUILD_RELEASE_REPOSITORY__ === "string"
      ? __T3CODE_BUILD_RELEASE_REPOSITORY__
      : DEFAULT_RELEASE_REPOSITORY;
  const runtimeRepository = process.env[RELEASE_REPOSITORY_ENV]?.trim();
  const selected =
    repository === undefined ? runtimeRepository || fallback : repository.trim() || fallback;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selected)) {
    throw new Error(`${RELEASE_REPOSITORY_ENV} must be a GitHub owner/repository slug.`);
  }
  const [owner, name] = selected.split("/");
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error(`${RELEASE_REPOSITORY_ENV} must be a GitHub owner/repository slug.`);
  }
  return selected;
}

/** Shared by pinned-runtime installation and the dependency-free service launcher. */
export function runtimeFeedIdentity(
  version: string,
  repository?: string,
  baseUrl?: string,
): string {
  const repo = selectedRepository(repository);
  const selected = repo.toLowerCase();
  const runtimeBaseUrl = process.env[RELEASE_BASE_URL_ENV]?.trim();
  const configuredOrigin = baseUrl?.trim() || runtimeBaseUrl;
  const origin = (configuredOrigin || `https://github.com/${selected}/releases/download`).replace(
    /\/+$/,
    "",
  );
  return `${version}\n${selected}\n${origin}`;
}

export function runtimeVersionDirectory(
  join: (...parts: string[]) => string,
  baseDir: string,
  version: string,
  repository?: string,
): string {
  const selected = selectedRepository(repository).toLowerCase();
  const [owner, name] = selected.split("/");
  // Every feed is namespaced. A pre-existing version-only directory has no
  // reliable provenance, so it remains untouched and is never selected.
  return join(baseDir, "runtime", "versions", ".feeds", owner!, name!, version);
}
