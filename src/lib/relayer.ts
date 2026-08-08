import { createServerFn } from "@tanstack/react-start";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { Keypair, hash, authorizeEntry, xdr } from "@stellar/stellar-sdk";
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
 * Authorize a wallet deployment with the deployer key and submit it via a channel account.
 *
 * The deployer AUTHORIZES the deployment but must never PAY for it. Its address is baked into
 * every wallet's contract id (see DEPLOYER_SEED_PHRASE), so it is a permanent, shared,
 * publicly-derivable account — anything it funds is drainable by anyone, and any sequence
 * bump by a third party breaks in-flight deploys.
 *
 * This previously built the transaction with the deployer as SOURCE account and submitted the
 * signed envelope through `submitTransaction({ xdr })`, which pays fees from the source. That
 * was measurable on-chain: the deployer had spent ~1 XLM in fee_charged across wallet
 * creations. Now the host function plus deployer-signed auth entries go through
 * `submitSorobanTransaction({ func, auth })`, which the plugin documents as using channel
 * accounts — so the relayer's channel account is the source and the fee payer.
 *
 * Contract addresses are unaffected: the id derives from
 * ContractIdPreimageFromAddress{address, salt} inside the host function, not from the
 * transaction's source account. The `address` there is still the deployer.
 *
 * Simulation stays in the browser: local workerd cannot reach soroban-testnet.stellar.org
 * (it fails with "internal error; reference = ..."), which broke wallet creation under
 * `pnpm dev`. The server only does what needs the key — signing.
 */
export const signAndSubmitDeploy = createServerFn({ method: "POST" })
  .inputValidator((data: { func: string; auth: string[]; validUntilLedger: number }) => {
    if (typeof data?.func !== "string" || !data.func || data.func.length > MAX_XDR_LENGTH) {
      throw new Error("Invalid func");
    }
    if (
      !Array.isArray(data?.auth) ||
      data.auth.length > MAX_AUTH_ENTRIES ||
      !data.auth.every((a) => typeof a === "string" && a.length <= MAX_XDR_LENGTH)
    ) {
      throw new Error(`Invalid auth: expected up to ${MAX_AUTH_ENTRIES} XDR strings`);
    }
    if (!Number.isInteger(data?.validUntilLedger) || data.validUntilLedger <= 0) {
      throw new Error("Invalid validUntilLedger");
    }
    return data;
  })
  .handler(async ({ data }) => {
    try {
      const client = getClient();
      if (!client) {
        return { success: false as const, error: "Relayer not configured", hash: null };
      }

      const deployer = getDeployerKeypair();
      const signed = await Promise.all(
        data.auth.map((entryXdr) =>
          authorizeEntry(
            xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64"),
            deployer,
            data.validUntilLedger,
            TESTNET_NETWORK_PASSPHRASE
          )
        )
      );

      const result = await client.submitSorobanTransaction({
        func: data.func,
        auth: signed.map((e) => e.toXDR("base64")),
      });
      return { success: true as const, error: null, hash: result.hash ?? null };
    } catch (err: any) {
      return { success: false as const, error: err.message || "Deploy failed", hash: null };
    }
  });
