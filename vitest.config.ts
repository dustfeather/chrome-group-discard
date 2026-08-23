import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the crxjs plugin rewrites the
// manifest and injects extension entry points, neither of which the unit
// tests want. Vitest picks this file up in preference to vite.config.ts.
export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["tests/**/*.test.ts"],
        restoreMocks: true,
        unstubGlobals: true,
    },
});
