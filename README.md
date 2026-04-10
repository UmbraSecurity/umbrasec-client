# UmbraSec Client

Open source client-side code for [UmbraSec](https://umbrasec.one) — the privacy-focused security platform.

## Purpose

This repository publishes all client-side code powering the UmbraSec suite: web, drive, mail, VPN manager, and OSINT tools. The goal is full transparency — you can audit every line to verify that:

- **No user data is collected, transmitted, or stored** beyond what is required for the service to function
- **No analytics, telemetry, or tracking** of any kind is embedded in the client code
- **No third-party SDKs** phone home, fingerprint users, or inject tracking pixels

## Verify It Yourself

```bash
git clone https://github.com/UmbraSecurity/umbrasec-client.git
cd umbrasec-client
grep -rn "analytics\|telemetry\|tracking" services/
```

## Structure

```
services/
├── web/          # Marketing site (umbrasec.one)
├── portal/       # Authentication & account management
├── dashboard/    # User dashboard
├── drive/        # Encrypted file storage
├── mail/         # Private email client
├── vpn/          # VPN profile manager
└── osint/        # OSINT reconnaissance tool
```

## License

All rights reserved. This code is published for transparency and audit purposes only. See [umbrasec.one](https://umbrasec.one) for terms of service.
