# Security Policy

## Supported Versions

PolyStella is pre-1.0. Security fixes are applied to the latest published version only unless maintainers explicitly announce otherwise.

## Reporting a Vulnerability

Do not open a public GitHub issue for a vulnerability.

Use GitHub private vulnerability reporting for this repository if it is enabled:

https://github.com/cloudflare/polystella/security/advisories/new

If that is unavailable, use Cloudflare's vulnerability disclosure process:

https://www.cloudflare.com/disclosure/

Useful reports include:

- Affected PolyStella version or commit.
- Minimal reproduction steps.
- Impact and attacker capabilities.
- Any relevant config, with credentials and tokens redacted.

## Secrets

Never include live R2 credentials, Workers AI tokens, Anthropic API keys, or other provider secrets in issues, discussions, pull requests, logs, fixtures, or screenshots.
