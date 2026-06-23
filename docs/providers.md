# Providers And Model Access

Ricochet supports two model access modes: Grik hosted subscription access and bring-your-own-key providers.

## Grik Hosted Models

Grik models use `access_mode: subscription` and `key_source: hosted` in the provider catalog. Users sign in with a Grik Account, and hosted model access is controlled by Grik account, entitlement, billing, and limit services.

The repository must not contain Grik server credentials, billing secrets, quota enforcement secrets, or private gateway keys.

## BYOK Providers

BYOK providers use user-owned provider keys. Keys should be stored in local user settings, the OS secret store, or environment variables.

The public catalog uses placeholders such as:

```yaml
key: "${OPENROUTER_API_KEY}"
```

At runtime the Go core resolves placeholders from the user's environment or local configuration. Raw keys must not be returned to the webview as provider metadata.

## Public Catalog Rules

`core/config/providers.yaml` is a public provider catalog. It can contain:

- provider IDs and display names
- public API base URLs
- model IDs and context windows
- pricing metadata when it is intended to be public
- access mode metadata
- environment-variable placeholders

It must not contain:

- real API keys
- bearer tokens
- OAuth client secrets
- refresh tokens
- bot tokens
- private Grik gateway credentials
- customer or billing data

## Local Files

These files are local-only and ignored by git:

- `.env.local`
- `.env.keys`
- `*.keys`
- `*.local`
- `core/config/.env.local`
- `.ricochet/`

Do not copy local secrets into docs, tests, examples, screenshots, issue reports, or fixtures.
