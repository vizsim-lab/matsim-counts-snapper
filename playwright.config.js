// Browser-Tests (tests/web): die Seite gegen erfundene Testdaten, ohne Netz nach draußen.
// Lokal mit einem vorhandenen Chrome: CHROME=/pfad/zu/chrome npm run test:web
import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "tests/web",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 860 },
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : {},
  },
  webServer: {
    command: `node tests/web/server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
