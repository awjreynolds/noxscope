# Contributing to Noxscope

Noxscope is an Apache-2.0, local-first developer tool. Contributions should
preserve the canonical protocol boundary and the promise that a Noxscope
Recording contains no wallet secrets or private execution material.

## Before opening a change

1. Read the relevant architecture, security, provenance, and conformance
   documents.
2. Keep wallet-specific transport and types inside an Adapter or Host. Core
   and the browser UI consume canonical types only.
3. Add a focused test for every behavior change, including hostile input and
   cancellation/timeout paths where relevant.
4. Use synthetic identities and fixture data. Never commit a token, seed,
   address belonging to a real user, or exported wallet state.

Run the local gates:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` does not contact wallets, networks, registries, or cloud
services after dependencies are installed. Runtime qualification belongs in
separate, explicitly scoped localnet/Preprod evidence and must not be implied
by fixture tests.

## Pull requests

Describe the contract changed, evidence added, resource limits considered,
and any compatibility claim with exact runtime/build/network evidence. Keep
provenance rows current when source or wire behavior is copied or transformed.
Do not bundle unrelated formatting or generated `dist/` output. A fresh
reviewer should audit agent-produced code before integration.

## Licensing

New contributions are Apache-2.0 unless a separate written agreement says
otherwise. Preserve existing SPDX, copyright, NOTICE, and third-party license
boundaries. Do not copy Moth implementation source; the Moth Adapter targets
its public wire contract. GSD extraction requires an exact provenance row.
