# Conformance fixtures

The fixture catalog contains deterministic connector-shaped inputs and target
provenance for the official Wallet SDK, Lace, 1AM, Gero, and the Moth
extension. It is regression material, not a compatibility claim. The runner
must be given `evidence: "exercised"` and a live isolated target before it can
admit `full` or `connector`.

Fixtures contain no wallet seeds, credentials, transaction bytes, proofs,
witnesses, signatures, or user addresses. The 1AM and Gero entries are
labelled `non-live-qualification` because their public evidence does not
establish a current executable target. The Moth connector fixture is separate
from the Moth daemon fixture and must never be used to infer daemon health.
