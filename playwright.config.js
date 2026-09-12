const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
	testDir: "test/e2e",
	testMatch: "**/*.spec.js",
	timeout: 20000,
	expect: { timeout: 5000 },
	webServer: {
		command: "node scripts/serve-e2e.mjs",
		port: 4173,
		reuseExistingServer: true,
		timeout: 15000,
	},
	use: {
		baseURL: "http://localhost:4173",
		headless: true,
		// 显式指定完整 Chromium：Playwright 默认 headless 走 chromium_headless_shell，
		// 而 `npx playwright install chromium` 在某些网络环境下只装好完整 Chromium、
		// headless shell 下载失败，导致 e2e 直接起不来。指定 channel 后只依赖前者。
		// 若你的环境能正常装齐两者，删掉这行即可恢复默认行为。
		channel: "chromium",
	},
});
