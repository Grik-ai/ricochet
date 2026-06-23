# Ricochet Chat Dev Lab

Use Chat Dev Lab when iterating on chat, timeline, Mission Dashboard, account badges, provider access, and streaming states without rebuilding the whole extension after every UI edit.

## Browser hot reload

```bash
cd webview
npm run dev:chat-lab
```

Open the Vite URL, usually `http://127.0.0.1:5173`.

When the webview runs outside VS Code, Ricochet installs a fake VS Code API and a small `Ricochet Dev Lab` panel. The panel can:

- load the Polybot timeline fixture;
- play a live run with progress, tool events, commands, draft and final answer;
- play a failed command plus review state;
- switch Grik account states between Free, Pro and Sync issue;
- clear the chat.

## VS Code sidebar hot reload

Start the same Vite server:

```bash
cd webview
npm run dev:chat-lab
```

Then set the VS Code setting:

```json
{
  "ricochet.webview.devServerUrl": "http://127.0.0.1:5173"
}
```

Reload the Ricochet view. The extension will load `@vite/client` and `src/main.tsx` from the dev server instead of `extension-vscode/webview-dist/main.js`.

Use `bash scripts/build-all.sh` as the final verification step before packaging. Core and extension TypeScript changes still require their normal rebuild/reload cycle; this dev mode is for webview UI iteration.
