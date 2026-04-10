export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// --- Smart Account Contract Limits ---
// From stellar-contracts/packages/accounts/src/smart_account/mod.rs

/** Max bytes for a context rule name. */
export const MAX_CONTEXT_RULE_NAME = 20;
/** Max signers per context rule. */
export const MAX_SIGNERS_PER_RULE = 15;
/** Max policies per context rule. */
export const MAX_POLICIES_PER_RULE = 5;
/** Max bytes for an External signer's key data. */
export const MAX_EXTERNAL_KEY_SIZE = 256;
