import { createServerFn } from "@tanstack/react-start";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { Keypair, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { TESTNET_NETWORK_PASSPHRASE, DEPLOYER_SEED_PHRASE } from "./constants";


export const MAX_XDR_LENGTH = 100_000;
export const MAX_AUTH_ENTRIES = 10;

function getClient() {
  const baseUrl = (globalThis as any).CHANNELS_BASE_URL
    || (typeof process !== "undefined" ? process.env?.CHANNELS_BASE_URL : undefined)
    || "https://channels.openzeppelin.com/testnet";

  const apiKey = (globalThis as any).CHANNELS_API_KEY
    || (typeof process !== "undefined" ? process.env?.CHANNELS_API_KEY : undefined);

  if (!apiKey) return null;

  return new ChannelsClient({ baseUrl, apiKey });
}

// --- Server-side deploy signing ---
//
// This keypair is derived from a PUBLIC, well-known seed, and that is deliberate — it is not
// a leaked secret and MUST NOT be "rotated" as if it were.
//
// The deployer's public key is part of the wallet ADDRESSING SCHEME. `deriveContractAddress()`
// (src/lib/passkey.ts) builds each wallet's contract id from
// (network passphrase, deployer public key, credential id), so the browser must be able to
// reproduce this address to find a user's wallet at all — which is why
// `DEPLOYER_PUBLIC_KEY` is derived from the same seed client-side.
//
// Consequences of changing the seed:
//   * Server-only change  -> the signature no longer matches the transaction's source
//                            account, and every wallet creation fails immediately.
//   * Changing both sides -> every derived contract address changes, so EXISTING passkeys
//                            resolve to contracts that do not exist. Wallets are orphaned.
//
// So the account is intentionally shared and publicly derivable. Its real exposure is
// griefing (draining its balance or bumping its sequence), not key theft; on testnet it is
// friendbot-refillable and `useWallet.ts` already re-funds it on demand.
//
// FOR MAINNET this design has to change, and a secret alone will not do it: the deployer must
// come out of the address-derivation path first, otherwise the addressing scheme is pinned to
// a key that anyone can sign with. Treat that as a migration, not a config change.
function getDeployerKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(DEPLOYER_SEED_PHRASE)) as Buffer);
}

/**
 * Sign a already-simulated deploy transaction with the deployer key and submit it.
 *
 * The caller passes a transaction that has ALREADY been simulated and assembled
 * client-side. Simulation deliberately does not happen here: local workerd cannot
 * reach `soroban-testnet.stellar.org` (it fails with "internal error; reference = ..."),
 * which broke wallet creation under `pnpm dev`. The browser reaches the RPC fine, so
 * simulation lives there and the server only does what needs the secret — signing.
 */
export const signAndSubmitDeploy = createServerFn({ method: "POST" })
  .inputValidator((data: { preparedXdr: string }) => {
    if (typeof data?.preparedXdr !== "string" || data.preparedXdr.length === 0 || data.preparedXdr.length > MAX_XDR_LENGTH) {
      throw new Error("Invalid preparedXdr");
    }
    return data;
  })
  .handler(async ({ data }) => {
    try {
      const client = getClient();
      if (!client) {
        return { success: false as const, error: "Relayer not configured", hash: null };
      }

      const tx = TransactionBuilder.fromXDR(data.preparedXdr, TESTNET_NETWORK_PASSPHRASE);
      tx.sign(getDeployerKeypair());

      const result = await client.submitTransaction({ xdr: tx.toXDR() });
      return { success: true as const, error: null, hash: result.hash ?? null };
    } catch (err: any) {
      return { success: false as const, error: err.message || "Deploy failed", hash: null };
    }
  });
