# Ricochet Installer

Installs the Ricochet VS Code-compatible extension from GitHub Releases.

```bash
npx @grik-ai/ricochet-installer
pnpm dlx @grik-ai/ricochet-installer
bunx @grik-ai/ricochet-installer
```

The installer downloads the signed release manifest, verifies the `.vsix`
checksum, finds `code`, `cursor`, and `windsurf` on `PATH`, then installs the
extension through the editor CLI.

```bash
ricochet-install --editor cursor
ricochet-install --version 0.1.0
ricochet-install --dry-run
```
