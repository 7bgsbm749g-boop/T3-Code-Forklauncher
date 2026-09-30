// @effect-diagnostics nodeBuiltinImport:off - test local credential files and the CLI filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";
import {
  ForkGithubCredentialInputError,
  isCredentialInputError,
  readBoundedChunks,
} from "./forkGithubCredentials.ts";

const runtimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(runtimeLayer));
const tempRoots: Array<string> = [];
const makeTemp = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-app-creds-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const writePrivate = (path: string, data: string) => {
  NodeFS.writeFileSync(path, data, { mode: 0o600 });
  NodeFS.chmodSync(path, 0o600);
};

const generatedKey = () =>
  NodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

it.effect.skipIf(windowsHost)(
  "provisions only into an explicit home and never prints supplied credentials",
  () =>
    Effect.gen(function* () {
      const root = makeTemp();
      const home = NodePath.join(root, "disposable-t3-home");
      const key = generatedKey();
      const appId = "876543210";
      const installationId = "987654321";
      NodeFS.mkdirSync(home, { mode: 0o700 });
      const appIdFile = NodePath.join(root, "app-id");
      const installationIdFile = NodePath.join(root, "installation-id");
      const keyFile = NodePath.join(root, "app-key.pem");
      writePrivate(appIdFile, `${appId}\n`);
      writePrivate(installationIdFile, `${installationId}\n`);
      writePrivate(keyFile, key);

      yield* runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        appIdFile,
        "--installation-id-file",
        installationIdFile,
        "--private-key-file",
        keyFile,
      ]);

      const secretsDir = NodePath.join(home, "userdata", "secrets");
      const storedAppId = NodeFS.readFileSync(NodePath.join(secretsDir, "fork-github-app-id.bin"));
      const storedInstallation = NodeFS.readFileSync(
        NodePath.join(secretsDir, "fork-github-installation-id.bin"),
      );
      const storedKey = NodeFS.readFileSync(
        NodePath.join(secretsDir, "fork-github-app-private-key.bin"),
      );
      assert.equal(storedAppId.toString("utf8"), appId);
      assert.equal(storedInstallation.toString("utf8"), installationId);
      assert.equal(storedKey.toString("utf8"), `${key.trim()}\n`);
      assert.equal(NodeFS.statSync(secretsDir).mode & 0o777, 0o700);
      for (const name of [
        "fork-github-app-id.bin",
        "fork-github-installation-id.bin",
        "fork-github-app-private-key.bin",
      ]) {
        assert.equal(NodeFS.statSync(NodePath.join(secretsDir, name)).mode & 0o777, 0o600);
      }
      const output = yield* TestConsole.logLines;
      const rendered = output.join("\n");
      assert.include(rendered, "credentials were stored");
      assert.notInclude(rendered, appId);
      assert.notInclude(rendered, installationId);
      assert.notInclude(rendered, "PRIVATE KEY");
      assert.notInclude(rendered, key.trim());
    }),
);

it.effect("rejects an empty home path before resolving it to the working directory", () =>
  Effect.gen(function* () {
    const root = makeTemp();
    const error = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        "",
        "--app-id-file",
        NodePath.join(root, "missing-app-id"),
        "--installation-id-file",
        NodePath.join(root, "missing-installation-id"),
        "--private-key-file",
        NodePath.join(root, "missing-key"),
      ]),
    );
    assert.include(error.message, "absolute path to a disposable directory");
  }),
);

it.effect.skipIf(windowsHost)("rejects invalid key material before creating secret storage", () =>
  Effect.gen(function* () {
    const root = makeTemp();
    const home = NodePath.join(root, "disposable-home");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    const appIdFile = NodePath.join(root, "app-id");
    const installationIdFile = NodePath.join(root, "installation-id");
    const keyFile = NodePath.join(root, "bad-key.pem");
    writePrivate(appIdFile, "12345\n");
    writePrivate(installationIdFile, "67890\n");
    writePrivate(keyFile, "not-a-private-key\n");

    const error = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        appIdFile,
        "--installation-id-file",
        installationIdFile,
        "--private-key-file",
        keyFile,
      ]),
    );

    assert.include(error.message, "not a valid unencrypted PEM key");
    assert.equal(NodeFS.existsSync(NodePath.join(home, "userdata")), false);
  }),
);

it.effect.skipIf(windowsHost)("refuses to overwrite a partially provisioned home", () =>
  Effect.gen(function* () {
    const root = makeTemp();
    const home = NodePath.join(root, "disposable-home");
    NodeFS.mkdirSync(NodePath.join(home, "userdata", "secrets"), { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(NodePath.join(home, "userdata", "secrets"), 0o750);
    writePrivate(NodePath.join(root, "app-id"), "12345\n");
    writePrivate(NodePath.join(root, "installation-id"), "67890\n");
    writePrivate(NodePath.join(root, "key.pem"), generatedKey());
    const existing = NodePath.join(home, "userdata", "secrets", "fork-github-app-id.bin");
    writePrivate(existing, "existing\n");

    const error = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        NodePath.join(root, "app-id"),
        "--installation-id-file",
        NodePath.join(root, "installation-id"),
        "--private-key-file",
        NodePath.join(root, "key.pem"),
      ]),
    );
    assert.include(error.message, "already exists");
    assert.equal(NodeFS.readFileSync(existing, "utf8"), "existing\n");
    assert.equal(NodeFS.statSync(NodePath.dirname(existing)).mode & 0o777, 0o750);
  }),
);

it.effect.skipIf(windowsHost)("refuses a home that already contains a T3 database", () =>
  Effect.gen(function* () {
    const root = makeTemp();
    const home = NodePath.join(root, "used-home");
    NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(home, "userdata", "state.sqlite"), "fixture only");
    writePrivate(NodePath.join(root, "app-id"), "12345\n");
    writePrivate(NodePath.join(root, "installation-id"), "67890\n");
    writePrivate(NodePath.join(root, "key.pem"), generatedKey());

    const error = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        NodePath.join(root, "app-id"),
        "--installation-id-file",
        NodePath.join(root, "installation-id"),
        "--private-key-file",
        NodePath.join(root, "key.pem"),
      ]),
    );

    assert.include(error.message, "already has a database");
    assert.equal(NodeFS.existsSync(NodePath.join(home, "userdata", "secrets")), false);
  }),
);

it.effect.skipIf(windowsHost)("rejects symlinked or group-readable credential files", () =>
  Effect.gen(function* () {
    const root = makeTemp();
    const home = NodePath.join(root, "disposable-home");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    const appIdFile = NodePath.join(root, "app-id");
    const installationIdFile = NodePath.join(root, "installation-id");
    const keyFile = NodePath.join(root, "key.pem");
    writePrivate(appIdFile, "12345\n");
    writePrivate(installationIdFile, "67890\n");
    writePrivate(keyFile, generatedKey());
    const symlinkFile = NodePath.join(root, "key-link.pem");
    NodeFS.symlinkSync(keyFile, symlinkFile);

    const symlinkFailure = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        appIdFile,
        "--installation-id-file",
        installationIdFile,
        "--private-key-file",
        symlinkFile,
      ]),
    );
    assert.include(symlinkFailure.message, "safely read credential input");
    assert.equal(NodeFS.existsSync(NodePath.join(home, "userdata")), false);

    NodeFS.chmodSync(appIdFile, 0o644);
    const permissionFailure = yield* Effect.flip(
      runCli([
        "fork-github-credentials",
        "provision",
        "--home-dir",
        home,
        "--app-id-file",
        appIdFile,
        "--installation-id-file",
        installationIdFile,
        "--private-key-file",
        keyFile,
      ]),
    );
    assert.include(permissionFailure.message, "mode 0600");
    assert.equal(NodeFS.existsSync(NodePath.join(home, "userdata")), false);
  }),
);

it.effect("bounds streamed private-key input without requiring a process or terminal", () =>
  Effect.gen(function* () {
    const chunks = async function* () {
      yield Buffer.from("private-");
      yield Buffer.from("key");
    };
    const collected = yield* Effect.tryPromise(() => readBoundedChunks(chunks(), 32));
    assert.equal(Buffer.from(collected).toString("utf8"), "private-key");

    const tooLarge = async function* () {
      yield Buffer.from("1234");
      yield Buffer.from("5678");
    };
    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: () => readBoundedChunks(tooLarge(), 7),
        catch: (error) =>
          isCredentialInputError(error)
            ? error
            : new ForkGithubCredentialInputError({ reason: "unexpected test input failure" }),
      }),
    );
    assert.include(failure.message, "size limit");
  }),
);
