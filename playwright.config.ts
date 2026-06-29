import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test",
  testMatch: "**/*.e2e.{ts,tsx}",
  use: {
    baseURL: "http://127.0.0.1:8080",
  },
});
