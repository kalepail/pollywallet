/**
 * Workers AI model used for policy Rust codegen and the compile-error fix pass.
 * Requires the Workers Paid plan (free plan returns 403 / error 5035).
 * Deprecations alias silently — check the model page before assuming this still resolves.
 * Callers deliberately pass no `chat_template_kwargs`; see the note at the ai.run() sites.
 */
export const POLICY_CODEGEN_MODEL = "@cf/moonshotai/kimi-k2.7-code";

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
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
