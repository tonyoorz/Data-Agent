import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: process.env.VIZION_DEV_HOST || "127.0.0.1",
    allowedHosts: ["bscn1132585", "BSCN1132585"],
    port: 8080,
    strictPort: true,
    watch: {
      ignored: ["**/.worktrees/**", "**/dist/**", "**/src/test/**"],
    },
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api/full-picture": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
      },
      "/api/testing": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
      },
      "/api/metadata": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
      },
      "/api/correlation": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:3004",
        changeOrigin: true,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));
