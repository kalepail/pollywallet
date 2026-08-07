/**
 * Get testnet USDC into a smart wallet (C... contract address), no Captcha.
 *
 *   pnpm fund:usdc <wallet C...> [xlmToSwap]
 *
 * Same three steps the "Get USDC" button runs in the UI: friendbot a throwaway
 * classic account, swap XLM for USDC on the SDEX with a path payment, then
 * SAC-transfer the proceeds into the wallet. The wallet is a contract address,
 * so it holds the SAC balance directly and needs no trustline — only the
 * throwaway account does.
 *
 * The UI submits the final transfer through the relayer; this submits it
 * directly, since a script has a funded source account of its own.
 */
import {
  Keypair, Networks, TransactionBuilder, Operation, Asset, BASE_FEE,
  Contract, Address, xdr, rpc, scValToNative,
} from "@stellar/stellar-sdk";
import { TESTNET_USDC_TOKEN_CONTRACT, TESTNET_USDC_ISSUER } from "../src/lib/passkey.ts";
import { TESTNET_RPC_URL, TESTNET_HORIZON_URL } from "../src/lib/constants.ts";

const FRIENDBOT = "https://friendbot.stellar.org";
const SLIPPAGE = 0.98;
const server = new rpc.Server(TESTNET_RPC_URL);

function toI128(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString((value & 0xffffffffffffffffn).toString()),
      hi: xdr.Int64.fromString((value >> 64n).toString()),
    })
  );
}

async function fundUsdc(walletContractId: string, xlmToSwap: string) {
  const kp = Keypair.random();
  console.log(`Friendbotting ${kp.publicKey()}…`);
  const funded = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
  if (!funded.ok) throw new Error(`Friendbot failed: ${funded.status}`);

  const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);
  const quoteRes = await fetch(
    `${TESTNET_HORIZON_URL}/paths/strict-send?source_asset_type=native` +
    `&source_amount=${xlmToSwap}&destination_assets=USDC%3A${TESTNET_USDC_ISSUER}`
  );
  const quote = (await quoteRes.json()) as any;
  const best = quote?._embedded?.records?.[0];
  if (!best) throw new Error("No XLM → USDC path on testnet right now");
  const destMin = (Number(best.destination_amount) * SLIPPAGE).toFixed(7);
  console.log(`Quote: ${xlmToSwap} XLM → ${best.destination_amount} USDC (floor ${destMin})`);

  const account = await server.getAccount(kp.publicKey());
  const swapTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: xlmToSwap,
      destination: kp.publicKey(),
      destAsset: usdc,
      destMin,
      path: (best.path ?? []).map((a: any) =>
        a.asset_type === "native" ? Asset.native() : new Asset(a.asset_code, a.asset_issuer)
      ),
    }))
    .setTimeout(60)
    .build();
  swapTx.sign(kp);

  const swapSent = await server.sendTransaction(swapTx);
  if (swapSent.status === "ERROR") throw new Error(`Swap rejected: ${JSON.stringify(swapSent.errorResult)}`);
  const swapFinal = await server.pollTransaction(swapSent.hash, { attempts: 20 });
  if (swapFinal.status !== "SUCCESS") throw new Error(`Swap failed: ${swapFinal.status}`);
  console.log(`Swap ok: ${swapSent.hash}`);

  const accountJson = (await (await fetch(`${TESTNET_HORIZON_URL}/accounts/${kp.publicKey()}`)).json()) as any;
  const held = accountJson.balances?.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER
  );
  const stroops = BigInt(Math.floor(Number(held?.balance ?? 0) * 1e7));
  if (stroops === 0n) throw new Error("Swap settled but produced no USDC");
  console.log(`Received ${held.balance} USDC — transferring to ${walletContractId}…`);

  const source = await server.getAccount(kp.publicKey());
  const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      new Contract(TESTNET_USDC_TOKEN_CONTRACT).call(
        "transfer",
        new Address(kp.publicKey()).toScVal(),
        new Address(walletContractId).toScVal(),
        toI128(stroops)
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`Transfer rejected: ${JSON.stringify(sent.errorResult)}`);
  const final = await server.pollTransaction(sent.hash, { attempts: 20 });
  if (final.status !== "SUCCESS") throw new Error(`Transfer failed: ${final.status}`);
  console.log(`Transfer ok: ${sent.hash}`);

  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Balance"),
    xdr.ScVal.scvAddress(new Address(walletContractId).toScAddress()),
  ]);
  const entry = await server.getContractData(TESTNET_USDC_TOKEN_CONTRACT, key);
  const parsed: any = scValToNative(entry.val.contractData().val());
  const balance = typeof parsed === "object" && parsed.amount != null ? BigInt(parsed.amount) : BigInt(parsed ?? 0);
  console.log(`Wallet USDC balance: ${Number(balance) / 1e7}`);
}

const [walletId, xlm = "100"] = process.argv.slice(2);
if (!walletId) {
  console.log("Usage: pnpm fund:usdc <wallet C...> [xlmToSwap]");
  process.exit(1);
}
await fundUsdc(walletId, xlm);
