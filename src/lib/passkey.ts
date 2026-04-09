import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { Buffer } from "buffer";
if (typeof globalThis !== "undefined" && !(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}
import base64url from "base64url";
import { hash, xdr, Address, Keypair, StrKey } from "@stellar/stellar-sdk";

// --- Constants ---
const SECP256R1_PUBLIC_KEY_SIZE = 65;
const UNCOMPRESSED_PUBKEY_PREFIX = 0x04;
const WEBAUTHN_TIMEOUT_MS = 60000;
const SECP256R1_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
);

// --- Testnet contract addresses ---
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_ACCOUNT_WASM_HASH =
  "8537b8166c0078440a5324c12f6db48d6340d157c306a54c5ea81405abcc2611";
export const TESTNET_WEBAUTHN_VERIFIER =
  "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";
export const TESTNET_NATIVE_TOKEN_CONTRACT =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const LEDGERS_PER_HOUR = 720;
export const STROOPS_PER_XLM = 10_000_000;

// Deterministic deployer keypair — same address for all users.
// Contract ID uniqueness comes from the salt (hash of credential ID), not the deployer.
// This account only needs to exist on-chain once (funded by friendbot on first use).
export const DEPLOYER_KEYPAIR = Keypair.fromRawEd25519Seed(
  hash(Buffer.from("pollywallet")) as Buffer
);

// --- Types ---
export interface StoredWallet {
  credentialId: string;
  contractId: string;
  publicKey: string; // hex-encoded 65-byte key
}

// --- WebAuthn ---
export async function createPasskey(
  appName: string,
  userName: string
): Promise<{ credentialId: string; publicKey: Uint8Array }> {
  const challenge = base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));

  const options: PublicKeyCredentialCreationOptionsJSON = {
    challenge,
    rp: { name: appName },
    user: {
      id: base64url(`${userName}:${Date.now()}`),
      name: userName,
      displayName: userName,
    },
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    timeout: WEBAUTHN_TIMEOUT_MS,
  };

  const response = await startRegistration({ optionsJSON: options });
  const publicKey = await extractPublicKey(response.response);

  return { credentialId: response.id, publicKey };
}

export async function signWithPasskey(
  credentialId: string,
  challenge: Buffer
): Promise<{
  signature: Uint8Array;
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
}> {
  const authOptions: PublicKeyCredentialRequestOptionsJSON = {
    challenge: base64url(challenge),
    userVerification: "preferred",
    timeout: WEBAUTHN_TIMEOUT_MS,
    allowCredentials: [{ id: credentialId, type: "public-key" }],
  };

  const response = await startAuthentication({ optionsJSON: authOptions });

  return {
    signature: compactSignature(base64url.toBuffer(response.response.signature)),
    authenticatorData: base64url.toBuffer(response.response.authenticatorData),
    clientDataJSON: base64url.toBuffer(response.response.clientDataJSON),
  };
}

// --- Soroban Auth Helpers ---

export function buildSignaturePayload(
  networkPassphrase: string,
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number
): Buffer {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: entry.credentials().address().nonce(),
      signatureExpirationLedger: expiration,
      invocation: entry.rootInvocation(),
    })
  );
  return hash(preimage.toXDR()) as Buffer;
}

export function buildAuthDigest(
  signaturePayload: Buffer,
  contextRuleIds: number[]
): Buffer {
  const ruleIdsXdr = xdr.ScVal.scvVec(
    contextRuleIds.map((id) => xdr.ScVal.scvU32(id))
  ).toXDR();
  return hash(Buffer.concat([signaturePayload, ruleIdsXdr])) as Buffer;
}

export function buildWebAuthnSigBytes(sigData: {
  signature: Uint8Array;
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
}): Buffer {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("authenticator_data"),
      val: xdr.ScVal.scvBytes(sigData.authenticatorData),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("client_data"),
      val: xdr.ScVal.scvBytes(sigData.clientDataJSON),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature"),
      val: xdr.ScVal.scvBytes(Buffer.from(sigData.signature)),
    }),
  ]).toXDR() as Buffer;
}

export function writeAuthPayload(
  contextRuleIds: number[],
  signer: { tag: "External"; values: readonly [string, Buffer] },
  signatureBytes: Buffer
): xdr.ScVal {
  const signerScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(signer.values[0]).toScAddress()),
    xdr.ScVal.scvBytes(signer.values[1]),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerScVal,
          val: xdr.ScVal.scvBytes(signatureBytes),
        }),
      ]),
    }),
  ]);
}

/** Sign auth entries with a regular Stellar keypair for relayer submission. */
export function signKeypairAuthEntries(
  authEntries: xdr.SorobanAuthorizationEntry[],
  keypair: Keypair,
  expiration: number,
  networkPassphrase: string
): xdr.SorobanAuthorizationEntry[] {
  const networkId = hash(Buffer.from(networkPassphrase));

  function makeSignature(nonce: xdr.Int64, invocation: xdr.SorobanAuthorizedInvocation) {
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce,
        signatureExpirationLedger: expiration,
        invocation,
      })
    );
    return keypair.sign(hash(preimage.toXDR()));
  }

  function addressSignatureScVal(signature: Buffer) {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("public_key"),
          val: xdr.ScVal.scvBytes(keypair.rawPublicKey()),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("signature"),
          val: xdr.ScVal.scvBytes(signature),
        }),
      ]),
    ]);
  }

  return authEntries.map((entry) => {
    const credType = entry.credentials().switch().name;

    if (credType === "sorobanCredentialsSourceAccount") {
      const nonce = xdr.Int64.fromString(Date.now().toString());
      const sig = makeSignature(nonce, entry.rootInvocation());

      return new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(keypair.publicKey()).toScAddress(),
            nonce,
            signatureExpirationLedger: expiration,
            signature: addressSignatureScVal(sig),
          })
        ),
        rootInvocation: entry.rootInvocation(),
      });
    }

    if (credType === "sorobanCredentialsAddress") {
      const credentials = entry.credentials().address();
      credentials.signatureExpirationLedger(expiration);
      const sig = makeSignature(credentials.nonce(), entry.rootInvocation());
      credentials.signature(addressSignatureScVal(sig));
      return entry;
    }

    return entry;
  });
}

// --- Key Data / Contract Address ---

export function buildKeyData(publicKey: Uint8Array, credentialId: string): Buffer {
  return Buffer.concat([Buffer.from(publicKey), base64url.toBuffer(credentialId)]);
}

export function deriveContractAddress(
  credentialId: Buffer,
  deployerPublicKey: string,
  networkPassphrase: string
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployerPublicKey).toScAddress(),
          salt: hash(credentialId),
        })
      ),
    })
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export function toI128(stroops: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString((stroops & 0xFFFFFFFFFFFFFFFFn).toString()),
      hi: xdr.Int64.fromString((stroops >> 64n).toString()),
    })
  );
}

// --- LocalStorage ---
const STORAGE_KEY = "pollywallet:wallet";

export function saveWallet(wallet: StoredWallet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
}

export function loadWallet(): StoredWallet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredWallet : null;
  } catch {
    return null;
  }
}

export function clearWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// --- Internal Crypto Helpers ---

async function extractPublicKey(
  response: { publicKey?: string; authenticatorData?: string; attestationObject?: string }
): Promise<Uint8Array> {
  if (response.publicKey) {
    const encoded = base64url.toBuffer(response.publicKey);

    if (encoded.length === SECP256R1_PUBLIC_KEY_SIZE && encoded[0] === UNCOMPRESSED_PUBKEY_PREFIX) {
      return new Uint8Array(encoded);
    }

    if (typeof crypto?.subtle !== "undefined") {
      try {
        const imported = await crypto.subtle.importKey(
          "spki", new Uint8Array(encoded),
          { name: "ECDSA", namedCurve: "P-256" }, true, []
        );
        const rawKey = await crypto.subtle.exportKey("raw", imported);
        return new Uint8Array(rawKey);
      } catch { /* fall through */ }
    }

    const sliced = encoded.slice(encoded.length - SECP256R1_PUBLIC_KEY_SIZE);
    if (sliced[0] === UNCOMPRESSED_PUBKEY_PREFIX) return new Uint8Array(sliced);
  }

  if (response.authenticatorData) {
    const authData = base64url.toBuffer(response.authenticatorData);
    const credIdLen = (authData[53] << 8) | authData[54];
    const x = authData.slice(65 + credIdLen, 97 + credIdLen);
    const y = authData.slice(100 + credIdLen, 132 + credIdLen);
    return new Uint8Array([UNCOMPRESSED_PUBKEY_PREFIX, ...x, ...y]);
  }

  throw new Error("Could not extract public key from attestation");
}

function compactSignature(derSignature: Buffer): Uint8Array {
  let offset = 2;
  const rLength = derSignature[offset + 1];
  const r = derSignature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  const sLength = derSignature[offset + 1];
  const s = derSignature.slice(offset + 2, offset + 2 + sLength);

  const rBigInt = BigInt("0x" + r.toString("hex"));
  let sBigInt = BigInt("0x" + s.toString("hex"));
  const halfN = SECP256R1_ORDER / 2n;
  if (sBigInt > halfN) sBigInt = SECP256R1_ORDER - sBigInt;

  const rPadded = Buffer.from(rBigInt.toString(16).padStart(64, "0"), "hex");
  const sLowS = Buffer.from(sBigInt.toString(16).padStart(64, "0"), "hex");
  return new Uint8Array(Buffer.concat([rPadded, sLowS]));
}
