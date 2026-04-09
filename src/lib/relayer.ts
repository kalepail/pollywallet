import { createServerFn } from "@tanstack/react-start";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";

type RelayerPayload =
  | { func: string; auth: string[] }
  | { xdr: string };

function getClient() {
  const baseUrl = (globalThis as any).CHANNELS_BASE_URL
    || (typeof process !== "undefined" ? process.env?.CHANNELS_BASE_URL : undefined)
    || "https://channels.openzeppelin.com/testnet";

  const apiKey = (globalThis as any).CHANNELS_API_KEY
    || (typeof process !== "undefined" ? process.env?.CHANNELS_API_KEY : undefined);

  if (!apiKey) return null;

  return new ChannelsClient({ baseUrl, apiKey });
}

export const submitToRelayer = createServerFn({ method: "POST" })
  .inputValidator(
    (data: RelayerPayload) => data
  )
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
