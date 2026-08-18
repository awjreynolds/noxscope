# GSD Adapter fixtures

These are minimal native-wire examples for the audited GSD worker/GSD Connect
seam at `3ec1b1ffd21c371cf769fe1c49e38f837a0f9255`. They are inputs to the
Adapter, not recordings. The conformance tests add the bounded oversize case
in memory so a large hostile value is never committed to the repository.

Each fixture is expected to be handled as follows:

| Fixture               | Expected observation                                       |
| --------------------- | ---------------------------------------------------------- |
| `healthy.json`        | one canonical fresh state snapshot                         |
| `stalled.json`        | three independent sync domains, including a stalled domain |
| `failure.json`        | one correlated failed operation with metadata-only error   |
| `reconnect.json`      | reconnect stream-gap evidence and adapter diagnostic       |
| `hostile-secret.json` | secrets and private execution material absent from output  |
