import { describe, expect, it } from "vitest";

import { buildCompanyChatModels } from "../components/dashboard/chat/companyModels";

describe("company chat model options", () => {
  it("uses repository defaults only when no deployment allowlist is configured", () => {
    expect(buildCompanyChatModels().map((item) => item.id)).toEqual([
      "deepseek-v4-flash",
      "qwen3.5-397b-a17b",
      "glm-5",
    ]);
  });

  it("treats an explicit deployment list as a strict replacement allowlist", () => {
    expect(buildCompanyChatModels("approved-model,APPROVED-MODEL").map((item) => item.id)).toEqual([
      "approved-model",
    ]);
  });

  it.each(["", "   ", ",", " , , "])("fails the UI build on an explicitly empty allowlist (%j)", (value) => {
    expect(() => buildCompanyChatModels(value)).toThrow("CHAT_MODEL_OPTIONS_INVALID");
  });
});
