import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      // The backend binds to 127.0.0.1 only; "localhost" can resolve to ::1 on Windows.
      "/api": "http://127.0.0.1:8787",
    },
  },
});
