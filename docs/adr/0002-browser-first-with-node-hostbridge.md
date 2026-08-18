# Use a browser-first workbench with a Node HostBridge

Noxscope's first host is a browser full-tab workbench over a platform-neutral Core. Browser-accessible Adapters run in that Host, while Moth Unix/TCP access and other privileged networking stay in a loopback Node Host that streams only canonical records over a versioned HostBridge. This preserves GSD's existing development path and future desktop/CLI portability without exposing wallet sockets, credentials, or native payloads to the UI.

