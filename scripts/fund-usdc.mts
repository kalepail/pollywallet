/**
 * Get testnet USDC into a smart wallet (C... contract address).
 *
 * Circle's faucet is Captcha-gated and pays out to a classic G... account, so
 * the middle step can't be scripted. This handles both ends:
 *
 *   pnpm fund:usdc prepare
 *     → generates a G account, friendbots it, adds the USDC trustline,
 *       and prints the address to paste into https://faucet.circle.com/
 *
 *   USDC_SECRET=S... pnpm fund:usdc sweep <wallet C...> [amount]
 *     → moves the faucet's USDC from that G account into the smart wallet
 *
 * Contract addresses hold SAC balances directly, so the wallet itself needs no
 * trustline — only the intermediate G account does.
 */
import {
  Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset, BASE_FEE,
  Contract, Address, xdr, rpc, scValToNative,
} from "@stellar/stellar-sdk";
import { TESTNET_USDC_TOKEN_CONTRACT } from "../src/lib/passkey.ts";
import { TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "../src/lib/constants.ts";

/** Circle's classic USDC issuer on Stellar testnet (matches the SAC's name()). */
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FRIENDBOT = "https://friendbot.stellar.org";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const server = new rpc.Server(TESTNET_RPC_URL);

function toI128(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString((value & 0xffffffffffffffffn).toString()),
      hi: xdr.Int64.fromString((value >> 64n).toString()),
    })
  );
}

async function prepare() {
  const kp = Keypair.random();
  console.log(`Funding ${kp.publicKey()} with friendbot…`);
  const res = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.status}`);

  console.log("Adding USDC trustline…");
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);

  console.log(`
Trustline ready. Now do the one manual step:

  1. Open   https://faucet.circle.com/
  2. Select Stellar Testnet
  3. Paste  ${kp.publicKey()}

Then sweep it into your smart wallet:

  USDC_SECRET=${kp.secret()} pnpm fund:usdc sweep <your C... wallet>
`);
}

async function sweep(walletContractId: string, amountArg?: string) {
  const secret = process.env.USDC_SECRET;
  if (!secret) throw new Error("Set USDC_SECRET to the S... key printed by `prepare`");
  const kp = Keypair.fromSecret(secret);

  const account = await horizon.loadAccount(kp.publicKey());
  const held = account.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );
  const heldUnits = BigInt(Math.round(Number(held?.balance ?? 0) * 1e7));
  if (heldUnits === 0n) {
    throw new Error(`${kp.publicKey()} holds no USDC yet — run the Circle faucet step first.`);
  }

  const amount = amountArg ? BigInt(Math.round(Number(amountArg) * 1e7)) : heldUnits;
  if (amount > heldUnits) throw new Error(`Only ${held?.balance} USDC available`);
  console.log(`Transferring ${Number(amount) / 1e7} USDC → ${walletContractId}`);

  const source = await server.getAccount(kp.publicKey());
  const built = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: TESTNET_NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(TESTNET_USDC_TOKEN_CONTRACT).call(
        "transfer",
        new Address(kp.publicKey()).toScVal(),
        new Address(walletContractId).toScVal(),
        toI128(amount)
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  const final = await server.pollTransaction(sent.hash, { attempts: 20 });
  if (final.status !== "SUCCESS") throw new Error(`Transfer failed: ${final.status}`);
  console.log(`Done: ${sent.hash}`);

  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Balance"),
    xdr.ScVal.scvAddress(new Address(walletContractId).toScAddress()),
  ]);
  const entry = await server.getContractData(TESTNET_USDC_TOKEN_CONTRACT, key);
  const parsed: any = scValToNative(entry.val.contractData().val());
  const balance = typeof parsed === "object" && parsed.amount != null ? BigInt(parsed.amount) : BigInt(parsed ?? 0);
  console.log(`Wallet USDC balance: ${Number(balance) / 1e7}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "prepare") await prepare();
else if (command === "sweep") {
  if (!rest[0]) throw new Error("Usage: fund:usdc sweep <wallet C...> [amount]");
  await sweep(rest[0], rest[1]);
} else {
  console.log("Usage:\n  pnpm fund:usdc prepare\n  USDC_SECRET=S... pnpm fund:usdc sweep <wallet C...> [amount]");
  process.exit(1);
}
