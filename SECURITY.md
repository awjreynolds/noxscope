# Security policy

Noxscope is a local-first developer tool. It is not a custody product and
must not receive seed phrases, private/viewing keys, credentials, wallet
vaults, raw transactions, witnesses, proofs, signatures, or proving material.
The canonical sanitiser and Recording importer are deny-by-default boundaries,
but they cannot secure a secret that was already persisted by a wallet,
browser, logger, operating system, debugger, clipboard, or compromised host.

## Reporting

Do not open a public issue for a suspected vulnerability. Send a minimal
report to the repository security contact configured by the maintainers, or
use GitHub's private security advisory flow. Do not include real wallet data;
use a synthetic fixture and describe the smallest reproduction. Encrypt the
report if the maintainers provide a key.

Include the affected commit/version, package and entry point, reproducible
steps, impact, and whether the issue can cause secret disclosure, code or
network execution, denial of service, integrity loss, or an unsafe
compatibility claim.

## Safe defaults

- Bind HostBridge to loopback and exact origins only.
- Keep Moth TCP read-only and authenticated; prefer its Unix socket.
- Treat every runtime payload and imported Recording as hostile.
- Keep Recording export/import local and explicit; compressed archives and
  unsafe captures are unsupported.
- Use dedicated localnet or disposable Preprod identities; never test with
  real user wallets or mainnet mutation flows.

See [`docs/security/REDACTION_AND_RECORDING.md`](docs/security/REDACTION_AND_RECORDING.md)
for the full trust boundary and [`docs/RELEASE_ACCEPTANCE.md`](docs/RELEASE_ACCEPTANCE.md)
for release gates.
