/**
 * Curated testnet transactions for the policy builder's example dropdown.
 *
 * Each one is verified against the rubric in scripts/check-example-txs.mts
 * (`pnpm check:examples`): succeeded on-chain, decodes to at least one
 * invoke-contract pattern, carries a named auth signer, has concretely-typed
 * args, and covers a shape the others don't.
 *
 * ponytail: hashes die at the next testnet reset (Horizon's history restarts
 * with it). Re-run the rubric and repopulate this list when they 404.
 */
export interface ExampleTx {
  hash: string;
  label: string;
  detail: string;
}

export const EXAMPLE_TXS: ExampleTx[] = [
  {
    hash: "7b687754f86b27008efaea64e1bfa98b1d75e0b3b7bb24da4c2727d06cb71838",
    label: "USDC transfer",
    detail: "transfer(Address, Address, i128) — one delegated signer",
  },
  {
    hash: "536486a52a275ef2c7ce545c28faf2868c3c1503f8381a26c614caf547ed7114",
    label: "Lending submit — smart account",
    detail: "submit() authorized by an External smart-account signer, nested transfer",
  },
  {
    hash: "83fec6e721997ec5df3f2c63127734a660159186c3d55c571cf9f434907dbe5e",
    label: "Escrow settle",
    detail: "settle(bytes, Address, 4× i128) with a nested transfer sub-invocation",
  },
  {
    hash: "d4af53a22cd6c2e39769db7c4780eccf3138787cd4175271edfe1086c7f7971d",
    label: "Escrow refund — two signers",
    detail: "refund(bytes) requiring two delegated signers",
  },
  {
    hash: "681749a13a68f6dfb2b23077993943ebbcdebe9d79ad2b3f3abd1d90fbf279a5",
    label: "DEX transact — map arg",
    detail: "transact(map) signed by an account and a contract, nested transfer",
  },
];
