import { describe, expect, it } from "vitest";

import { assertModelActive, parsePinnedModel } from "./check-model-catalog.mjs";

const activeModel = "@cf/moonshotai/kimi-k2.7-code";
const capturedCatalogResponse = {
  success: true,
  result: [{ name: activeModel, properties: [] }],
  errors: [],
};

describe("Workers AI model catalog check", () => {
  it("reads the pinned model", () => {
    expect(
      parsePinnedModel(`export const POLICY_CODEGEN_MODEL = "${activeModel}";`),
    ).toBe(activeModel);
  });

  it("accepts the active model from a captured catalog response", () => {
    expect(() => assertModelActive(capturedCatalogResponse, activeModel)).not.toThrow();
  });

  it("rejects Cloudflare's deprecation flag", () => {
    const deprecated = structuredClone(capturedCatalogResponse);
    deprecated.result[0].properties.push({
      property_id: "planned_deprecation_date",
      value: "2026-05-30",
    });

    expect(() => assertModelActive(deprecated, activeModel)).toThrow(
      "deprecated or scheduled for deprecation on 2026-05-30",
    );
  });
});
