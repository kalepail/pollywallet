import { createServerFn } from "@tanstack/react-start";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { Keypair, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE, FRIENDBOT_URL } from "./passkey";

type RelayerPayload =
  | { func: string; auth: string[] }
  | { xdr: string };

const MAX_XDR_LENGTH = 100_000;
const MAX_AUTH_ENTRIES = 10;

function validatePayload(data: unknown): RelayerPayload {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }

  if ("xdr" in data) {
    const { xdr } = data as { xdr: unknown };
    if (typeof xdr !== "string" || xdr.length === 0 || xdr.length > MAX_XDR_LENGTH) {
      throw new Error("Invalid xdr: must be a non-empty string under 100KB");
    }
    return { xdr };
  }

  if ("func" in data && "auth" in data) {
    const { func, auth } = data as { func: unknown; auth: unknown };
    if (typeof func !== "string" || func.length === 0 || func.length > MAX_XDR_LENGTH) {
      throw new Error("Invalid func: must be a non-empty string under 100KB");
    }
    if (!Array.isArray(auth) || auth.length > MAX_AUTH_ENTRIES || !auth.every((a) => typeof a === "string" && a.length <= MAX_XDR_LENGTH)) {
      throw new Error(`Invalid auth: must be an array of up to ${MAX_AUTH_ENTRIES} strings`);
    }
    return { func, auth };
  }

  throw new Error("Payload must contain either {xdr} or {func, auth}");
}

function getClient() {
  const baseUrl = (globalThis as any).CHANNELS_BASE_URL
    || (typeof process !== "undefined" ? process.env?.CHANNELS_BASE_URL : undefined)
    || "https://channels.openzeppelin.com/testnet";

  const apiKey = (globalThis as any).CHANNELS_API_KEY
    || (typeof process !== "undefined" ? process.env?.CHANNELS_API_KEY : undefined);

  if (!apiKey) return null;

  return new ChannelsClient({ baseUrl, apiKey });
}

// TODO(mainnet): Add app-level auth (e.g. passkey-based proof or session token)
// to prevent unauthorized use of the relayer API key.
export const submitToRelayer = createServerFn({ method: "POST" })
  .inputValidator(validatePayload)
  .handler(async ({ data }) => {
    const client = getClient();
    if (!client) {
      return { success: false as const, error: "Relayer not configured", hash: null };
    }

    try {
      const result = "xdr" in data
        ? await client.submitTransaction({ xdr: data.xdr })
        : await client.submitSorobanTransaction({ func: data.func, auth: data.auth });

      return {
        success: true as const,
        error: null,
        hash: result.hash ?? null,
      };
    } catch (err: any) {
      return {
        success: false as const,
        error: err.message || "Relayer request failed",
        hash: null,
      };
    }
  });

// --- Server-side deploy signing ---
// The deployer keypair is reconstructed server-side so the private key
// never enters the client bundle.
// TODO(mainnet): Load from an environment secret instead of a deterministic seed.
function getDeployerKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from("pollywallet")) as Buffer);
}

export const signAndSubmitDeploy = createServerFn({ method: "POST" })
  .inputValidator((data: { unsignedXdr: string }) => {
    if (typeof data?.unsignedXdr !== "string" || data.unsignedXdr.length === 0 || data.unsignedXdr.length > MAX_XDR_LENGTH) {
      throw new Error("Invalid unsignedXdr");
    }
    return data;
  })
  .handler(async ({ data }) => {
    try {
      const deployer = getDeployerKeypair();

      // Ensure deployer account exists (idempotent — friendbot is a no-op if already funded)
      await fetch(`${FRIENDBOT_URL}?addr=${deployer.publicKey()}`).catch(() => {});

      const server = new rpc.Server(TESTNET_RPC_URL);
      const tx = TransactionBuilder.fromXDR(data.unsignedXdr, TESTNET_NETWORK_PASSPHRASE);

      const simResult = await server.simulateTransaction(tx);
      if ("error" in simResult) {
        return { success: false as const, error: `Simulation failed: ${(simResult as any).error}`, hash: null };
      }

      const preparedTx = rpc
        .assembleTransaction(tx, simResult as rpc.Api.SimulateTransactionSuccessResponse)
        .build();
      preparedTx.sign(deployer);

      const client = getClient();
      if (!client) {
        return { success: false as const, error: "Relayer not configured", hash: null };
      }

      const result = await client.submitTransaction({ xdr: preparedTx.toXDR() });
      return { success: true as const, error: null, hash: result.hash ?? null };
    } catch (err: any) {
      return { success: false as const, error: err.message || "Deploy failed", hash: null };
    }
  });
