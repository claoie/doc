import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      client: path.resolve(__dirname, "./src/client"),
      common: path.resolve(__dirname, "./src/common"),
    },
  },
  root: "src/client",
  build: {
    outDir: "../../build/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true, ws: true },
    },
  },
});
