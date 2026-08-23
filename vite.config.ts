import { defineConfig } from "vite";
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json" with { type: "json" };

export default defineConfig({
    plugins: [crx({ manifest: manifest as ManifestV3Export })],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
