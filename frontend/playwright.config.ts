import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0,
  timeout: 30000, expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: [
    { command: 'node ../server.js', url: 'http://127.0.0.1:3000/health', reuseExistingServer: false,
      env: { NODE_ENV: 'test', ALTEGRO_ENV_FILE: '/dev/null', ALTEGRO_PERSISTENCE_DRIVER: 'memory', ALTEGRO_PERSISTENCE: 'false', OBJECT_STORAGE_DRIVER: 'inline', ALTEGRO_SYNC_MODE: 'inline', AUTOXING_LIVE: 'false', CENOBOTS_LIVE: 'false', CRM_INTEGRATION_LIVE: 'false', SERVICE_INTEGRATION_LIVE: 'false', EMAIL_ALERTS_ENABLED: 'false', SMS_ALERTS_ENABLED: 'false', PORT: '3000', BIND_HOST: '127.0.0.1', DEFAULT_ACCOUNT_PASSWORD: 'efrobotics' } },
    { command: 'npm run start', url: 'http://127.0.0.1:3001', reuseExistingServer: false, timeout: 120000 }
  ]
});
