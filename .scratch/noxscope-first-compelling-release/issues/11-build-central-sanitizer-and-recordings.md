# Build central sanitizer and portable Recordings

Type: task
Status: resolved
Blocked by: 06, 10

## Question

Implement the settled deny-by-default sanitizer before the Adapter seam, append-only versioned recording format, browser storage/export/import/offline inspection, resource limits, and verification tests proving forbidden material cannot cross into or re-enter Core/recording state.

## Answer

Implemented the central, versioned deny-by-default sanitizer and portable Recording v1 boundary. Capture, recorder, export, and hostile import independently validate and sanitise canonical records; framed canonical JSON carries exact adapter/policy provenance, per-frame and whole-content digests, bounded counts, and Recording-scoped HMAC pseudonyms without exporting their key. Import rejects archives, malformed or additive metadata, incompatible provenance, resource-limit violations, and secret-bearing content, then exposes immutable offline replay that cannot invoke operations.

The browser now provides a detached-byte IndexedDB store with a deterministic memory fake, quota/error handling, start/stop/finalise controls, local export/import/delete, and an explicit offline-inspection mode. Per-Recording keys come from browser cryptography and are never stored. A checked-in trusted provenance registry permits fresh sessions to open recordings from known adapters without trusting file-supplied policy. Independent review/fix cycles cover hostile getters and proxies, Unicode/encoded secrets, queue and lifecycle races, React StrictMode, object-URL cleanup, multi-runtime provenance, storage detachment, and offline operation denial. The integrated suite passes 97 tests plus typecheck, lint, formatting, and production build.
