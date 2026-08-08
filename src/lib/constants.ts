/**
 * Workers AI model used for policy Rust codegen and the compile-error fix pass.
 * Requires the Workers Paid plan (free plan returns 403 / error 5035 — verified still true).
 * Deprecations alias silently — check the model page before assuming this still resolves.
 * (`kimi-k2.5` has been auto-aliased to k2.6 since 2026-05-30.)
 *
 * Measured 2026-08-07: 262,144-token context and max output; $0.95/M input, $0.19/M cached,
 * $4.00/M output; 20 rpm per account/model; no batch API on this model.
 * Callers deliberately pass no `chat_template_kwargs` and no `reasoning_effort`; see the
 * note at the ai.run() sites for the measured reasons.
 */
export const POLICY_CODEGEN_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Seed for the shared deterministic deployer. PUBLIC on purpose.
 *
 * Lives here because BOTH sides derive from it and must never diverge: `passkey.ts` derives
 * `DEPLOYER_PUBLIC_KEY` (which the browser mixes into every wallet's contract address via
 * `deriveContractAddress`) and `relayer.ts` derives the server-side signing keypair. If they
 * disagree, the server signs with a key that is not the transaction's source account and
 * every wallet creation fails.
 *
 * This is an addressing parameter, not a credential — see the notes at both derivation sites
 * before considering any change to it.
 */
export const DEPLOYER_SEED_PHRASE = "pollywallet";

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
/** RPC only retains ~7 days of transactions; Horizon keeps history back to the last testnet reset. */
export const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// --- Smart Account Contract Limits ---
// From stellar-contracts/packages/accounts/src/smart_account/mod.rs

/** Max bytes for a context rule name. */
export const MAX_CONTEXT_RULE_NAME = 20;

/** Largest value accepted by Soroban's u32 type. */
export const MAX_U32 = 0xffff_ffff;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
