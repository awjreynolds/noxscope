import { createMockAdapter } from "@noxscope/adapter-mock";
import { createCore } from "@noxscope/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createRecordingSession } from "./recording-session.js";
import { createIndexedDbRecordingStore } from "./recording-store.js";
import "./styles.css";

const lifetime = new AbortController();
const core = createCore({ signal: lifetime.signal });

void core.connect(createMockAdapter("healthy"));
void core.connect(createMockAdapter("stalled-sync"));
void core.connect(createMockAdapter("prover-failure"));

const element = document.getElementById("root");
if (element === null) throw new Error("Noxscope root element is missing");

createRoot(element).render(
  <StrictMode>
    <App
      core={core}
      recordingSession={createRecordingSession(core, {
        store: createIndexedDbRecordingStore(),
      })}
    />
  </StrictMode>,
);
