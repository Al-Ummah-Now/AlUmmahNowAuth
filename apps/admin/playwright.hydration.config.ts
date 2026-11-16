import { defineConfig, devices } from "@playwright/test";

/**
 * Arabic hydration check (CI job "Arabic hydration (WebKit)"): real admin route components rendered
 * in Node and hydrated in WebKit, plus the Profile page's in-browser dates. No accounts, no network:
 * hydration/server.mjs serves fixed data.
 */
const port = Number(process.env.HYDRATION_PORT || 4610);

export default defineConfig({
  testDir: "./hydration",
  testMatch: ["**/*.hydration.ts"],
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"], locale: "ar" } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], locale: "ar" } },
  ],
  webServer: {
    command: `node hydration/server.mjs`,
    url: `http://localhost:${port}/client.js`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { HYDRATION_PORT: String(port) },
  },
});
