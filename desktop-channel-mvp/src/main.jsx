import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./styles/conversation.css";
import "./styles/pet-status.css";

document.documentElement.classList.toggle("desktop-runtime", Boolean(window.desktopChannel));

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
