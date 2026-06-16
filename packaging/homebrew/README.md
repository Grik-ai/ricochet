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

The workflow requires the `HOMEBREW_TAP_TOKEN` GitHub Actions secret with access
to push branches and open pull requests in `grik-ai/homebrew-tap`.
