import { describe, expect, it } from "vitest";
import { roleLabel } from "../../../../packages/ui/src/role-names.ts";

describe("roleLabel", () => {
  it("names a role in Arabic on an Arabic page, whatever its spelling", () => {
    expect(roleLabel("Admin", "ar")).toBe("مشرف");
    expect(roleLabel("super_admin", "ar")).toBe("مشرف عام");
    expect(roleLabel("Content-Reviewer", "ar")).toBe("مراجع محتوى");
  });
  it("keeps the role's own name in English and for unknown roles", () => {
    expect(roleLabel("Moderator", "en")).toBe("Moderator");
    expect(roleLabel("Translator", "ar")).toBe("Translator");
  });
});
