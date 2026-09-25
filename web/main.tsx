import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./Login.tsx";
import "./app.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
