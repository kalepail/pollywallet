# PollyWallet

PollyWallet is a passkey-secured smart wallet demo built on Stellar testnet. It uses WebAuthn passkeys for user authorization, deploys an OpenZeppelin smart account contract per wallet, funds accounts through Friendbot, and submits Soroban transactions through an OpenZeppelin Channels relayer.

This repository is a testnet-focused application, not a production wallet. Several implementation choices are intentionally convenient for a demo and should be treated as unsafe for mainnet use.

## What It Does

- Creates a passkey-backed wallet in the browser.
- Derives and deploys a Stellar smart account contract for that passkey.
- Stores wallet metadata locally in the browser.
- Funds the wallet with testnet XLM via Friendbot.
- Sends XLM using passkey authorization and a relayer-backed submission flow.

## Stack

- TanStack Start + React 19
- Cloudflare Vite plugin / Wrangler deployment target
- Stellar Soroban SDK
- OpenZeppelin Channels relayer client
- SimpleWebAuthn for browser passkeys
- Tailwind CSS 4
- Vitest for unit tests

## Repository Layout

```text
.
├── bindings/multisig-account/   Generated TypeScript bindings for the smart account contract
├── public/                      Static assets
├── scripts/                     E2E helpers for agent-browser + WebAuthn flows
├── src/
│   ├── components/              UI shell components
│   ├── hooks/                   Wallet orchestration
│   ├── lib/                     Passkey, Soroban, and relayer helpers
│   └── routes/                  TanStack file routes
├── stellar-contracts/           Optional git submodule for upstream OpenZeppelin Stellar contracts
├── wrangler.jsonc               Cloudflare runtime config
└── worker-configuration.d.ts    Generated Wrangler type definitions
```

## Prerequisites

- A recent Node.js version
- `pnpm`
- A browser/device that supports WebAuthn passkeys
- An OpenZeppelin Channels API key for the deploy, fund, and transfer flows

## Getting Started

Clone the repository and install dependencies:

```bash
git clone <your-fork-or-repo-url>
cd pollywallet
pnpm install
```

If you also want the upstream contract sources referenced by the submodule:

```bash
git submodule update --init --recursive
```

Create a local worker env file for the relayer secret:

```bash
cat > .dev.vars <<'EOF'
CHANNELS_API_KEY=your_openzeppelin_channels_api_key
EOF
```

`CHANNELS_BASE_URL` defaults to the OpenZeppelin testnet endpoint and is already set in [wrangler.jsonc](./wrangler.jsonc). You only need to override it if you are targeting a different relayer base URL.

Start the app:

```bash
pnpm dev
```

The default dev URL is `http://localhost:3000`.

## Available Scripts

```bash
pnpm dev         # run the local dev server
pnpm build       # build the bindings package, then the app
pnpm preview     # build and serve the production bundle locally
pnpm test        # run Vitest
pnpm test:e2e    # run the browser-based WebAuthn E2E flow
pnpm deploy      # build and deploy with Wrangler
pnpm cf-typegen  # regenerate Cloudflare environment/runtime types
```

## How The Wallet Flow Works

### 1. Passkey creation

The client creates a WebAuthn credential and extracts the P-256 public key. That public key and credential ID become the signer identity for the smart account.

### 2. Contract address derivation

The app derives a deterministic contract address from:

- the deployer public key
- the Stellar testnet network passphrase
- a salt derived from the credential ID

### 3. Deploy via server function

The browser builds an unsigned deployment transaction, then sends it to a TanStack server function. The server function reconstructs the deployer keypair, simulates the transaction, signs it, and submits it through the Channels relayer.

### 4. Funding

To fund a wallet, the app creates a temporary Stellar account, requests testnet XLM from Friendbot, and relays a Soroban token transfer into the smart wallet contract.

### 5. Transfers

For outgoing transfers, the app simulates the Soroban call, signs the authorization payload with the user’s passkey, encodes the WebAuthn signature into the required Soroban auth payload, and submits the transaction through the relayer.

## Environment And Runtime Notes

- `CHANNELS_API_KEY` is required for the deploy, fund, and transfer flows.
- `CHANNELS_BASE_URL` defaults to `https://channels.openzeppelin.com/testnet`.
- Wallet metadata is stored in browser `localStorage` under `pollywallet:wallet`.
- The app is hard-coded to Stellar testnet.
- `worker-configuration.d.ts` is generated output from Wrangler and can be refreshed with `pnpm cf-typegen`.

## Testing

### Unit tests

```bash
pnpm test
```

Vitest runs in `jsdom`.

### Browser E2E flow

```bash
pnpm test:e2e
```

The E2E path depends on:

- `agent-browser`
- a local PollyWallet dev server
- virtual WebAuthn support through `scripts/agent-browser-webauthn-helper.mjs`

The default test target is `http://localhost:3000`, and the script exercises create, fund, and transfer in one session.

## Deployment

Deployments target Cloudflare through Wrangler:

```bash
pnpm deploy
```

Before deploying, make sure the relevant Worker secret is configured for the target environment. For local development this is typically `.dev.vars`; for deployed environments use Wrangler secrets or environment configuration appropriate to your setup.

## Security Caveats

This repository should be treated as a demo/prototype.

- The app is testnet-only.
- The relayer server functions do not currently authenticate callers.
- The deployer key is derived from a deterministic seed for convenience.
- Friendbot funding is used as part of the flow.
- Wallet state is stored in browser `localStorage`.

If you intend to harden this project for production, start with:

1. Replacing the deterministic deployer seed with a real secret.
2. Adding auth and rate limiting to the relayer-backed server functions.
3. Reviewing transaction authorization boundaries and abuse paths.
4. Reworking client-side persistence and account recovery expectations.

## Troubleshooting

### `Relayer not configured`

Set `CHANNELS_API_KEY` in `.dev.vars` before running `pnpm dev`.

### Wallet creation fails during deployment

Check that:

- the relayer key is valid
- the relayer base URL points to a compatible environment
- the testnet RPC endpoint is reachable

### Funding fails

Friendbot or the testnet RPC may be unavailable temporarily. Retry after a short delay.

### Passkey prompts do not appear

Use a browser and platform with WebAuthn/passkey support enabled. Some automated or remote browser environments require special setup.

## Development Notes

- The generated contract bindings live in [bindings/multisig-account](./bindings/multisig-account).
- The project is a `pnpm` workspace rooted at the repository root.
- `package.json` is marked `"private": true`, so publishing the repository does not publish the package.
- The `stellar-contracts` directory is present as a submodule path but may be empty until initialized.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
