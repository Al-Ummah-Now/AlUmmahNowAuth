import { describe, expect, it } from "vitest";
import { MODERATION_ACTION_LABELS, MODERATION_STATUS_CLASSES, MODERATION_STATUS_LABELS, label, userPageHref } from "./moderation";

describe("moderation page helpers", () => {
  it("links a request's user to the Users page search", () => {
    expect(userPageHref({ id: "usr_1", email: "a+b@example.com" })).toBe("/users?q=a%2Bb%40example.com");
    expect(userPageHref({ id: "usr_1", email: null })).toBe("/users?q=usr_1");
  });
  it("labels every status and action, and falls back to the raw value", () => {
    for (const s of ["pending", "info_requested", "approved", "rejected", "actioned"]) {
      expect(MODERATION_STATUS_LABELS[s]).toBeTruthy();
      expect(MODERATION_STATUS_CLASSES[s]).toBeTruthy();
    }
    expect(label(MODERATION_ACTION_LABELS, "revoke_sessions")).toBe("Sign out everywhere");
    expect(label(MODERATION_ACTION_LABELS, "new_thing")).toBe("new_thing");
  });
});
