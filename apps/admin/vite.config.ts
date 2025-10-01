import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      configPath: "wrangler.json",
      persistState: { path: "../../.wrangler/state" },
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
