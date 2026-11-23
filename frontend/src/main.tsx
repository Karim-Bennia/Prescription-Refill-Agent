import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

const mount = document.getElementById("root");
if (!mount) throw new Error("Frontend root element is missing.");
createRoot(mount).render(<App />);
