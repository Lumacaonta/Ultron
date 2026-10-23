# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest packaged release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when it is enabled. If private reporting is unavailable, contact the maintainers through the repository owner's public contact method and include only the minimum detail needed to establish a secure channel.

Do not put credentials, real vault content, account data, private email, local paths, or proof-of-concept payloads that expose another person's data in a public issue.

Include:

- a clear description of the impact;
- affected version or commit;
- minimal reproduction steps using synthetic data; and
- any suggested mitigation.

We will acknowledge a good-faith report, investigate it, and coordinate a fix before public disclosure where possible.

## Local deployment notes

ULTRON is designed to bind its backend to `127.0.0.1`. Do not expose the local API to a network without adding authentication, TLS, origin controls, rate limits, and an explicit deployment review. Keep `ULTRON_AUTH_SECRET`, SMTP credentials, and third-party API keys outside version control.
