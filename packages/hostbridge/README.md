# `@noxscope/hostbridge`

Authenticated, bounded canonical bridge between a browser Host and a Node
Host. The optional Node entry point is `@noxscope/hostbridge/node` and binds
only to loopback with an exact allowed browser origin. It carries descriptors,
canonical records, typed Results, and explicit stream gaps—not sockets, files,
shell commands, wallet credentials, or arbitrary proxy messages.

This package intentionally has no CLI. Start the bridge from a reviewed Node
Host composition with an explicit origin and pass the per-launch token through
an application-controlled channel; see [`HOST_TOPOLOGY.md`](../../docs/architecture/HOST_TOPOLOGY.md).
