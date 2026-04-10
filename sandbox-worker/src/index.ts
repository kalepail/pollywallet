import { getSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";

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

const SANDBOX_ID = "policy-compiler";
const PROJECT_DIR = "/workspace/policy-contract";

/** Track whether we've fetched dependencies in this container lifetime. */
let depsFetched = false;

async function setupProject(
  sandbox: ReturnType<typeof getSandbox>,
  cargoToml: string,
  libRs: string
) {
  await sandbox.exec(`mkdir -p ${PROJECT_DIR}/src`);
  await sandbox.writeFile(`${PROJECT_DIR}/Cargo.toml`, cargoToml);
  await sandbox.writeFile(`${PROJECT_DIR}/src/lib.rs`, libRs);

  // Fetch dependencies separately on first run. This can take 60-120s
  // on a cold container (downloading ~180 crates). Subsequent runs hit
  // the local cargo cache and are instant.
  if (!depsFetched) {
    const fetchResult = await sandbox.exec("cargo fetch 2>&1", {
      cwd: PROJECT_DIR,
      timeout: 300_000, // 5 minutes for cold dependency download
    });
    if (fetchResult.success) {
      depsFetched = true;
    }
    // Even if fetch fails (network issue), try building anyway —
    // the prefetched crates from the Docker image may be enough.
  }
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

  try {
    await setupProject(sandbox, cargoToml, libRs);

    // Build the contract using stellar-cli (deps already fetched in setupProject)
    const buildResult = await sandbox.exec(
      "stellar contract build --out-dir target",
      {
        cwd: PROJECT_DIR,
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
    const wasmPath = `${PROJECT_DIR}/target/policy_contract.wasm`;
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
  }
}

async function handleTest(
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

  try {
    // If testCode is provided, append it to the lib.rs
    const fullLibRs = testCode ? `${libRs}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use soroban_sdk::{Env, Address};\n\n${testCode}\n}` : libRs;

    await setupProject(sandbox, cargoToml, fullLibRs);

    // Run cargo test (deps already fetched in setupProject)
    const testResult = await sandbox.exec("cargo test 2>&1", {
      cwd: PROJECT_DIR,
      timeout: 240_000,
    });

    const output = testResult.stdout + testResult.stderr;

    // Parse test results from cargo test output
    const testCases: Array<{ name: string; passed: boolean; output: string }> = [];
    const testLineRegex = /test (\S+) \.\.\. (ok|FAILED)/g;
    let match;

    while ((match = testLineRegex.exec(output)) !== null) {
      testCases.push({
        name: match[1],
        passed: match[2] === "ok",
        output: "",
      });
    }

    // Extract per-test failure output from cargo test's stdout sections
    // Format: "---- tests::test_name stdout ----\n...output...\n\n"
    for (const tc of testCases) {
      if (tc.passed) {
        tc.output = "ok";
        continue;
      }
      const sectionRegex = new RegExp(
        `---- ${tc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} stdout ----\\n([\\s\\S]*?)(?=\\n\\n|$)`
      );
      const sectionMatch = output.match(sectionRegex);
      if (sectionMatch) {
        tc.output = sectionMatch[1].trim().slice(0, 2000);
      } else {
        // Try to find the panic message directly
        const panicRegex = new RegExp(
          `thread '${tc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' panicked at ([^\\n]+)`
        );
        const panicMatch = output.match(panicRegex);
        tc.output = panicMatch ? panicMatch[0].slice(0, 2000) : "(test failed — no captured output)";
      }
    }

    // Check if compilation succeeded (tests ran at all)
    const compiled = output.includes("running") || output.includes("test result");
    const hasRealError = output.includes("error[E") || output.includes("error: could not compile");
    const success = testResult.success && testCases.every((tc) => tc.passed);

    // If not compiled and no real error, this was likely a timeout during
    // dependency download / initial compilation. Report it clearly.
    let compileOutput = output.slice(0, 5000);
    if (!compiled && !hasRealError && !testResult.success) {
      compileOutput = "Build timed out (likely downloading dependencies on first run). Retrying should be faster.\n\n" + compileOutput;
    }

    return Response.json({
      success,
      compiled,
      testCases,
      compileOutput,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Sandbox test failed";
    return Response.json(
      {
        success: false,
        compiled: false,
        testCases: [],
        compileOutput: message,
      },
      { status: 500 }
    );
  }
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

  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

  try {
    // Write the WASM file using the sandbox file API
    const wasmPath = `${PROJECT_DIR}/target/policy_contract.wasm`;
    await sandbox.exec(`mkdir -p ${PROJECT_DIR}/target`);

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

    // Extract the WASM hash from the install output
    const hashMatch = installOutput.match(/([a-f0-9]{64})/);
    const wasmHash = hashMatch ? hashMatch[1] : null;

    if (!wasmHash) {
      return Response.json({
        success: false,
        error: `WASM install failed: ${installOutput.slice(0, 2000)}`,
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
      case "/test":
        return handleTest(request, env);
      case "/deploy":
        return handleDeploy(request, env);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
