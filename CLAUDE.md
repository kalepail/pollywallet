# PollyWallet

Passkey-secured smart wallet on Stellar Testnet built with TanStack Start, React 19, and Cloudflare Workers.

## Tech Stack

- **Framework**: TanStack Start + TanStack Router (file-based routing in `src/routes/`)
- **UI**: React 19, Tailwind CSS 4, Lucide icons
- **Blockchain**: Stellar SDK (`@stellar/stellar-sdk`), Soroban smart contracts
- **Auth**: WebAuthn/Passkeys via `@simplewebauthn/browser`
- **Relayer**: OpenZeppelin Channels for gasless transactions
- **Build**: Vite 8, TypeScript 6, pnpm workspace
- **Deploy**: Cloudflare Workers via `@cloudflare/vite-plugin`
- **Testing**: Vitest 4 + Testing Library

## Project Structure

```
src/
├── routes/          # TanStack file-based routes (auto-generates routeTree.gen.ts)
├── components/      # React components
├── hooks/           # Custom React hooks
├── lib/             # Utility libraries (passkey, relayer, tx-analyzer, etc.)
├── router.tsx       # Router config
└── styles.css       # Tailwind imports
bindings/            # pnpm workspace packages (multisig-account TypeScript bindings)
stellar-contracts/   # Git submodule: OpenZeppelin Stellar Contracts (Rust/Soroban)
```

## Conventions

- Path alias: `@/*` → `./src/*`
- Routes use `createFileRoute` from `@tanstack/react-router`
- Never edit `src/routeTree.gen.ts` — it auto-regenerates
- Testnet only for now — no mainnet deployments

## Research & Development Practices

- **Always use MCP tools** (context7, deepwiki, perplexity, parallel-search, parallel-task) and the parallel-cli for deep research when investigating external services, APIs, or documentation
- **Prefer live docs over training data** — Cloudflare, Stellar, and dependency docs change frequently
- Use the Cloudflare docs MCP (`search_cloudflare_documentation`) for any Workers/Sandbox/AI questions
- Use context7 for SDK/library documentation lookups
- Use perplexity or parallel-search for broader web research

## Key Dependencies

- `@cloudflare/sandbox` — Sandbox SDK for isolated code execution (policy testing)
- `@cf/moonshotai/kimi-k2.5` — Workers AI model for policy code generation (256k context)
- `@stellar/stellar-sdk` — Transaction building, parsing, RPC calls
- `@simplewebauthn/browser` — Passkey authentication

## Commands

```bash
pnpm dev           # Local dev server (port 3000)
pnpm build         # Build for Cloudflare Workers
pnpm test          # Run Vitest tests
npx wrangler deploy # Deploy to Cloudflare
```
