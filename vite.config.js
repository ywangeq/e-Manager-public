import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveLanHost } from "./server/lan-host.mjs";

const lanHost = resolveLanHost("0.0.0.0");
const authOrigin = process.env.DIGITAL_WORKFORCE_AUTH_ORIGIN || `http://${lanHost}:8787`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: lanHost,
    proxy: {
      "/api": authOrigin,
    },
  },
});
