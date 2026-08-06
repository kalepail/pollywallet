#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function parsePinnedModel(source) {
  const match = source.match(
    /\bPOLICY_CODEGEN_MODEL\s*=\s*(["'])(?<model>[^"']+)\1/,
  );
  if (!match?.groups?.model) {
    throw new Error("Could not read POLICY_CODEGEN_MODEL from src/lib/constants.ts");
  }
  return match.groups.model;
}

export function assertModelActive(payload, modelName) {
  if (!payload.success || !Array.isArray(payload.result)) {
    const errors = payload.errors?.map(({ message }) => message).join("; ");
    throw new Error(`Cloudflare API request failed${errors ? `: ${errors}` : ""}`);
  }

  const model = payload.result.find(({ name }) => name === modelName);
  if (!model) {
    throw new Error(`${modelName} is missing from the Workers AI model catalog`);
  }

  const deprecationDate = model.properties?.find(
    ({ property_id }) => property_id === "planned_deprecation_date",
  )?.value;
  if (deprecationDate) {
    throw new Error(`${modelName} is deprecated or scheduled for deprecation on ${deprecationDate}`);
  }
}

async function main() {
  const source = await readFile(
    new URL("../src/lib/constants.ts", import.meta.url),
    "utf8",
  );
  const modelName = parsePinnedModel(source);
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } =
    process.env;

  if (!token || !accountId) {
    const missing = [
      !token && "CLOUDFLARE_API_TOKEN",
      !accountId && "CLOUDFLARE_ACCOUNT_ID",
    ].filter(Boolean);
    if (process.env.REQUIRE_MODEL_CATALOG_CHECK === "true") {
      throw new Error(`required secret missing: ${missing.join(" and ")}`);
    }
    console.log(
      `Skipping Workers AI model catalog check for ${modelName}: ${missing.join(" and ")} not set.`,
    );
    return;
  }

  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
  );
  url.searchParams.set("search", modelName);
  url.searchParams.set("include_deprecated", "true");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare API returned HTTP ${response.status}`);
  }
  const payload = await response.json();

  assertModelActive(payload, modelName);
  console.log(`${modelName} is active in the Workers AI model catalog.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Workers AI model catalog check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
