# Choose the first-release host and runtime topology

Type: grilling
Status: open
Blocked by: 01, 02

## Question

What browser/full-tab host composition, platform-service boundary, adapter lifecycle, and local/remote transport topology lets Noxscope reuse GSD safely, observe extension and daemon runtimes simultaneously, avoid direct `chrome.*` dependencies in core/UI code, and remain portable to a future desktop or CLI host?

