import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Styleguide } from "./Styleguide";
import "./styleguide.css";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <Styleguide />
  </StrictMode>,
);
