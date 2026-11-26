import { describe, expect, it } from "vitest";
import { roleDescription, roleLabel } from "../../../../packages/ui/src/role-names.ts";

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
  it.each([
    ["Billing Admin", "billing_admin", "مشرف الفوترة"],
    ["Billing Viewer", "billing_viewer", "مطّلع على الفوترة"],
  ])("localizes %s consistently from the claim or the role ID", (name, id, arabic) => {
    for (const role of [name, id]) {
      expect(roleLabel(role, "en")).toBe(name);
      expect(roleLabel(role, "ar")).toBe(arabic);
    }
  });
  it("keeps an unknown role's own name in Arabic", () => {
    expect(roleLabel("Translator", "ar")).toBe("Translator");
  });
});

describe("roleDescription", () => {
  it("shows a built-in role's seeded description in Arabic, anything else as written", () => {
    expect(roleDescription("Administrative access", "ar")).toBe("صلاحيات الإدارة");
    expect(roleDescription("Administrative access", "en")).toBe("Administrative access");
    expect(roleDescription("مراجعة الترجمات", "ar")).toBe("مراجعة الترجمات");
    expect(roleDescription(null, "ar")).toBe("");
  });
});
