import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { resolveAnalyticsApiBase } from "./server/analyticsApiConfig.mjs";

function resolveLocalPort(value: string | undefined, fallback: number, name: string) {
  const configured = String(value || "").trim();
  if (!configured) return fallback;
  if (!/^\d+$/.test(configured)) throw new Error(`${name}_INVALID`);
  const port = Number(configured);
  if (port < 1 || port > 65535) throw new Error(`${name}_INVALID`);
  return port;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), [
      "VITE_",
      "VIZION_ANALYTICS_API_BASE",
      "VIZION_ANALYTICS_PORT",
      "VIZION_API_PORT",
      "VIZION_WEB_PORT",
    ]),
    ...process.env,
  };
  const analyticsTarget = resolveAnalyticsApiBase(env);
  const apiPort = resolveLocalPort(env.VIZION_API_PORT, 3004, "VIZION_API_PORT");
  const webPort = resolveLocalPort(env.VIZION_WEB_PORT, 8080, "VIZION_WEB_PORT");

  return {
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      watch: {
        ignored: ["**/.worktrees/**", "**/.venv/**", "**/dist/**", "**/src/test/**"],
      },
      hmr: {
        overlay: false,
      },
      proxy: {
        "/api/full-picture": {
          target: analyticsTarget,
          changeOrigin: true,
        },
        "/api/testing": {
          target: analyticsTarget,
          changeOrigin: true,
        },
        "/api/metadata": {
          target: analyticsTarget,
          changeOrigin: true,
        },
        "/api/correlation": {
          target: analyticsTarget,
          changeOrigin: true,
        },
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    optimizeDeps: {
      entries: ["index.html"],
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
  };
});
