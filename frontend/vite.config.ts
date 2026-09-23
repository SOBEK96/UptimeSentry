import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    // genlayer-js ships as one prebuilt ~600 kB module (127 kB gzipped) that the
    // console needs on first paint to read contract state; it is isolated in its
    // own cacheable chunk below and cannot be split further.
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "genlayer", test: /node_modules[\\/]genlayer-js[\\/]/ },
            { name: "viem", test: /node_modules[\\/](viem|ox|abitype|@noble|@scure|@adraffy)[\\/]/ },
          ],
        },
      },
    },
  },
});
