// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Schema from "effect/Schema";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TRUSTED_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_FILES = 64;
export const FUSE2FS_1473_SOURCE_SHA256 =
  "857e6ef800feaa2bb4578fbc810214be5d3c88b072ea53c5384733a965737329";

const ToolSchema = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  package: Schema.String,
  version: Schema.String,
});
const FileSchema = Schema.Struct({ path: Schema.String, sha256: Schema.String });
const ManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rootDirectory: Schema.String,
  imageBytes: Schema.optional(Schema.Finite),
  inodeLimit: Schema.optional(Schema.Finite),
  hostFreeReserveBytes: Schema.optional(Schema.Finite),
  fuse2fs: Schema.Struct({
    path: Schema.String,
    sha256: Schema.String,
    version: Schema.Literal("1.47.3"),
    sourceArchiveSha256: Schema.Literal(FUSE2FS_1473_SOURCE_SHA256),
    package: Schema.Literal("e2fsprogs"),
  }),
  tools: Schema.Struct({
    fallocate: ToolSchema,
    mke2fs: ToolSchema,
    debugfs: ToolSchema,
    dumpe2fs: ToolSchema,
    fusermount3: ToolSchema,
  }),
  runtime: Schema.Struct({
    libraryDirectory: Schema.String,
    loader: FileSchema,
    libraries: Schema.Array(FileSchema),
    directExec: Schema.Struct({ loader: FileSchema, libraries: Schema.Array(FileSchema) }),
  }),
});
const decodeManifest = Schema.decodeUnknownSync(ManifestSchema);

export type ForkGithubCandidateStorageToolName =
  | "fallocate"
  | "mke2fs"
  | "debugfs"
  | "dumpe2fs"
  | "fusermount3";
export type ForkGithubCandidateStorageOperatorManifest = Schema.Schema.Type<typeof ManifestSchema>;

export interface VerifiedStorageFile {
  readonly path: string;
  readonly sha256: string;
}

export interface VerifiedStorageTool extends VerifiedStorageFile {
  readonly package: string;
  readonly version: string;
}

export interface VerifiedForkGithubCandidateStorageConfiguration {
  readonly manifestPath: string;
  readonly rootDirectory: string;
  readonly imageBytes?: number;
  readonly inodeLimit?: number;
  readonly hostFreeReserveBytes?: number;
  readonly tools: Readonly<
    Record<ForkGithubCandidateStorageToolName | "fuse2fs", VerifiedStorageTool>
  >;
  readonly runtime: {
    readonly libraryDirectory: string;
    readonly loader: VerifiedStorageFile;
    readonly libraries: ReadonlyArray<VerifiedStorageFile>;
    readonly directExec: {
      readonly loader: VerifiedStorageFile;
      readonly libraries: ReadonlyArray<VerifiedStorageFile>;
    };
  };
  readonly sourceArchiveSha256: string;
  readonly configurationIdentitySha256: string;
}

class ForkGithubCandidateStorageTrustError extends Error {
  readonly _tag = "ForkGithubCandidateStorageTrustError";
}

const fail = (message: string): never => {
  throw new ForkGithubCandidateStorageTrustError(message);
};
const hashFile = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const exactKeys = (value: unknown, expected: ReadonlyArray<string>) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("Candidate storage operator manifest has an invalid object shape");
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key)))
    fail("Candidate storage operator manifest contains unknown or missing fields");
};

const assertCanonicalPath = (path: string, kind: "file" | "library" | "directory" | "manifest") => {
  if (!NodePath.isAbsolute(path) || NodePath.normalize(path) !== path || path.includes("\0"))
    fail("Candidate storage manifest contains a non-canonical absolute path");
  const stat = NodeFS.lstatSync(path);
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile()))
    fail("Candidate storage manifest path is not a canonical regular path");
  if (NodeFS.realpathSync(path) !== path)
    fail("Candidate storage manifest path traverses a symlink");
  if (
    kind !== "directory" &&
    stat.size > (kind === "manifest" ? MAX_MANIFEST_BYTES : MAX_TRUSTED_FILE_BYTES)
  )
    fail("Candidate storage manifest references a file that exceeds its size bound");
  if (kind !== "directory" && stat.nlink !== 1)
    fail("Candidate storage executable/runtime files must have exactly one hard link");
  if (kind === "directory" && (stat.mode & 0o022) !== 0)
    fail("Candidate storage runtime directories must not be group/world writable");
  if (stat.uid !== (NodeProcess.getuid?.() ?? -1) && stat.uid !== 0)
    fail("Candidate storage executable/runtime files must be operator-owned or root-owned");
  if (kind === "file" && !(stat.mode & 0o111))
    fail("Candidate storage executable is not executable");
  if (
    kind !== "directory" &&
    kind !== "manifest" &&
    stat.uid === (NodeProcess.getuid?.() ?? -1) &&
    stat.mode & 0o200
  )
    fail("Candidate storage executable/runtime files must be read-only to the server user");
  try {
    NodeFS.accessSync(path, NodeFS.constants.W_OK);
    fail("Candidate storage executable/runtime path is writable by the server user");
  } catch (cause) {
    if (cause instanceof ForkGithubCandidateStorageTrustError) throw cause;
  }
  if (kind === "file" || kind === "library") {
    const fd = NodeFS.openSync(path, "r");
    try {
      const magic = Buffer.alloc(4);
      NodeFS.readSync(fd, magic, 0, 4, 0);
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
        fail("Candidate storage tools and runtime files must be ELF binaries, not scripts");
    } finally {
      NodeFS.closeSync(fd);
    }
  }
  return stat;
};

const verifyLoaderResolvesOnlyPinnedLibraries = (
  loaderPath: string,
  libraryDirectory: string,
  executablePath: string,
  allowedFiles: ReadonlySet<string>,
) => {
  let output = "";
  try {
    output = NodeChildProcess.execFileSync(
      loaderPath,
      ["--library-path", libraryDirectory, "--list", executablePath],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        env: { LANG: "C", LC_ALL: "C", PATH: "", LD_LIBRARY_PATH: libraryDirectory },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    fail("Pinned loader could not resolve a configured candidate storage executable");
  }
  for (const line of output.split("\n")) {
    if (!line.trim() || line.includes("linux-vdso.so")) continue;
    const resolved = /=>\s+(\S+)/.exec(line)?.[1];
    if (!resolved || NodePath.dirname(resolved) !== libraryDirectory || !allowedFiles.has(resolved))
      fail("Candidate storage executable would resolve a library outside its pinned closure");
  }
};

const verifyDirectExecRuntime = (
  loader: VerifiedStorageFile,
  libraries: ReadonlyArray<VerifiedStorageFile>,
  executablePath: string,
) => {
  const bytes = NodeFS.readFileSync(executablePath);
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  )
    fail("Setuid candidate storage helper must be a little-endian 64-bit ELF executable");
  const programHeaderOffset = Number(bytes.readBigUInt64LE(32));
  const programHeaderSize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  if (programHeaderOffset + programHeaderSize * programHeaderCount > bytes.length)
    fail("Setuid candidate storage helper has malformed ELF program headers");
  let interpreter: string | undefined;
  for (let index = 0; index < programHeaderCount; index++) {
    const offset = programHeaderOffset + index * programHeaderSize;
    if (bytes.readUInt32LE(offset) !== 3) continue; // PT_INTERP
    const fileOffset = Number(bytes.readBigUInt64LE(offset + 8));
    const fileSize = Number(bytes.readBigUInt64LE(offset + 32));
    if (fileOffset + fileSize > bytes.length || fileSize > 4096)
      fail("Setuid candidate storage helper has an invalid ELF interpreter entry");
    interpreter = bytes
      .subarray(fileOffset, fileOffset + fileSize)
      .toString("utf8")
      .replace(/\0.*$/, "");
    break;
  }
  if (!interpreter || NodeFS.realpathSync(interpreter) !== loader.path)
    fail("Setuid candidate storage helper interpreter does not match the pinned system loader");
  const allowed = new Set([loader.path, ...libraries.map((file) => file.path)]);
  let output = "";
  try {
    output = NodeChildProcess.execFileSync(loader.path, ["--list", executablePath], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      env: { LANG: "C", LC_ALL: "C", PATH: "", LD_LIBRARY_PATH: "" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail("Pinned system loader could not resolve the setuid storage helper runtime");
  }
  for (const line of output.split("\n")) {
    if (!line.trim() || line.includes("linux-vdso.so")) continue;
    const resolved = /=>\s+(\S+)/.exec(line)?.[1];
    if (!resolved || !allowed.has(NodeFS.realpathSync(resolved)))
      fail("Setuid candidate storage helper resolves an unpinned system library");
  }
};

const normalizedIdentity = (manifest: ForkGithubCandidateStorageOperatorManifest) => ({
  schemaVersion: manifest.schemaVersion,
  rootDirectory: manifest.rootDirectory,
  imageBytes: manifest.imageBytes ?? null,
  inodeLimit: manifest.inodeLimit ?? null,
  hostFreeReserveBytes: manifest.hostFreeReserveBytes ?? null,
  fuse2fs: { ...manifest.fuse2fs },
  tools: Object.fromEntries(Object.entries(manifest.tools).sort(([a], [b]) => a.localeCompare(b))),
  runtime: {
    libraryDirectory: manifest.runtime.libraryDirectory,
    loader: manifest.runtime.loader,
    libraries: [...manifest.runtime.libraries].sort((a, b) => a.path.localeCompare(b.path)),
    directExec: {
      loader: manifest.runtime.directExec.loader,
      libraries: [...manifest.runtime.directExec.libraries].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    },
  },
});

const validateManifest = (
  manifestPath: string,
  raw: unknown,
): VerifiedForkGithubCandidateStorageConfiguration => {
  let manifest: ForkGithubCandidateStorageOperatorManifest;
  try {
    exactKeys(raw, [
      "schemaVersion",
      "rootDirectory",
      "imageBytes",
      "inodeLimit",
      "hostFreeReserveBytes",
      "fuse2fs",
      "tools",
      "runtime",
    ]);
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      exactKeys(value.fuse2fs, ["path", "sha256", "version", "sourceArchiveSha256", "package"]);
      exactKeys(value.tools, ["fallocate", "mke2fs", "debugfs", "dumpe2fs", "fusermount3"]);
      if (typeof value.tools === "object" && value.tools !== null && !Array.isArray(value.tools))
        for (const tool of Object.values(value.tools))
          exactKeys(tool, ["path", "sha256", "package", "version"]);
      exactKeys(value.runtime, ["libraryDirectory", "loader", "libraries", "directExec"]);
      if (
        typeof value.runtime === "object" &&
        value.runtime !== null &&
        !Array.isArray(value.runtime)
      ) {
        const runtime = value.runtime as Record<string, unknown>;
        exactKeys(runtime.loader, ["path", "sha256"]);
        exactKeys(runtime.directExec, ["loader", "libraries"]);
        if (Array.isArray(runtime.libraries))
          for (const file of runtime.libraries) exactKeys(file, ["path", "sha256"]);
        if (
          typeof runtime.directExec === "object" &&
          runtime.directExec !== null &&
          !Array.isArray(runtime.directExec)
        ) {
          const direct = runtime.directExec as Record<string, unknown>;
          exactKeys(direct.loader, ["path", "sha256"]);
          if (Array.isArray(direct.libraries))
            for (const file of direct.libraries) exactKeys(file, ["path", "sha256"]);
        }
      }
    }
    manifest = decodeManifest(raw);
  } catch {
    return fail("Candidate storage operator manifest has an invalid bounded schema");
  }
  if (
    !Array.isArray(manifest.runtime.libraries) ||
    manifest.runtime.libraries.length > MAX_RUNTIME_FILES
  )
    fail("Candidate storage runtime closure exceeds its file bound");
  const manifestFile = assertCanonicalPath(manifestPath, "manifest");
  if (manifestFile.size > MAX_MANIFEST_BYTES)
    fail("Candidate storage operator manifest exceeds its size bound");
  if (
    !NodePath.isAbsolute(manifest.rootDirectory) ||
    NodePath.normalize(manifest.rootDirectory) !== manifest.rootDirectory
  )
    fail("Candidate storage root is not a canonical absolute path");
  assertCanonicalPath(manifest.runtime.libraryDirectory, "directory");
  const rootStat = NodeFS.lstatSync(manifest.rootDirectory);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    NodeFS.realpathSync(manifest.rootDirectory) !== manifest.rootDirectory ||
    rootStat.uid !== (NodeProcess.getuid?.() ?? -1) ||
    (rootStat.mode & 0o077) !== 0
  )
    fail("Candidate storage root must be private and owned by the server user");

  const executablePaths = new Set([
    manifest.fuse2fs.path,
    ...Object.values(manifest.tools).map((tool) => tool.path),
    manifest.runtime.loader.path,
    manifest.runtime.directExec.loader.path,
  ]);
  const declaredFiles = [
    manifest.fuse2fs,
    ...Object.values(manifest.tools),
    manifest.runtime.loader,
    ...manifest.runtime.libraries,
    manifest.runtime.directExec.loader,
    ...manifest.runtime.directExec.libraries,
  ];
  const paths = new Set<string>();
  for (const file of declaredFiles) {
    if (!SHA256.test(file.sha256))
      fail("Candidate storage manifest contains an invalid SHA-256 digest");
    if (paths.has(file.path)) fail("Candidate storage manifest repeats a trusted file path");
    paths.add(file.path);
    assertCanonicalPath(file.path, executablePaths.has(file.path) ? "file" : "library");
    if (hashFile(file.path) !== file.sha256.toLowerCase())
      fail("Candidate storage executable/runtime digest does not match its operator manifest");
  }
  const runtimeDir = manifest.runtime.libraryDirectory;
  if (
    NodePath.dirname(manifest.runtime.loader.path) !== runtimeDir ||
    manifest.runtime.libraries.some((file) => NodePath.dirname(file.path) !== runtimeDir)
  )
    fail(
      "Candidate storage loader and runtime files must be inside the configured private library directory",
    );
  const runtimeNames = new Set(
    manifest.runtime.libraries.map((file) => NodePath.basename(file.path)),
  );
  if (
    runtimeNames.size !== manifest.runtime.libraries.length ||
    runtimeNames.has(NodePath.basename(manifest.runtime.loader.path))
  )
    fail("Candidate storage runtime closure contains duplicate loader names");
  const directExecPaths = new Set(manifest.runtime.directExec.libraries.map((file) => file.path));
  if (directExecPaths.size !== manifest.runtime.directExec.libraries.length)
    fail("Candidate storage direct-execution runtime contains duplicate paths");
  const allowedRuntimeFiles = new Set([
    manifest.runtime.loader.path,
    ...manifest.runtime.libraries.map((file) => file.path),
  ]);
  for (const executable of [manifest.fuse2fs, ...Object.values(manifest.tools)])
    verifyLoaderResolvesOnlyPinnedLibraries(
      manifest.runtime.loader.path,
      runtimeDir,
      executable.path,
      allowedRuntimeFiles,
    );
  verifyDirectExecRuntime(
    manifest.runtime.directExec.loader,
    manifest.runtime.directExec.libraries,
    manifest.tools.fusermount3.path,
  );

  const identityRecord = { manifestPath, ...normalizedIdentity(manifest) };
  const configurationIdentitySha256 = digest(identityRecord);
  const tools = Object.fromEntries(
    Object.entries(manifest.tools).map(([name, value]) => [name, value]),
  ) as Record<ForkGithubCandidateStorageToolName, VerifiedStorageTool>;
  return {
    manifestPath,
    rootDirectory: manifest.rootDirectory,
    ...(manifest.imageBytes === undefined ? {} : { imageBytes: manifest.imageBytes }),
    ...(manifest.inodeLimit === undefined ? {} : { inodeLimit: manifest.inodeLimit }),
    ...(manifest.hostFreeReserveBytes === undefined
      ? {}
      : { hostFreeReserveBytes: manifest.hostFreeReserveBytes }),
    tools: { ...tools, fuse2fs: { ...manifest.fuse2fs, version: manifest.fuse2fs.version } },
    runtime: manifest.runtime,
    sourceArchiveSha256: manifest.fuse2fs.sourceArchiveSha256,
    configurationIdentitySha256,
  };
};

export const inspectForkGithubCandidateStorageOperatorConfiguration = (
  manifestPath: string | undefined,
): {
  readonly configuration: VerifiedForkGithubCandidateStorageConfiguration | undefined;
  readonly reason: string | null;
} => {
  if (manifestPath === undefined) return { configuration: undefined, reason: "not configured" };
  try {
    if (!NodePath.isAbsolute(manifestPath) || NodePath.normalize(manifestPath) !== manifestPath)
      return { configuration: undefined, reason: "manifest path is not canonical" };
    const stat = NodeFS.lstatSync(manifestPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o222) !== 0 ||
      stat.size > MAX_MANIFEST_BYTES
    )
      return {
        configuration: undefined,
        reason: "manifest file is missing, writable, aliased, or too large",
      };
    const raw: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    return { configuration: validateManifest(manifestPath, raw), reason: null };
  } catch (cause) {
    return {
      configuration: undefined,
      reason: cause instanceof Error ? cause.message.slice(0, 300) : "manifest validation failed",
    };
  }
};

export const loadForkGithubCandidateStorageOperatorConfiguration = (
  manifestPath: string | undefined,
) => inspectForkGithubCandidateStorageOperatorConfiguration(manifestPath).configuration;

export const verifyForkGithubCandidateStorageConfiguration = (
  configuration: VerifiedForkGithubCandidateStorageConfiguration,
): void => {
  const loaded = loadForkGithubCandidateStorageOperatorConfiguration(configuration.manifestPath);
  const verified =
    loaded ?? fail("Candidate storage operator configuration changed after server startup");
  if (verified.configurationIdentitySha256 !== configuration.configurationIdentitySha256)
    fail("Candidate storage operator configuration changed after server startup");
  const withoutIdentity = (value: VerifiedForkGithubCandidateStorageConfiguration) => ({
    manifestPath: value.manifestPath,
    rootDirectory: value.rootDirectory,
    imageBytes: value.imageBytes ?? null,
    inodeLimit: value.inodeLimit ?? null,
    hostFreeReserveBytes: value.hostFreeReserveBytes ?? null,
    tools: value.tools,
    runtime: value.runtime,
    sourceArchiveSha256: value.sourceArchiveSha256,
  });
  if (digest(withoutIdentity(verified)) !== digest(withoutIdentity(configuration)))
    fail("Candidate storage in-memory configuration does not match its operator manifest");
};
