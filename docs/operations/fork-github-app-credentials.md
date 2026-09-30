# Provisioning Forklauncher App credentials

The GitHub App credentials are stored in the selected T3 home through the existing server secret store. Use this only for a disposable T3 home while preparing the later GET-only App proof. The command refuses the default `~/.t3` home, the current `T3CODE_HOME`, and any home that already contains a T3 database. It accepts no credential values in arguments, requires private input files, and does not call GitHub. Secure file provisioning currently requires a POSIX platform that supports `O_NOFOLLOW`; it fails closed on Windows.

Create a disposable home and three mode-0600 input files containing the App id, installation id, and downloaded PEM key. Then run:

```sh
mkdir -m 700 /absolute/path/to/disposable-t3-home
t3 fork-github-credentials provision \
  --home-dir /absolute/path/to/disposable-t3-home \
  --app-id-file /absolute/path/to/app-id.txt \
  --installation-id-file /absolute/path/to/installation-id.txt \
  --private-key-file /absolute/path/to/app-private-key.pem
```

Alternatively, provide the private key on stdin and omit `--private-key-file`:

```sh
cat /absolute/path/to/app-private-key.pem | t3 fork-github-credentials provision \
  --home-dir /absolute/path/to/disposable-t3-home \
  --app-id-file /absolute/path/to/app-id.txt \
  --installation-id-file /absolute/path/to/installation-id.txt \
  --private-key-stdin
```

The command validates positive numeric IDs and an unencrypted RSA private key (at least 2048 bits), limits inputs to 64 bytes / 64 KiB, rejects symlinked or group/world-accessible input files, and creates secret files exclusively with mode 0600 under a mode-0700 secret directory. It refuses to overwrite any existing App credential; use a new disposable home if a prior attempt left a partial set. It prints only a generic success message, never the IDs or key.

This command only provisions local secrets. It does not read operator configuration, contact GitHub, test credentials, alter the live server, or enable remote writes. The follow-up proof must point a separate process at this disposable home and the reviewed credential-free operator configuration, and restrict all GitHub calls to reads.
