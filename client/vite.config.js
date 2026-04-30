import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.js",
    globals: true,
    css: true,
    include: ["src/__tests__/**/*.test.{js,jsx}"],
    testTimeout: 10000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/ws":  { target: "ws://localhost:4000", ws: true },
    },
  },
});
