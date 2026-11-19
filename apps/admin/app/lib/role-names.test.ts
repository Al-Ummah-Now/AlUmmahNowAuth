import { describe, expect, it } from "vitest";
import { roleLabel } from "../../../../packages/ui/src/role-names.ts";

describe("roleLabel", () => {
  it("names a role in Arabic on an Arabic page, whatever its spelling", () => {
    expect(roleLabel("Admin", "ar")).toBe("مشرف");
    expect(roleLabel("super_admin", "ar")).toBe("مشرف عام");
    expect(roleLabel("Content-Reviewer", "ar")).toBe("مراجع محتوى");
  });
  it("writes English roles in sentence case, as Profile does", () => {
    expect(roleLabel("Admin", "en")).toBe("Admin");
    expect(roleLabel("MODERATOR", "en")).toBe("Moderator");
    expect(roleLabel("super_admin", "en")).toBe("Super admin");
    expect(roleLabel("Content Reviewer", "en")).toBe("Content reviewer");
  });
  it("keeps an unknown role's own name in Arabic", () => {
    expect(roleLabel("Translator", "ar")).toBe("Translator");
  });
});
