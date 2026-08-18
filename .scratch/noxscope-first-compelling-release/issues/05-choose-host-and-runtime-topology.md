# Choose the first-release host and runtime topology

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

What browser/full-tab host composition, platform-service boundary, adapter lifecycle, and local/remote transport topology lets Noxscope reuse GSD safely, observe extension and daemon runtimes simultaneously, avoid direct `chrome.*` dependencies in core/UI code, and remain portable to a future desktop or CLI host?

## Answer

Use a browser-first full-tab Host over platform-neutral Core/UI. Connect GSD and standard connectors directly; place Moth Unix/TCP and privileged networking in a loopback Node Host that streams only canonical descriptors and Records through a versioned HostBridge WebSocket. Hosts own platform services and Recorder implementations; Adapters own native transports and lifecycle. One Runtime Session observes one runtime, and multiple sessions remain independently ordered.

Decision: [First-release host and runtime topology](../../../docs/architecture/HOST_TOPOLOGY.md) and [Use a browser-first workbench with a Node HostBridge](../../../docs/adr/0002-browser-first-with-node-hostbridge.md)
