import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";

import { App } from "./App";
import { Landing } from "./routes/Landing";
import { Marketplace } from "./routes/Marketplace";
import { World } from "./routes/World";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Landing /> },
      { path: "world", element: <World /> },
      { path: "marketplace", element: <Marketplace /> },
    ],
  },
]);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
