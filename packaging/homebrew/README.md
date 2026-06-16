# Homebrew Tap

The release workflow copies `Formula/ricochet.rb` into the `grik-ai/homebrew-tap`
repository as `Formula/ricochet.rb`, rewrites the `tag:` value to the pushed
release tag, and opens a pull request.

The formula intentionally installs only the `ricochet-install` wrapper. It does
not mutate VS Code, Cursor, or Windsurf in `post_install`; users run the wrapper
explicitly:

```bash
brew install grik-ai/tap/ricochet
ricochet-install
```

The workflow uses the `HOMEBREW_TAP_TOKEN` GitHub Actions secret when it is
configured. Without that secret, GitHub Release creation still succeeds and the
Homebrew tap update is skipped.
