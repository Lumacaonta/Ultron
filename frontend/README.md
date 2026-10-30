# Ultron AI frontend

This folder contains the React and Vite interface for Ultron AI.

## Commands

```bash
npm ci
npm run dev
npm run build
```

The development server proxies `/api` to the local backend on port 8000. A
packaged Ultron AI app uses its own `ultron://app` origin, a random loopback
backend port, and an app launch capability instead.

Do not add account data, screenshots with personal information, generated
`dist/` files, or local integration credentials to this folder.
