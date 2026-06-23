import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { execFile } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const coreRoot = resolve(repoRoot, 'core');
const terminalFixtures = new Set(['all', 'polybot', 'failed', 'slash-menu']);

function terminalLabDevPlugin() {
    return {
        name: 'ricochet-terminal-lab-dev',
        configureServer(server: any) {
            server.middlewares.use('/__ricochet_dev/terminal-lab', (req: any, res: any) => {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const fixture = url.searchParams.get('fixture') || 'all';
                const mode = url.searchParams.get('mode') || 'snapshot';
                const width = Number(url.searchParams.get('width') || 100);
                const height = Number(url.searchParams.get('height') || 120);

                if (!terminalFixtures.has(fixture)) {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: `Unknown fixture: ${fixture}` }));
                    return;
                }
                if (mode !== 'snapshot' && mode !== 'jsonl') {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: `Unknown terminal lab mode: ${mode}` }));
                    return;
                }

                const args = [
                    'run',
                    './cmd/ricochet',
                    'dev',
                    'terminal-lab',
                    '--fixture',
                    fixture,
                    mode === 'jsonl' ? '--jsonl' : '--snapshot',
                    '--width',
                    String(Number.isFinite(width) ? Math.max(60, Math.min(160, width)) : 100),
                    '--height',
                    String(Number.isFinite(height) ? Math.max(24, Math.min(180, height)) : 120),
                ];

                execFile('go', args, { cwd: coreRoot, timeout: 20_000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
                    res.statusCode = error ? 500 : 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({
                        fixture,
                        mode,
                        output: stdout,
                        stderr,
                        error: error ? String(error.message || error) : null,
                    }));
                });
            });
        },
    };
}

export default defineConfig({
    plugins: [react(), terminalLabDevPlugin()],
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
