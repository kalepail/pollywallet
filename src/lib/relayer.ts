import { createServerFn } from "@tanstack/react-start";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { Keypair, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { TESTNET_NETWORK_PASSPHRASE } from "./constants";

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
// The deployer keypair is reconstructed server-side so the private key
// never enters the client bundle.
// TODO(mainnet): Load from an environment secret instead of a deterministic seed.
function getDeployerKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from("pollywallet")) as Buffer);
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
