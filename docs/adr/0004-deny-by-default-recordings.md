# Deny secret and private execution material from Recordings

Every Wallet Runtime payload is untrusted and potentially secret-bearing. Adapters must project allowlisted canonical fields and sanitise optional raw detail before it crosses the canonical seam; the Recorder, exporter, and importer repeat validation and sanitisation independently. Mnemonics, seed/key material, credentials, witnesses, proofs, signatures, and serialized transactions are forbidden even in developer mode. First-release exports are local uncompressed framed JSON with integrity digests, not encrypted containers, so the content-safety promise does not depend on a storage key or an ordinary override.

