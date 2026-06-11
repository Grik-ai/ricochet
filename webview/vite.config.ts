import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: '../extension-vscode/webview-dist',
        emptyOutDir: true,
        // VS Code webview loader injects one nonce-protected script tag for
        // webview-dist/main.js. Keep the intentional single-file IIFE bundle
        // and silence Vite's generic split-chunk warning for this target.
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            output: {
                format: 'iife',
                entryFileNames: 'main.js',
                inlineDynamicImports: true,
                assetFileNames: 'main.[ext]'
            }
        }
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, './src'),
            '@components': resolve(__dirname, './src/components'),
            '@hooks': resolve(__dirname, './src/hooks')
        }
    }
});
