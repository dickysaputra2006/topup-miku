const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 30000,
    reporter: [
        ['list'],
        ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }],
        ['json', { outputFile: 'artifacts/playwright-results.json' }],
    ],
    use: {
        baseURL: process.env.QA_BASE_URL || 'http://localhost:3000',
        channel: 'msedge',
        headless: true,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        viewport: { width: 1440, height: 900 },
    },
    projects: [
        {
            name: 'desktop-1440',
            testMatch: /01-.*\.spec\.js/,
            use: { viewport: { width: 1440, height: 900 } },
        },
        {
            name: 'api-and-security',
            testMatch: /.*\.api\.spec\.js/,
        },
    ],
});
