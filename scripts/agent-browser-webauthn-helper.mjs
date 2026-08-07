#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_AUTHENTICATOR_OPTIONS = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

function printUsage() {
  console.error(`
Usage:
  node scripts/agent-browser-webauthn-helper.mjs run [options] -- <command> [args...]

Description:
  Attaches a virtual WebAuthn authenticator to a live agent-browser session, keeps the
  CDP attachment open while your command runs, and cleans it up afterward.

Options:
  --session <name>           Existing agent-browser session name
  --cdp-url <ws-url>         Explicit CDP WebSocket URL (overrides --session lookup)
  --url <page-url>           Page URL to bind within the browser session
  --transport <type>         internal | usb | nfc | ble | cable
  --protocol <type>          ctap2 | u2f
  --resident-key <bool>      true | false
  --user-verification <bool> true | false
  --verified <bool>          true | false
  --presence <bool>          true | false
  --require-credential <bool> Fail when no virtual credential is observed

Environment:
  WEBAUTHN_EVENTS_FILE       Optional JSONL diagnostics file
  WEBAUTHN_CONTROL_FILE      Optional file accepting uv:false and uv:true

Examples:
  agent-browser --session demo open http://127.0.0.1:5173

  pnpm agent-browser:webauthn run --session demo -- \\
    agent-browser --session demo snapshot -i

  pnpm agent-browser:webauthn run --session webauthn-demo -- \\
    bash -lc 'agent-browser --session webauthn-demo fill @e53 smoke-user && \\
      agent-browser --session webauthn-demo click @e54 && \\
      agent-browser --session webauthn-demo wait --text Success!'
`);
}

function parseArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const command = normalized[0];
  if (!command) {
    printUsage();
    process.exit(1);
  }

  const separator = normalized.indexOf("--");
  const optionTokens =
    separator === -1 ? normalized.slice(1) : normalized.slice(1, separator);
  const childCommand =
    separator === -1 ? [] : normalized.slice(separator + 1);

  const args = { _: [] };
  for (let i = 0; i < optionTokens.length; i += 1) {
    const token = optionTokens[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = optionTokens[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return { command, args, childCommand };
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value, received "${value}"`);
}

function logDiagnostic(record) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  const file = process.env.WEBAUTHN_EVENTS_FILE;
  if (file) {
    try {
      appendFileSync(file, `${line}\n`);
      return;
    } catch { /* fall through to stderr */ }
  }
  console.error(line);
}

function redactCredential(credential) {
  return {
    credentialIdPrefix: String(credential.credentialId ?? "").slice(0, 16),
    rpId: credential.rpId,
    signCount: credential.signCount,
    isResidentCredential: credential.isResidentCredential,
  };
}

async function runAgentBrowser(args) {
  const { stdout } = await execFileAsync("agent-browser", args, {
    encoding: "utf8",
  });
  return stdout.trim();
}

function getLastNonEmptyLine(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

async function resolveCDPUrl(args) {
  if (args["cdp-url"] && args["cdp-url"] !== true) {
    return args["cdp-url"];
  }

  const session = args.session;
  if (!session || session === true) {
    throw new Error("Provide --session or --cdp-url");
  }

  const output = await runAgentBrowser(["--session", session, "get", "cdp-url"]);
  const cdpUrl = getLastNonEmptyLine(output);
  if (!cdpUrl) {
    throw new Error(`Unable to resolve CDP URL for session "${session}"`);
  }
  return cdpUrl;
}

async function resolveCurrentUrl(args) {
  if (args.url && args.url !== true) {
    return args.url;
  }

  const session = args.session;
  if (!session || session === true) {
    return null;
  }

  const output = await runAgentBrowser(["--session", session, "get", "url"]);
  return getLastNonEmptyLine(output) ?? null;
}

function createCDPConnection(browserWsUrl, onEvent) {
  const socket = new WebSocket(browserWsUrl);
  let nextId = 0;
  const pending = new Map();

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method && !message.id) {
      onEvent?.(message);
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    }
  };

  const ready = new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = (event) => reject(new Error(`WebSocket error: ${event.type}`));
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) {
        payload.sessionId = sessionId;
      }
      socket.send(JSON.stringify(payload));
    });

  const close = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  return { ready, send, close };
}

async function attachToPage(send, preferredUrl) {
  const { targetInfos } = await send("Target.getTargets");
  const pages = targetInfos.filter((target) => target.type === "page");

  const pageTarget =
    (preferredUrl ? pages.find((target) => target.url === preferredUrl) : null) ??
    pages.find((target) => target.url && target.url !== "about:blank") ??
    pages.at(-1);

  if (!pageTarget) {
    throw new Error("Unable to find a page target in the remote browser");
  }

  const { sessionId } = await send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  return {
    sessionId,
    pageUrl: pageTarget.url,
    targetId: pageTarget.targetId,
  };
}

async function runChildCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Child command exited via signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function commandRun(args, childCommand) {
  if (childCommand.length === 0) {
    throw new Error("run requires a child command after --");
  }

  const cdpUrl = await resolveCDPUrl(args);
  const preferredUrl = await resolveCurrentUrl(args);
  const requireCredential = parseBoolean(args["require-credential"], false);
  let credentialAddedCount = 0;
  let credentialAssertedCount = 0;
  const connection = createCDPConnection(cdpUrl, (message) => {
    if (message.method !== "WebAuthn.credentialAdded" &&
        message.method !== "WebAuthn.credentialAsserted") return;
    if (message.method === "WebAuthn.credentialAdded") credentialAddedCount += 1;
    else credentialAssertedCount += 1;
    const params = { ...message.params };
    if (params.credential) params.credential = redactCredential(params.credential);
    logDiagnostic({ event: message.method, params });
  });
  await connection.ready;

  const { sessionId, pageUrl, targetId } = await attachToPage(connection.send, preferredUrl);
  const authenticatorOptions = {
    protocol: args.protocol || DEFAULT_AUTHENTICATOR_OPTIONS.protocol,
    transport: args.transport || DEFAULT_AUTHENTICATOR_OPTIONS.transport,
    hasResidentKey: parseBoolean(
      args["resident-key"],
      DEFAULT_AUTHENTICATOR_OPTIONS.hasResidentKey
    ),
    hasUserVerification: parseBoolean(
      args["user-verification"],
      DEFAULT_AUTHENTICATOR_OPTIONS.hasUserVerification
    ),
    isUserVerified: parseBoolean(
      args.verified,
      DEFAULT_AUTHENTICATOR_OPTIONS.isUserVerified
    ),
    automaticPresenceSimulation: parseBoolean(
      args.presence,
      DEFAULT_AUTHENTICATOR_OPTIONS.automaticPresenceSimulation
    ),
  };

  await connection.send("WebAuthn.enable", { enableUI: false }, sessionId);
  const { authenticatorId } = await connection.send(
    "WebAuthn.addVirtualAuthenticator",
    { options: authenticatorOptions },
    sessionId
  );

  logDiagnostic({
    setup: {
      session: typeof args.session === "string" ? args.session : null,
      pageUrl,
      targetId,
      authenticatorId,
      options: authenticatorOptions,
      enableUI: false,
    },
  });

  let exitCode = 0;
  let controlTimer;
  let credentialFailure = false;
  try {
    const controlFile = process.env.WEBAUTHN_CONTROL_FILE;
    if (controlFile) {
      let lastDirective = "";
      controlTimer = setInterval(() => {
        let directive;
        try {
          directive = readFileSync(controlFile, "utf8").trim().split("\n").at(-1);
        } catch { return; }
        if (!directive || directive === lastDirective) return;
        lastDirective = directive;
        if (directive !== "uv:false" && directive !== "uv:true") return;
        connection.send(
          "WebAuthn.setUserVerified",
          { authenticatorId, isUserVerified: directive === "uv:true" },
          sessionId
        ).then(() => logDiagnostic({ controlApplied: directive }))
          .catch((error) => logDiagnostic({ controlError: String(error) }));
      }, 500);
    }
    exitCode = await runChildCommand(childCommand[0], childCommand.slice(1));
  } finally {
    if (controlTimer) clearInterval(controlTimer);
    try {
      const { credentials } = await connection.send(
        "WebAuthn.getCredentials", { authenticatorId }, sessionId
      );
      logDiagnostic({
        finalCredentials: credentials.map(redactCredential),
        credentialAddedCount,
        credentialAssertedCount,
      });
      if (credentials.length === 0) {
        console.error("Failure: No virtual credential observed");
        credentialFailure = requireCredential;
      }
    } catch (error) {
      logDiagnostic({ getCredentialsError: String(error) });
      credentialFailure = requireCredential;
    }
    try {
      await connection.send(
        "WebAuthn.removeVirtualAuthenticator",
        { authenticatorId },
        sessionId
      );
    } catch (error) {
      console.error(`Cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await connection.send("WebAuthn.disable", {}, sessionId);
    } catch (error) {
      console.error(`Cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }

    connection.close();
  }

  if (exitCode === 0 && credentialFailure) exitCode = 1;
  process.exitCode = exitCode;
}

const { command, args, childCommand } = parseArgs(process.argv.slice(2));

try {
  switch (command) {
    case "run":
      await commandRun(args, childCommand);
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      throw new Error(`Unknown command "${command}"`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
