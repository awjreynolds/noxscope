# Which additional Midnight wallets should Noxscope validate?

Type: research
Status: resolved
Blocked by:

## Question

Beyond GSD and Moth, which available, announced, or historical Midnight Wallet Runtimes have a credible public integration surface that Noxscope should validate, what level of validation is justified by primary-source evidence, and in what priority order?

## Answer

Use a tiered matrix rather than treating ecosystem announcements as compatibility evidence:

- P0: the official Midnight Wallet SDK/local stack as deterministic reference runtime, conditional on npm-registry access; Lace as the strongest open-source consumer-extension target.
- P1: 1AM's live browser extension as an independent black-box connector target; Gero behind a hands-on production-extension qualification gate.
- P2/later: separate 1AM mobile runtimes, Urble, and Turnkey once an installable build or callable Midnight interface is available.
- Watch: Begin, VESPR, SubWallet, Tokeo, NuFi, Keystone, and other announced integrations until a product-maintained native Midnight surface exists.
- Historical only: Ctrl, whose wallet functionality ended on 3 August 2026.

For extension wallets, discover UUIDv4 keys under `window.midnight`, retain the stable provider `rdns` separately, negotiate the advertised API version, and test only capabilities actually exposed. Cardano CIP-30 support or holding Cardano-side NIGHT does not establish a native Midnight Wallet Runtime.

Research: [Midnight wallet and runtime validation landscape](../../../docs/research/midnight-wallet-landscape.md)

