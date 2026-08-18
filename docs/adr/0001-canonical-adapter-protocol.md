# Use one versioned Runtime Session and ordered Record protocol

Noxscope will place a dependency-free, versioned protocol seam between all Wallet Runtime Adapters and its recorder, analysis, and UI. Each Adapter exposes one Runtime Session with an ordered stream plus one request channel; the canonical core remains typed, while genuinely wallet-specific detail is namespaced and sanitised. This was chosen over wallet-shaped interfaces, which leak implementation differences into callers, and a fully schema-driven capability bus, whose governance and runtime typing cost are not yet earned by the first real GSD and Moth Adapters.

