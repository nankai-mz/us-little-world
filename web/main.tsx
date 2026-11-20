import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HostedWeb } from "./HostedWeb";
import { OfflineWeb } from "./OfflineWeb";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {document.querySelector('meta[name="us-web-offline"]') ? <OfflineWeb /> :
      document.querySelector('meta[name="us-web-hosted"]') ? <HostedWeb /> : <App />}
  </React.StrictMode>,
);
