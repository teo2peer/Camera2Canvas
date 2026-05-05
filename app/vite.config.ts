import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "renderer",
  base: "./",
  build: {
    outDir: "../dist-renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        world: resolve(__dirname, "renderer/world.html"),
        instructions: resolve(__dirname, "renderer/instructions.html"),
      },
    },
  },
  server: { port: 5173 },
});
