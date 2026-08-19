# Third-party notices and provenance audit

Noxscope's shipped source is Apache-2.0. The package lockfile records dependency
versions; this file records the direct runtime attribution boundary and where
to audit the complete dependency tree before distribution.

| Dependency | Used by | License/source | Treatment |
| --- | --- | --- | --- |
| React | `apps/web` | MIT, <https://github.com/facebook/react/blob/main/LICENSE> | private application dependency |
| React DOM | `apps/web` | MIT, <https://github.com/facebook/react/blob/main/LICENSE> | private application dependency |
| GSD Wallet | Adapter reference | Apache-2.0; GSD Socket reference MIT | no implementation source copied; see [`PROVENANCE.md`](../../docs/PROVENANCE.md) |
| Moth Wallet | Adapter reference | Apache-2.0 | public wire contract only; no implementation source copied |

Development tooling is not bundled by the library packages. Before publishing
a package tarball, inspect the exact lockfile dependency tree and retain each
package's license/NOTICE according to its terms. The release script verifies
that the Apache-2.0 root files, pinned upstream references, and this audit are
present; it does not pretend that a static list replaces legal review of a
changed dependency tree.
