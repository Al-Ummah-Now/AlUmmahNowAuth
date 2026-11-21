import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // `pnpm dev` runs on local stores only (wrangler.dev.json). `pnpm build` writes the
      // deploy config (build/server/wrangler.json) from the production config, wrangler.json.
      configPath: command === "serve" ? "wrangler.dev.json" : "wrangler.json",
      persistState: { path: "../../.wrangler/state" },
    }),
    tailwindcss(),
    reactRouter(),
  ],
}));
