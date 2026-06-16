# Ricochet Release Pipeline

Ricochet releases are driven by git tags named `vX.Y.Z`. Pushing a tag runs the
GitHub Actions release workflow, which tests the project, builds native core
binaries, packages the VS Code extension, creates a GitHub Release, publishes the
npm installer, publishes Open VSX, and opens a Homebrew tap update PR.

The VS Code Marketplace publish is handled by `azure-pipelines.marketplace.yml`
because Microsoft recommends Entra ID / workload identity publishing instead of
long-lived Marketplace PATs.

## One-Time Setup

Required GitHub repository secrets:

| Secret | Purpose |
| --- | --- |
| `OVSX_PAT` | Open VSX publish token for the `grik` namespace. |
| `HOMEBREW_TAP_TOKEN` | GitHub token with access to push branches and open PRs in `grik-ai/homebrew-tap`. |

Required external setup:

1. Create or confirm the VS Code Marketplace publisher `grik`.
2. Configure an Azure DevOps pipeline from `azure-pipelines.marketplace.yml`.
3. Create an Azure service connection named `Ricochet Marketplace Publisher`, or
   update `VSCE_AZURE_SERVICE_CONNECTION` in the pipeline YAML.
4. Add the managed identity used by that service connection as a Contributor on
   the VS Code Marketplace publisher.
5. Create or confirm the Open VSX namespace `grik`, then add its token as
   `OVSX_PAT`.
6. Configure npm Trusted Publishing for `@grik-ai/ricochet-installer`:
   provider `GitHub Actions`, repository `Grik-ai/ricochet`, workflow
   `.github/workflows/release.yml`, allowed action `npm publish`.
7. Create or confirm `grik-ai/homebrew-tap` with a `Formula/` directory.
8. Deploy the Grik frontend route `/ricochet/install`; it serves the latest
   release `install.sh` asset.

## Release Procedure

1. Merge release-ready changes to `main`.
2. Create and push a SemVer tag:

   ```bash
   git tag v0.2.1
   git push origin v0.2.1
   ```

3. Watch the GitHub Actions `Release` workflow.
4. Watch the Azure DevOps Marketplace pipeline for the same tag.
5. Merge the generated Homebrew tap PR after it passes tap checks.

## Release Outputs

GitHub Release assets:

| Asset | Purpose |
| --- | --- |
| `ricochet-X.Y.Z.vsix` | Installable VS Code-compatible extension package. |
| `latest.json` | Installer manifest with version, VSIX URL, SHA256, and supported editors. |
| `SHA256SUMS` | Checksums for the VSIX, manifest, and shell installer. |
| `install.sh` | Shell installer served by `https://grik.io/ricochet/install`. |

Published registries:

- npm package: `@grik-ai/ricochet-installer`
- VS Code Marketplace extension: `grik.ricochet`
- Open VSX extension: `grik.ricochet`
- Homebrew tap formula: `grik-ai/homebrew-tap/Formula/ricochet.rb`

## Verification

After the workflows complete:

```bash
curl -fsSL https://grik.io/ricochet/install | sh -s -- --dry-run
npx @grik-ai/ricochet-installer --dry-run
brew install grik-ai/tap/ricochet
ricochet-install --dry-run
```

Also confirm that the extension pages show the new version in VS Code
Marketplace and Open VSX.
