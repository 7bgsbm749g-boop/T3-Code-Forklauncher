// @effect-diagnostics nodeBuiltinImport:off - local credential provisioning needs no-follow file reads and stdin.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const APP_ID_NAME = "fork-github-app-id";
const INSTALLATION_ID_NAME = "fork-github-installation-id";
const PRIVATE_KEY_NAME = "fork-github-app-private-key";
const MAX_ID_BYTES = 64;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export class ForkGithubCredentialInputError extends Schema.TaggedError<ForkGithubCredentialInputError>()(
  "ForkGithubCredentialInputError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
export const isCredentialInputError = Schema.is(ForkGithubCredentialInputError);

const appIdFileFlag = Flag.string("app-id-file").pipe(
  Flag.withDescription("File containing the numeric GitHub App id (mode 0600)."),
);
const installationIdFileFlag = Flag.string("installation-id-file").pipe(
  Flag.withDescription("File containing the numeric installation id (mode 0600)."),
);
const privateKeyFileFlag = Flag.string("private-key-file").pipe(
  Flag.withDescription("File containing the downloaded PEM private key (mode 0600)."),
  Flag.optional,
);
const privateKeyStdinFlag = Flag.boolean("private-key-stdin").pipe(
  Flag.withDescription(
    "Read the PEM private key from stdin until EOF; do not pass it as an argument.",
  ),
  Flag.withDefault(false),
);
const homeDirFlag = Flag.string("home-dir").pipe(
  Flag.withDescription(
    "Required explicit T3 home. Use an isolated disposable home, never the live home.",
  ),
);

const readPrivateFile = async (
  filePath: string,
  maxBytes: number,
  platform: string,
): Promise<Uint8Array> => {
  if (platform === "win32" || NodeFSP.constants.O_NOFOLLOW === undefined) {
    throw new ForkGithubCredentialInputError({
      reason: "Credential provisioning requires a platform with no-follow file opens.",
    });
  }
  let file: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
  try {
    file = await NodeFSP.open(
      NodePath.resolve(filePath),
      NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK,
    );
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > maxBytes || (stats.mode & 0o077) !== 0) {
      throw new ForkGithubCredentialInputError({
        reason: "Credential input must be a bounded regular file with mode 0600 or stricter.",
      });
    }
    if (stats.uid !== NodeOS.userInfo().uid) {
      throw new ForkGithubCredentialInputError({
        reason: "Credential input must be owned by the current user.",
      });
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new ForkGithubCredentialInputError({
        reason: "Credential input exceeded its size limit.",
      });
    }
    return Uint8Array.from(bytes.subarray(0, offset));
  } catch (error) {
    if (isCredentialInputError(error)) throw error;
    throw new ForkGithubCredentialInputError({ reason: "Could not safely read credential input." });
  } finally {
    await file?.close().catch(() => undefined);
  }
};

export const readBoundedChunks = async (
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> => {
  const parts: Array<Uint8Array> = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new ForkGithubCredentialInputError({
        reason: "Credential input exceeded its size limit.",
      });
    }
    parts.push(Uint8Array.from(chunk));
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const readStdin = async (maxBytes: number): Promise<Uint8Array> => {
  if (process.stdin.isTTY) {
    throw new ForkGithubCredentialInputError({
      reason: "Private-key stdin must be piped and end with EOF.",
    });
  }
  try {
    return await readBoundedChunks(process.stdin, maxBytes);
  } catch (error) {
    if (isCredentialInputError(error)) throw error;
    throw new ForkGithubCredentialInputError({ reason: "Could not read private-key stdin." });
  }
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ForkGithubCredentialInputError({ reason: "Credential input must be valid UTF-8." });
  }
};

const validateId = (bytes: Uint8Array, label: string): Uint8Array => {
  const text = decodeUtf8(bytes).trim();
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new ForkGithubCredentialInputError({
      reason: `${label} must contain a positive numeric id.`,
    });
  }
  return Buffer.from(text, "utf8");
};

const validatePrivateKey = (bytes: Uint8Array): Uint8Array => {
  const pem = decodeUtf8(bytes).trim();
  let key: NodeCrypto.KeyObject;
  try {
    key = NodeCrypto.createPrivateKey(pem);
  } catch {
    throw new ForkGithubCredentialInputError({
      reason: "Private key is not a valid unencrypted PEM key.",
    });
  }
  const keySize = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== "rsa" || keySize === undefined || keySize < 2048) {
    throw new ForkGithubCredentialInputError({
      reason: "Private key must be RSA with at least 2048 bits.",
    });
  }
  return Buffer.from(`${pem}\n`, "utf8");
};

const resolveSafeHome = async (
  homeDir: string,
  configuredHome: string | undefined,
): Promise<string> => {
  if (homeDir.trim().length === 0 || !NodePath.isAbsolute(homeDir)) {
    throw new ForkGithubCredentialInputError({
      reason: "Explicit T3 home must be an absolute path to a disposable directory.",
    });
  }
  try {
    const canonicalHome = await NodeFSP.realpath(NodePath.resolve(homeDir));
    const stats = await NodeFSP.stat(canonicalHome);
    if (!stats.isDirectory() || stats.uid !== NodeOS.userInfo().uid || (stats.mode & 0o022) !== 0) {
      throw new ForkGithubCredentialInputError({
        reason: "Explicit T3 home must be owned by the current user and not group/world writable.",
      });
    }
    const blocked = [NodePath.join(NodeOS.homedir(), ".t3"), configuredHome]
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .map((value) => NodePath.resolve(value));
    for (const blockedPath of blocked) {
      const canonicalBlocked = await NodeFSP.realpath(blockedPath).catch(() => blockedPath);
      if (canonicalHome === canonicalBlocked) {
        throw new ForkGithubCredentialInputError({
          reason:
            "Refusing to provision the default or configured T3 home; choose a disposable home.",
        });
      }
    }
    for (const path of [
      NodePath.join(canonicalHome, "userdata"),
      NodePath.join(canonicalHome, "userdata", "secrets"),
    ]) {
      try {
        const pathStats = await NodeFSP.lstat(path);
        if (
          pathStats.isSymbolicLink() ||
          !pathStats.isDirectory() ||
          pathStats.uid !== NodeOS.userInfo().uid ||
          (pathStats.mode & 0o022) !== 0
        ) {
          throw new ForkGithubCredentialInputError({
            reason: "T3 home storage path must not contain symlinks or non-directory entries.",
          });
        }
      } catch (error) {
        if (isCredentialInputError(error)) throw error;
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw new ForkGithubCredentialInputError({
            reason: "Could not verify T3 home storage paths.",
          });
        }
      }
    }
    try {
      await NodeFSP.lstat(NodePath.join(canonicalHome, "userdata", "state.sqlite"));
      throw new ForkGithubCredentialInputError({
        reason: "Refusing a T3 home that already has a database; use a fresh disposable home.",
      });
    } catch (error) {
      if (isCredentialInputError(error)) throw error;
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw new ForkGithubCredentialInputError({
          reason: "Could not verify that the selected T3 home is unused.",
        });
      }
    }
    return canonicalHome;
  } catch (error) {
    if (isCredentialInputError(error)) throw error;
    throw new ForkGithubCredentialInputError({
      reason: "Explicit T3 home must be an existing directory.",
    });
  }
};

const rejectExistingCredentials = async (homeDir: string): Promise<void> => {
  const secretsDir = NodePath.join(homeDir, "userdata", "secrets");
  try {
    for (const name of [APP_ID_NAME, INSTALLATION_ID_NAME, PRIVATE_KEY_NAME]) {
      try {
        await NodeFSP.lstat(NodePath.join(secretsDir, `${name}.bin`));
        throw new ForkGithubCredentialInputError({
          reason: "At least one GitHub App credential already exists; use a fresh disposable home.",
        });
      } catch (error) {
        if (isCredentialInputError(error)) throw error;
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw new ForkGithubCredentialInputError({
            reason: "Could not verify that the selected T3 home has no App credentials.",
          });
        }
      }
    }
  } catch (error) {
    if (isCredentialInputError(error)) throw error;
    throw new ForkGithubCredentialInputError({
      reason: "Could not verify that the selected T3 home has no App credentials.",
    });
  }
};

const provisionCredentials = Effect.fn("cli.fork_github.provision_credentials")(function* (input: {
  readonly homeDir: string;
  readonly appId: Uint8Array;
  readonly installationId: Uint8Array;
  readonly privateKey: Uint8Array;
}) {
  const derivedPaths = yield* ServerConfig.deriveServerPaths(input.homeDir, undefined, {
    baseDirIsExplicit: true,
  });
  const config = ServerConfig.make({
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 1024 * 1024,
    traceMaxFiles: 2,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-fork-github-provision",
    otlpHeaders: undefined,
    otlpProtocol: "http/json",
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: input.homeDir,
    baseDir: input.homeDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  });
  return yield* Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const names = [APP_ID_NAME, INSTALLATION_ID_NAME, PRIVATE_KEY_NAME] as const;
    const current = yield* Effect.all(names.map((name) => store.get(name)));
    if (current.some(Option.isSome)) {
      return yield* new ForkGithubCredentialInputError({
        reason: "At least one GitHub App credential already exists; use a fresh disposable home.",
      });
    }
    yield* store.create(APP_ID_NAME, input.appId);
    yield* store.create(INSTALLATION_ID_NAME, input.installationId);
    yield* store.create(PRIVATE_KEY_NAME, input.privateKey);
    yield* Console.log("GitHub App credentials were stored in the selected T3 home.");
  }).pipe(Effect.provide(ServerSecretStore.layer.pipe(Layer.provide(ServerConfig.layer(config)))));
});

const provisionCommand = Command.make("provision", {
  homeDir: homeDirFlag,
  appIdFile: appIdFileFlag,
  installationIdFile: installationIdFileFlag,
  privateKeyFile: privateKeyFileFlag,
  privateKeyStdin: privateKeyStdinFlag,
}).pipe(
  Command.withDescription(
    "Store GitHub App credentials locally in an explicit disposable T3 home.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const environment = yield* HostProcessEnvironment;
      return yield* Effect.tryPromise({
        try: async () => {
          if (Option.isSome(flags.privateKeyFile) === flags.privateKeyStdin) {
            throw new ForkGithubCredentialInputError({
              reason: "Choose exactly one of --private-key-file and --private-key-stdin.",
            });
          }
          const homeDir = await resolveSafeHome(flags.homeDir, environment["T3CODE_HOME"]);
          const [rawAppId, rawInstallationId] = await Promise.all([
            readPrivateFile(flags.appIdFile, MAX_ID_BYTES, platform),
            readPrivateFile(flags.installationIdFile, MAX_ID_BYTES, platform),
          ]);
          const appId = validateId(rawAppId, "App id");
          const installationId = validateId(rawInstallationId, "Installation id");
          const rawPrivateKey = Option.isSome(flags.privateKeyFile)
            ? await readPrivateFile(flags.privateKeyFile.value, MAX_PRIVATE_KEY_BYTES, platform)
            : await readStdin(MAX_PRIVATE_KEY_BYTES);
          await rejectExistingCredentials(homeDir);
          return {
            homeDir,
            appId,
            installationId,
            privateKey: validatePrivateKey(rawPrivateKey),
          };
        },
        catch: (error) =>
          isCredentialInputError(error)
            ? error
            : new ForkGithubCredentialInputError({
                reason: "Could not prepare credential inputs.",
              }),
      }).pipe(Effect.flatMap(provisionCredentials));
    }),
  ),
);

export const forkGithubCredentialsCommand = Command.make("fork-github-credentials").pipe(
  Command.withDescription("Manage local GitHub App credentials for Forklauncher."),
  Command.withSubcommands([provisionCommand]),
);
