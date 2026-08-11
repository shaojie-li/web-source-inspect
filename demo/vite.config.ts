import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite includes sourcemaps in dev mode by default; keep this explicit for validating the build mapping chain later.
  build: { sourcemap: true },
});
