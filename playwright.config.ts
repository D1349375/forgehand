import { defineConfig, devices } from '@playwright/test';
const externalServer = process.env.PLAYWRIGHT_BASE_URL;

// The camera and model service are deliberately simulated in these tests.
// Chromium still constructs and renders the real Three.js WebGL scene.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: externalServer || 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 1000 },
      launchOptions: {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        // SwiftShader keeps the default suite reproducible on any machine, but
        // on a 2-core host it saturates the CPU and starves a real model CLI.
        // PLAYWRIGHT_GPU=1 uses the machine's GPU, as a normal browser would.
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          ...(process.env.PLAYWRIGHT_GPU === '1' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
        ],
      },
    },
  }],
  webServer: externalServer ? undefined : {
    command: 'npm run dev',
    // Browser fixtures provide model responses. No real CLI/key is needed for
    // the default suite; RUN_LIVE_CLI is the explicit real-service opt-in.
    env: process.env.RUN_LIVE_CLI === '1' ? {} : { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: '' },
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
