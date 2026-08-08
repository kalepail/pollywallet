import { getSandbox, parseSSEStream, type ExecEvent, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { parseTestOutput } from "./parse-test-output";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
};

interface CompileRequest {
  cargoToml: string;
  libRs: string;
}

interface TestRequest {
  cargoToml: string;
  libRs: string;
  testCode: string;
}

/**
 * The container that compiles and RUNS untrusted, AI-generated Rust. `cargo test` builds and
 * executes a native host binary, so a generated `lib.rs` that omits `#![no_std]` can use
 * std::fs / std::process / sockets for the length of the test timeout. Treat everything in
 * this container as readable by an attacker.
 */
const SANDBOX_ID = "policy-compiler";

/**
 * Deployment runs in a SEPARATE sandbox, and this is a security boundary, not tidiness.
 * stellar-cli writes the funded `deployer` identity to ~/.config/stellar/identities/ as the
 * same Unix user that hostile test code runs as. While deploy shared SANDBOX_ID, any
 * generated test could read that seed and exfiltrate it through the streamed test output.
 * Distinct ids mean distinct Durable Objects, hence distinct containers and filesystems.
 * Never run untrusted code under this id.
 */
const DEPLOY_SANDBOX_ID = "policy-deployer";

/**
 * Where the image staged its prebuilt dependency graphs and the Cargo.lock they were compiled
 * from. See sandbox-worker/Dockerfile.
 */
const PREBUILD_DIR = "/opt/policy-prebuild";

/**
 * Each request gets its own project directory. All requests previously shared
 * `/workspace/policy-contract`, so two concurrent users would overwrite each
 * other's `lib.rs` and could be handed back the wrong contract's WASM.
 *
 * `CARGO_TARGET_DIR` stays shared so the crate cache is still reused; cargo
 * takes a lock on it, which serializes concurrent builds instead of corrupting
 * them.
 */
const CARGO_ENV = "CARGO_TARGET_DIR=/workspace/cargo-target";

function newProjectDir(): string {
  return `/workspace/policy-${crypto.randomUUID()}`;
}

/**
 * Best-effort purge of credentials left over from when deploy shared this container.
 *
 * This is NOT key rotation. It deletes a key that untrusted test code may already have read,
 * so it limits future exposure and nothing more. The exposed key must be treated as
 * compromised and abandoned independently of this. Idempotent and cheap; failures are
 * swallowed so cleanup can never break a build.
 */
async function purgeStaleCredentials(sandbox: ReturnType<typeof getSandbox>) {
  await sandbox
    .exec("rm -rf ~/.config/stellar/identities /root/.config/stellar/identities")
    .catch(() => {
      // Best-effort: never fail a build because cleanup could not run.
    });
}

/** Remove a finished job's project directory. Nothing else ever deletes these. */
async function removeProjectDir(
  sandbox: ReturnType<typeof getSandbox>,
  projectDir: string
) {
  // Guard the interpolation: only ever delete a path this module generated.
  if (!/^\/workspace\/policy-[0-9a-f-]{36}$/.test(projectDir)) return;
  await sandbox.exec(`rm -rf ${projectDir}`).catch(() => {});
}

/**
 * Reuse the Cargo.lock the image's prebuilt artifacts were compiled from.
 *
 * Without it, cargo re-resolves versions per request and a newer semver-compatible release
 * silently invalidates the entire prebuilt dependency graph — putting you back on cold builds
 * while the image still carries the (now useless) 1.3 GiB of artifacts.
 */
async function seedLockfile(
  sandbox: ReturnType<typeof getSandbox>,
  projectDir: string
) {
  await sandbox
    .exec(`cp ${PREBUILD_DIR}/Cargo.lock ${projectDir}/Cargo.lock`)
    .catch(() => {
      // Older image without a prebuild: fall through and let cargo resolve normally.
    });
}

async function setupProject(
  sandbox: ReturnType<typeof getSandbox>,
  projectDir: string,
  cargoToml: string,
  libRs: string
) {
  await sandbox.exec(`mkdir -p ${projectDir}/src`);
  await sandbox.writeFile(`${projectDir}/Cargo.toml`, cargoToml);
  await sandbox.writeFile(`${projectDir}/src/lib.rs`, libRs);
  await seedLockfile(sandbox, projectDir);
}

async function handleCompile(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as CompileRequest;
  const { cargoToml, libRs } = body;

  if (!cargoToml || !libRs) {
    return Response.json(
      { success: false, errors: ["cargoToml and libRs are required"] },
      { status: 400 }
    );
  }

  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
  const projectDir = newProjectDir();

  try {
    await purgeStaleCredentials(sandbox);
    await setupProject(sandbox, projectDir, cargoToml, libRs);

    // Dependencies are prebuilt into CARGO_TARGET_DIR by the image; setupProject seeded the
    // matching Cargo.lock so this reuses them instead of recompiling ~180 crates.
    const buildResult = await sandbox.exec(
      `${CARGO_ENV} stellar contract build --out-dir target`,
      {
        cwd: projectDir,
        timeout: 180_000,
      }
    );

    if (!buildResult.success) {
      // Parse compiler errors from stderr
      const errors = buildResult.stderr
        .split("\n")
        .filter((line: string) => line.includes("error"))
        .slice(0, 20);

      const warnings = buildResult.stderr
        .split("\n")
        .filter((line: string) => line.includes("warning"))
        .slice(0, 20);

      return Response.json({
        success: false,
        errors: errors.length > 0 ? errors : [buildResult.stderr.slice(0, 2000)],
        warnings,
        wasmBase64: null,
      });
    }

    // Read the compiled WASM file
    const wasmPath = `${projectDir}/target/policy_contract.wasm`;
    const existsResult = await sandbox.exec(`test -f ${wasmPath} && echo "exists"`);

    let wasmBase64: string | null = null;
    if (existsResult.stdout.trim() === "exists") {
      const base64Result = await sandbox.exec(`base64 -w 0 ${wasmPath}`);
      if (base64Result.success) {
        wasmBase64 = base64Result.stdout.trim();
      }
    }

    // Collect warnings from build output
    const warnings = buildResult.stderr
      .split("\n")
      .filter((line: string) => line.includes("warning"))
      .slice(0, 20);

    return Response.json({
      success: true,
      errors: [],
      warnings,
      wasmBase64,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Sandbox compile failed";
    return Response.json(
      { success: false, errors: [message], warnings: [], wasmBase64: null },
      { status: 500 }
    );
  } finally {
    // Nothing else deletes these. Every request creates a new project dir, so without this
    // the shared container's disk grows without bound and each job's source stays readable
    // by the next job's untrusted test code.
    await removeProjectDir(sandbox, projectDir);
  }
}

/**
 * Run the tests and stream every line cargo prints back to the caller as SSE.
 *
 * A cold run downloads ~180 crates and compiles them, which takes minutes —
 * a single blocking response left the UI with nothing to show for it. Here
 * `cargo test` does the fetch itself (same on-disk cache the separate
 * `cargo fetch` warmed) so the download is part of the streamed output.
 */
async function handleTestStream(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as TestRequest;
  const { cargoToml, libRs, testCode } = body;

  if (!cargoToml || !libRs) {
    return Response.json(
      {
        success: false,
        compiled: false,
        testCases: [],
        compileOutput: "cargoToml and libRs are required",
      },
      { status: 400 }
    );
  }

  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
  const projectDir = newProjectDir();
  const fullLibRs = testCode
    ? `${libRs}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use soroban_sdk::{Env, Address};\n\n${testCode}\n}`
    : libRs;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

      let output = "";
      try {
        await purgeStaleCredentials(sandbox);
        send({ type: "log", text: `Writing project to ${projectDir}` });
        await sandbox.exec(`mkdir -p ${projectDir}/src`);
        await sandbox.writeFile(`${projectDir}/Cargo.toml`, cargoToml);
        await sandbox.writeFile(`${projectDir}/src/lib.rs`, fullLibRs);
        // Same lockfile the image's prebuilt artifacts were compiled from — without it cargo
        // re-resolves and can miss the whole warm cache.
        await seedLockfile(sandbox, projectDir);
        send({ type: "log", text: "$ cargo test --locked --offline" });

        // --locked: never re-resolve, so the prebuilt dependency graph stays valid.
        // --offline: every dependency is already vendored in the image; going to the network
        // here means something is wrong, and failing fast beats a silent 2-minute download.
        const events = await sandbox.execStream(`${CARGO_ENV} cargo test --locked --offline 2>&1`, {
          cwd: projectDir,
          timeout: 300_000,
        });

        let exitCode: number | null = null;
        for await (const event of parseSSEStream<ExecEvent>(events)) {
          if ((event.type === "stdout" || event.type === "stderr") && event.data) {
            output += event.data;
            for (const line of event.data.split("\n")) {
              if (line.trim()) send({ type: "log", text: line });
            }
          } else if (event.type === "complete") {
            exitCode = event.exitCode ?? null;
          } else if (event.type === "error" && event.error) {
            send({ type: "log", text: event.error });
          }
        }

        send({ type: "result", result: parseTestOutput(output, exitCode === 0) });
      } catch (err: unknown) {
        send({
          type: "result",
          result: {
            success: false,
            compiled: false,
            testCases: [],
            compileOutput: err instanceof Error ? err.message : "Sandbox test failed",
          },
        });
      } finally {
        await removeProjectDir(sandbox, projectDir);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

interface DeployRequest {
  wasmBase64: string;
}

async function handleDeploy(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as DeployRequest;
  const { wasmBase64 } = body;

  if (!wasmBase64) {
    return Response.json(
      { success: false, error: "wasmBase64 is required", wasmHash: null, contractAddress: null },
      { status: 400 }
    );
  }

  // Deploy-only container — holds the signing key, never runs untrusted code.
  const sandbox = getSandbox(env.Sandbox, DEPLOY_SANDBOX_ID);
  const projectDir = newProjectDir();

  try {
    // Write the WASM file using the sandbox file API
    const wasmPath = `${projectDir}/target/policy_contract.wasm`;
    await sandbox.exec(`mkdir -p ${projectDir}/target`);

    // Write base64 to a file, then decode it
    await sandbox.writeFile(`${wasmPath}.b64`, wasmBase64);
    await sandbox.exec(`base64 -d ${wasmPath}.b64 > ${wasmPath}`);

    // Verify the file exists and is valid WASM
    const verifyResult = await sandbox.exec(`wc -c < ${wasmPath}`);
    const fileSize = parseInt(verifyResult.stdout.trim(), 10);
    if (!fileSize || fileSize < 100) {
      return Response.json({
        success: false,
        error: `WASM file is too small or invalid (${fileSize} bytes)`,
        wasmHash: null,
        contractAddress: null,
      });
    }

    // Generate a new identity for deployment (or reuse existing)
    const identityCheckResult = await sandbox.exec(
      "stellar keys address deployer 2>/dev/null || echo 'NOT_FOUND'",
      { timeout: 10_000 }
    );

    if (identityCheckResult.stdout.trim() === "NOT_FOUND" || !identityCheckResult.stdout.trim().startsWith("G")) {
      // Generate a new keypair and fund it via friendbot
      await sandbox.exec("stellar keys generate deployer --network testnet --fund 2>&1", {
        timeout: 60_000,
      });
    }

    // Get the deployer's public key
    const addressResult = await sandbox.exec("stellar keys address deployer 2>/dev/null");
    const deployerAddress = addressResult.stdout.trim();

    if (!deployerAddress || !deployerAddress.startsWith("G")) {
      return Response.json({
        success: false,
        error: `Failed to get deployer address: stdout=${addressResult.stdout} stderr=${addressResult.stderr}`,
        wasmHash: null,
        contractAddress: null,
      });
    }

    // Deploy the contract using stellar-cli in two separate steps to avoid
    // timing issues where the WASM upload hasn't propagated before deploy runs.

    // Step 1: Install (upload) the WASM to the network
    const installResult = await sandbox.exec(
      `stellar contract install --wasm ${wasmPath} --source-account deployer --network testnet 2>&1`,
      { timeout: 120_000 }
    );

    const installOutput = (installResult.stdout + installResult.stderr).trim();

    // The install command must succeed before we extract the hash.
    // Otherwise the CLI may print the locally-computed hash in an error
    // message and we'd try to deploy code that never made it on-ledger.
    if (!installResult.success) {
      // If the deployer is out of funds, try to re-fund and retry once
      if (installOutput.includes("insufficient") || installOutput.includes("NotFound") || installOutput.includes("not found")) {
        await sandbox.exec(
          `stellar keys fund deployer --network testnet 2>&1`,
          { timeout: 60_000 }
        );

        const retryResult = await sandbox.exec(
          `stellar contract install --wasm ${wasmPath} --source-account deployer --network testnet 2>&1`,
          { timeout: 120_000 }
        );

        const retryOutput = (retryResult.stdout + retryResult.stderr).trim();
        if (!retryResult.success) {
          return Response.json({
            success: false,
            error: `WASM install failed after re-funding deployer: ${retryOutput.slice(0, 2000)}`,
            wasmHash: null,
            contractAddress: null,
          });
        }

        // Use the retry output for hash extraction below
        Object.assign(installResult, retryResult);
      } else {
        return Response.json({
          success: false,
          error: `WASM install failed (exit code non-zero): ${installOutput.slice(0, 2000)}`,
          wasmHash: null,
          contractAddress: null,
        });
      }
    }

    // Extract the WASM hash — only from successful install output.
    // The hash is the last 64-char hex string (the CLI may print a
    // transaction hash before it).
    const finalOutput = (installResult.stdout + installResult.stderr).trim();
    const allHashes = [...finalOutput.matchAll(/([a-f0-9]{64})/g)].map(m => m[1]);
    const wasmHash = allHashes.length > 0 ? allHashes[allHashes.length - 1] : null;

    if (!wasmHash) {
      return Response.json({
        success: false,
        error: `WASM install succeeded but no hash found in output: ${finalOutput.slice(0, 2000)}`,
        wasmHash: null,
        contractAddress: null,
      });
    }

    // Step 2: Deploy the contract from the installed WASM hash
    // Retry up to 5 times with increasing delays to handle propagation timing
    let contractAddress: string | null = null;
    let deployOutput = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const deployResult = await sandbox.exec(
        `stellar contract deploy --wasm-hash ${wasmHash} --source-account deployer --network testnet 2>&1`,
        { timeout: 120_000 }
      );

      deployOutput = (deployResult.stdout + deployResult.stderr).trim();

      // Extract the contract address (C... format, 56 chars)
      const addrMatch = deployOutput.match(/(C[A-Z2-7]{55})/);
      if (addrMatch) {
        contractAddress = addrMatch[1];
        break;
      }

      // If it looks like a propagation error, retry
      if (deployOutput.includes("not found") || deployOutput.includes("NotFound")) {
        continue;
      }

      // Other error, don't retry
      break;
    }

    if (!contractAddress) {
      return Response.json({
        success: false,
        error: `Deploy failed after retries: ${deployOutput.slice(0, 2000)}`,
        wasmHash,
        contractAddress: null,
      });
    }

    return Response.json({
      success: true,
      error: null,
      wasmHash,
      contractAddress,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Deploy failed";
    return Response.json(
      { success: false, error: message, wasmHash: null, contractAddress: null },
      { status: 500 }
    );
  } finally {
    await removeProjectDir(sandbox, projectDir);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    switch (url.pathname) {
      case "/compile":
        return handleCompile(request, env);
      case "/test/stream":
        return handleTestStream(request, env);
      case "/deploy":
        return handleDeploy(request, env);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
