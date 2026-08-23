import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		unstubEnvs: true,
		reporters: ["dot"],
		silent: "passed-only",
	},
});
