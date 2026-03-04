import { defineConfig } from 'vite'

export default defineConfig({
    // All VITE_* env vars in .env.local are available in the browser via import.meta.env
    envPrefix: 'VITE_',

    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
    },

    server: {
        port: 5173,
        strictPort: true,
    },

    preview: {
        port: 4173,
        strictPort: true,
    },
})
