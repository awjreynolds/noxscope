# Midnight wallet and runtime validation landscape

Research date: 18 August 2026

## Decision summary

Beyond GSD Wallet and Moth Wallet, Noxscope should validate against three live surfaces now:

1. **Lace browser extension** as the strongest first-party-aligned consumer-wallet target.
2. **The official Midnight Wallet SDK plus its reference harnesses** as the deterministic headless/runtime baseline, subject to access to Midnight's npm registry.
3. **1AM browser extension** as the clearest independent, purpose-built Midnight wallet, but at P1 rather than P0 while its published user base remains small and no public implementation source has been located.

**Gero Wallet should enter the matrix through a short qualification test.** Its public development repository explicitly claims Midnight support, but the current product site, published Chrome Store description, and release notes do not corroborate it. Confirm the installed production build exposes a Midnight connector and can complete a Preprod flow before treating it as a full validation target.

Urble, Turnkey, Begin, VESPR, SubWallet, Tokeo, NuFi, Keystone, and the other 2025 partner announcements should remain later or watch-list targets until a product-maintained source proves that a usable native Midnight runtime or connector exists. Midnight's ecosystem catalog is useful discovery material, but the page accepts community submissions and sometimes describes aspirations more strongly than the corresponding product currently does; catalog membership alone is not proof of an interoperable wallet implementation ([catalog](https://midnight.network/ecosystem-catalog)).

**Ctrl Wallet is a historical fixture, not a live target.** Midnight named Ctrl alongside Lace and 1AM as one of the first three compatible wallets at network launch, and Ctrl's own product material documented a browser-extension implementation with native Midnight testnet accounts, transfers, DApp connections, and transactions. Its current site now says wallet functionality ended on 3 August 2026, so Noxscope should retain a legally obtained historical build or trace corpus only if useful; it should not build a new production dependency around Ctrl. No current public repository or license for Ctrl's Midnight implementation was located ([Midnight March 2026 update](https://midnight.network/blog/state-of-the-network-march-2026), [Ctrl Midnight announcement and shutdown banner](https://ctrl.xyz/news/ctrl-wallet-now-supports-the-midnight-testnet-the-best-way-to-explore-midnight-early/)).

## What counts as a validation target

For Noxscope, “supports Midnight” should mean at least one of:

- an installable wallet registers one or more standard Midnight DApp connector providers in `window.midnight`;
- an installable wallet can manage native Midnight shielded/unshielded state and DUST, not merely a Cardano-side NIGHT token;
- a callable daemon, CLI, library, or reference app instantiates a Midnight wallet runtime and exposes enough state or operations to observe it.

The official connector is **not CIP-30**, although its injection/discovery pattern is analogous. The Midnight DApp Connector specification defines `window.midnight` as a map whose keys are freshly generated UUIDv4 discovery identifiers. Each provider record carries a stable reverse-DNS `rdns` identifier plus `apiVersion`, name, and icon; connecting for a requested network then exposes configuration, addresses, shielded/unshielded/DUST balances, transaction construction/balancing, proving, signing, and submission. Noxscope must record the transient UUID and stable `rdns` separately rather than treating the map key as a wallet name ([official connector specification](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/SPECIFICATION.md)). Cardano-only CIP-30 support under `window.cardano` does not satisfy this definition.

Likewise, holding or redeeming NIGHT on Cardano is not evidence of a Midnight wallet runtime. For example, NuFi's first-party redemption guide requires a Cardano account and ADA transaction fees and says the redeemed NIGHT appears in that Cardano account ([NuFi redemption guide](https://support.nu.fi/support/solutions/articles/80001190528)).

## Immediate targets

### 1. Lace browser extension — full validation target

**Status.** Available and actively released. Lace's public repository describes Lace as a multi-chain wallet for Cardano, Bitcoin, and Midnight, links the extension stores, publishes release-tagged source snapshots, and is Apache-2.0 licensed ([Lace repository](https://github.com/input-output-hk/lace)). Recent extension release notes contain Midnight-specific fixes and improvements, including DApp account selection, cNIGHT DUST designation progress, and designation transactions appearing in activity ([Lace releases](https://github.com/input-output-hk/lace/releases)). Official Midnight example applications require the Lace browser extension for their UI flows and document Preview/Preprod use ([bulletin-board example](https://github.com/midnightntwrk/example-bboard)).

**Architecture and integration surface.** Browser extension with the standard Midnight DApp Connector. Noxscope should discover Lace through `window.midnight`, record the transient discovery UUID, stable provider `rdns`, and API version rather than hard-code them, and exercise connector configuration, state queries, proving, balancing, and submission. The public source mirror is especially valuable for mapping extension contexts and locating observability seams.

**Networks.** Official Midnight compatibility material publishes Lace proof-service endpoints for Preview, Preprod, and Mainnet ([compatibility matrix](https://github.com/midnightntwrk/midnight-sdk/blob/main/COMPATIBILITY.md)). The official local-development tool also states that Lace's `Undeployed` setting points to the standard local node, indexer, and proof-server ports ([midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev)). Because separate examples have historically differed in local-Lace support, network capability must be discovered from the installed Lace version rather than assumed.

**Why it matters.** Lace is the ecosystem's reference consumer-wallet experience and is directly used by official DApp examples. It gives Noxscope a production extension lifecycle, an open source implementation, the standard connector, shielded/unshielded/DUST behavior, and real proving infrastructure.

### 2. 1AM browser extension — live P1 validation target

**Status.** Available, but with a small current store footprint. The Chrome Web Store lists a Webisoft-published 1AM extension described as a Midnight wallet with DApp connector support; at the research date the listing reports version 6.2.13, updated 7 August 2026, and 30 users ([Chrome Web Store listing](https://chromewebstore.google.com/detail/1am/bphnkdkcnfhompoegfpgnkidcjfbojjp)). The product site calls the browser extension live, describes NIGHT/DUST and shielded transaction support, and explicitly states that it implements Midnight DApp Connector v4 ([1AM product site](https://1am.xyz/)). Midnight's May 2026 network update also describes an ecosystem sprint centered on 1AM proof generation and shielded-by-default flows ([Midnight State of the Network, May 2026](https://midnight.network/blog/state-of-the-network-may-2026)).

**Architecture and integration surface.** Chromium/Firefox-style browser extension exposing standard DApp Connector v4. The vendor describes in-browser WASM proving plus a hosted “Proof Station” proving service. Noxscope should treat local and delegated proving as distinct capabilities because their timing, failure, privacy, and network traces differ materially.

**Networks.** The first-party Android store listing states Mainnet, Preview, and Preprod support and Cardano mainnet bridging ([Google Play listing](https://play.google.com/store/apps/details?id=com.webisoft.oneam)). Confirm the exact network set in the extension build during qualification; product pages contain some stale/contradictory mobile availability copy, so platform claims should not be projected from one build to another.

Treat the browser extension, Android app, and any verifiable iOS build as separate runtime tracks. The Android listing does not prove that the extension exposes the same networks or proving path, and an iOS build should not enter automation until its current first-party store listing or installable binary and integration surface can be verified.

**Source and license.** No public repository or open-source license for the wallet implementation was located. The product site carries an “all rights reserved” footer. Treat it as a black-box connector target unless Webisoft supplies source or a diagnostic interface.

**Why it matters.** 1AM is the strongest independent implementation and differs architecturally from Lace, especially around proving-as-a-service and its purpose-built Midnight UX. That makes it more valuable than testing another skin over the same extension assumptions.

### 3. Official Midnight Wallet SDK/runtime — deterministic baseline

**Status.** Available, public, and Apache-2.0 licensed. The official repository implements the Midnight Wallet Specification and contains a facade, shielded, unshielded, DUST, runtime, HD derivation, indexer/node/prover clients, capabilities, integration tests, and an executable specification reference that generates and verifies test vectors ([Midnight Wallet SDK](https://github.com/midnightntwrk/midnight-wallet)).

**Architecture and integration surface.** TypeScript/JavaScript library rather than a consumer wallet. Instantiate the facade/runtime directly and add a small Noxscope adapter or test harness around its observable streams and operations. The official local-development tool provides a practical deterministic environment and itself instantiates `WalletFacade` to sync, transfer NIGHT, and register DUST ([midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev)). The official wallet DApp is a further browser/reference harness for wallet flows ([midnight-wallet-dapp](https://github.com/midnightntwrk/midnight-wallet-dapp)).

**Networks.** Configurable for local `undeployed`, Preview, Preprod, and Mainnet endpoints. The official compatibility matrix records compatible package families and public service endpoints, but it was last explicitly dated 7 April 2026; Noxscope should capture runtime/package/ledger versions in every trace instead of freezing those values in code ([compatibility matrix](https://github.com/midnightntwrk/midnight-sdk/blob/main/COMPATIBILITY.md)).

**Access constraint.** The SDK setup depends on packages served from Midnight's npm registry. Treat the P0 baseline as conditional until CI and developer environments have authenticated registry access and can install the compatible package family; preserve a lockfile or approved artifact mirror once that access exists.

**Why it matters.** This is the reference behavioral oracle and the best place to make replayable, deterministic scenarios. It is not an independent wallet UX, so passing against it cannot replace Lace/1AM testing, but it can distinguish a Noxscope adapter bug from consumer-wallet behavior.

### 4. Gero Wallet — qualify now, promote if the production connector works

**Status.** Credible development evidence, but production support is unverified. Gero's public development repository describes v2.7.0 as a Chrome Manifest V3 wallet for Cardano, Midnight, and Apex Fusion, and explicitly claims shielded transfers, NIGHT/DUST management, a proof server, and a proving-consent flow; the repository is Apache-2.0 licensed ([Gero repository](https://github.com/Gero-Labs/gerowallet)). However, the installable Chrome Store build available at the research date is v2.6.3 and its description is Cardano-centric ([Gero Chrome Store listing](https://chromewebstore.google.com/detail/gero-dashboard/bgpipimickeadkjlklgciifhnalhdjhe)); Gero's current release notes likewise do not mention Midnight ([release notes](https://gerowallet.io/download/release-notes/)). The product download page describes Gero as a Cardano wallet, so it does not independently corroborate the development branch's Midnight claims ([Gero download page](https://gerowallet.io/download/)).

**Architecture and integration surface.** Manifest V3 extension with background service worker, content/injected scripts, IndexedDB, a Gero backend/Nexus data layer, and Gero Sync WebSockets. The public architecture document only specifies Cardano's CIP-30 `window.cardano` surface, while the README's Midnight section does not document a `window.midnight` implementation ([architecture](https://github.com/Gero-Labs/gerowallet/blob/development/ARCHITECTURE.md)).

**Networks.** The repository recommends Preprod for development testing. Exact native Midnight Mainnet/Preview support and connector API version were not found in current first-party documentation.

**Qualification gate.** Install the production extension in an isolated browser profile and record: whether `window.midnight` contains a provider whose stable `rdns` identifies Gero, its transient discovery UUID and advertised API version, successful `connect('preprod')`, `getConfiguration()`, address/balance queries, and one harmless signed/submitted Preprod transaction. If these pass, promote Gero to the immediate full matrix and instrument its backend/WebSocket dependencies. If not, keep it as a source-level future target.

## Later targets

### Urble — promising native mobile wallet, inaccessible integration surface

Midnight's catalog says Urble can hold, send, and receive shielded Midnight tokens with selective disclosure and calls it the first such mobile app ([ecosystem catalog](https://midnight.network/ecosystem-catalog)). Urble's own current site offers a downloadable savings application but describes Bitcoin and ZCHF as live, with ETH and ADA later, and does not mention Midnight ([Urble product site](https://urble.io/)). No public wallet repository, connector/API documentation, license, or explicit Midnight network matrix was located.

Urble is a useful future mobile/embedded contrast to browser extensions, but Noxscope should first obtain a verifiable Midnight-enabled build and an automation or deep-link/API surface. Until then it is not an executable interoperability target.

### Turnkey embedded wallets — announced infrastructure, not yet a Midnight runtime target

The Midnight Foundation announced a May 2026 partnership to combine Turnkey's API-first non-custodial key management and front-end SDKs with Midnight ([first-party announcement](https://midnight.network/blog/turnkey-partners-with-midnight-foundation)). Current Turnkey documentation and public SDK search did not reveal a Midnight-specific integration, transaction format, connector, or runnable sample. Add it when those artifacts appear; it would test an important embedded/TEE architecture that is materially different from extension wallets.

### Begin Wallet — explicitly coming soon

Begin's current product site lists “Coming soon: Midnight Network support” ([Begin](https://begin.is/)). That is clear roadmap evidence, not an available native implementation. Revisit when a release note, store listing, connector documentation, or source implementation names Midnight.

## Watch list and non-native integrations

The Midnight Foundation's April 2025 wallet announcement named Lace, SubWallet, NuFi, VESPR, Gero, Tokeo, Keystone, Yoroi, and Begin as future self-custody integrations ([announcement](https://midnight.network/blog/looking-ahead-to-midnight-self-custody-wallet-integrations)). At the research date, first-party product evidence supports the following narrower conclusions. No public source repository or license for a **native Midnight implementation** was located for any entry in this table; that does not imply that the candidate's non-Midnight wallet code is unavailable.

| Candidate | What is actually evidenced | Noxscope disposition |
| --- | --- | --- |
| **VESPR** | Installable Cardano wallet on mobile and browsers; current docs do not document a native Midnight runtime ([download docs](https://docs.vespr.xyz/vespr/user-guide/getting-started/download-vespr)). | Watch for a Midnight-enabled release and `window.midnight` API. Do not count existing CIP-30 behavior as Midnight validation. |
| **SubWallet** | Installable multi-network Polkadot/EVM wallet; no current first-party Midnight connector/runtime documentation located ([SubWallet docs](https://docs.subwallet.app/)). | Watch only. |
| **Tokeo** | Current first-party site advertises Sui, Bitcoin, and Cardano rather than Midnight ([Tokeo](https://tokeo.io/)). | Announced but unverified; watch only. |
| **NuFi** | Implements Cardano-side NIGHT eligibility, claim, mining, redemption, and message-signing flows ([claim guide](https://support.nu.fi/support/solutions/articles/80001181779-how-to-claim-night-tokens-in-midnight-network-s-airdrop), [redemption guide](https://support.nu.fi/support/solutions/articles/80001190528)). | Optional cross-chain NIGHT/address/signature tests, not native wallet-runtime interoperability. |
| **Keystone** | Lists NIGHT as a supported asset, but that does not establish shielded Midnight state, DUST, or the Midnight connector ([supported assets](https://keyst.one/supported-crypto-assets/)). | Later hardware-signing validation through a native host wallet; not a standalone Midnight runtime target today. |
| **Blockchain.com** | Midnight's catalog specifically describes NIGHT eligibility/redemption, not native wallet functionality ([catalog](https://midnight.network/ecosystem-catalog)). | Airdrop/redemption only. |
| **Yoroi** | Implemented Cardano-side NIGHT redemption, but EMURGO now says Yoroi is winding down ([Yoroi home](https://www.yoroi-wallet.com/)). | Exclude from new native adapter work; preserve only historical/cardano-side fixtures if valuable. |

## Practical validation matrix

Run a small common suite first, then wallet-specific diagnostics. Capability discovery must determine what proceeds beyond the common suite.

| Priority | Target | Surface | First network | Required common checks | Distinctive checks |
| --- | --- | --- | --- | --- | --- |
| P0, conditional | Official Wallet SDK + local stack | Direct library/runtime | `undeployed` local | registry/package access; deterministic seed/address vectors; sync; shielded/unshielded/DUST balances; build/prove/balance/sign/submit; restart/recovery | ground-truth event ordering, version capture, fault injection, replay |
| P0 | Lace extension | UUID-keyed provider in `window.midnight`; stable `rdns` in provider record | Preprod, then local/Preview/Mainnet as advertised | discovery; API semver; authorization; configuration; addresses/balances; transfer; contract transaction; error/cancel paths | MV3/service-worker lifecycle, local vs hosted prover, sync interruption, source-correlated telemetry |
| P1 | 1AM extension | DApp Connector v4 | Preprod | same connector suite as Lace | in-browser vs Proof Station proving, delegated-prover latency/failure/privacy boundary, shielded-by-default behavior; repeat as adoption grows |
| P1 gate | Gero production extension | discover connector; do not assume CIP-30 is enough | Preprod | presence/API version/configuration/balance/one transaction | Nexus and Gero Sync dependencies, background-worker restart, IndexedDB state |
| P2 | 1AM Android | Native mobile app; automation/integration surface TBD | verify in installed build | installability; native Midnight account; advertised networks; send/receive; restore | Android lifecycle, local/delegated proving, bridge boundary, background/resume behavior |
| Watch gate | 1AM iOS | Native mobile app; availability and integration surface TBD | TBD | current first-party store listing or installable build first | iOS lifecycle, local/delegated proving, platform parity |
| P2 | Urble | mobile/deep link/API unknown | TBD | installability and native Midnight account proof first | mobile lifecycle, offline/restore, embedded proving |
| P2 | Turnkey | API/SDK embedded wallet | TBD | published Midnight sample and transaction flow first | TEE/remote-signing boundary, policy engine, embedded onboarding |
| Historical only | Ctrl | Former browser-extension runtime | archived testnet fixtures only | preserve provider/transaction fixtures if lawfully retained; no live dependency | regression coverage for a now-discontinued independent implementation |
| Watch | Begin, VESPR, SubWallet, Tokeo | TBD | TBD | a product-maintained Midnight release or connector is the admission gate | add only once the native surface is public and executable |

### Common connector assertions

For every extension wallet, Noxscope should record rather than assume:

- every discovered `window.midnight` UUIDv4 map key and the provider record's stable `rdns`, name, icon origin, and `apiVersion`;
- requested and connected network IDs, plus node/indexer/WebSocket URIs and the optional `proverServerUri` or proving-provider surface exposed by the connected API;
- authorization timing, rejection, disconnect, reconnect, locked-wallet, and extension-restart behavior;
- shielded, unshielded, and DUST addresses and balances, with explicit capability/unavailable results;
- sync progress or the best observable proxy, including cold start, restore, rescan, stalled indexer, and reorg behavior;
- transfer/intent creation, sealed and unsealed balancing, proof generation, signing, submission, acknowledgement, confirmation, retry, cancellation, and errors;
- exact wallet, connector, wallet-SDK, ledger/runtime, node, indexer, and prover versions whenever observable;
- all network requests and WebSocket exchanges with secrets and private payloads redacted by policy.

## Unresolved facts to close with hands-on qualification

1. The stable provider `rdns` values and connector API versions exposed by the current Lace, 1AM, and prospective Gero production builds; the discovery UUIDs are intentionally ephemeral and should only be captured per session.
2. Whether all claimed networks are enabled in each current browser-extension build, especially Lace/Gero local `undeployed` and Gero Mainnet.
3. Whether 1AM's browser extension performs proving locally, delegates it, or selects dynamically for each operation, and what telemetry is safely observable at that boundary.
4. Whether the current Chrome Store Gero build actually contains the Midnight implementation described by the v2.7 development repository.
5. Whether Urble has a publicly obtainable Midnight-enabled build or integration contract despite the absence of Midnight content on its current product site.
6. Whether Turnkey has a private beta or unpublished Midnight SDK that should be included through a partner qualification rather than public automation.
7. The source/license status of 1AM and Urble wallet implementations.

These should become short qualification tasks, not architecture assumptions.
