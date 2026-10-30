import { resolve } from "node:path";
import { defineConfig } from "vite";

const page = (file: string) => resolve(import.meta.dirname, file);

export default defineConfig({
  // Three pages (NOTES D-78): the landing page, sign in / sign up, and the app itself. Only app.html loads
  // MediaPipe and the camera.
  input: {
    index: page("index.html"),
    auth: page("auth.html"),
    app: page("app.html"),
  },
  server: {
    proxy: {
      // The backend binds to 127.0.0.1 only; "localhost" can resolve to ::1 on Windows.
      "/api": "http://127.0.0.1:8787",
    },
  },
});
