import { describe, expect, it } from "vitest";
import { ModelCatalogEntrySchema } from "./domain.js";
import { ModelRoleSchema, modelSupportsRole } from "./model-roles.js";

const entry = (protocol: "chat" | "decisions") =>
  ModelCatalogEntrySchema.parse({
    provider: "openrouter",
    id: "model-1",
    label: "Model 1",
    billing: "metered",
    protocol,
  });

describe("model roles", () => {
  it("accepts a coding role alongside main and approval", () => {
    expect(ModelRoleSchema.parse("coding")).toBe("coding");
    expect(ModelRoleSchema.safeParse("chat").success).toBe(false);
  });

  it("lets a coding model run anywhere a main model can", () => {
    expect(modelSupportsRole(entry("chat"), "coding")).toBe(true);
    expect(modelSupportsRole(entry("decisions"), "coding")).toBe(false);
    expect(modelSupportsRole(entry("decisions"), "approval")).toBe(true);
  });
});
