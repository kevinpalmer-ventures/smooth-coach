import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: ["3000-ib3vbyzbr7mjbrj277k6g-7125f901.us1.manus.computer"]
  }
});
