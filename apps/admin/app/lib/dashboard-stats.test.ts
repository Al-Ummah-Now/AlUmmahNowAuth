import { describe, expect, it } from "vitest";
import { roleStatsOf, usersByRoleOf, type RoleCounts } from "./admin-api.server";

// The dashboard's cards and chart (routes/_index.tsx): Total Roles was a stub that always said 0,
// and Admin Users and the chart counted only the newest 100 users
describe("dashboard figures", () => {
  it("Total Roles counts the roles the roles page lists, system and custom", () => {
    expect(roleStatsOf([{ is_system_role: true }, { is_system_role: true }, { is_system_role: false }])).toEqual({ totalRoles: 3, systemRoles: 2, customRoles: 1 });
    expect(roleStatsOf([])).toEqual({ totalRoles: 0, systemRoles: 0, customRoles: 0 });
  });

  it("the chart shows the roles held by the most users, from the counts over every user", () => {
    const counts: RoleCounts = {
      roles: [
        { id: "role_admin", name: "Admin", user_count: 40 },
        { id: "role_member", name: "Member", user_count: 45000 },
        { id: "role_super_admin", name: "Super Admin", user_count: 1 },
        { id: "role_moderator", name: "Moderator", user_count: 3 },
        { id: "role_creator", name: "Creator", user_count: 3 },
        { id: "role_unused", name: "Unused", user_count: 0 },
      ],
      admin_users: 41,
    };
    expect(usersByRoleOf(counts, 5)).toEqual([
      { name: "Member", user_count: 45000 },
      { name: "Admin", user_count: 40 },
      { name: "Creator", user_count: 3 },
      { name: "Moderator", user_count: 3 },
      { name: "Super Admin", user_count: 1 },
    ]);
    expect(usersByRoleOf({ roles: [], admin_users: 0 })).toEqual([]);
  });
});
