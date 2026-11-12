import { describe, expect, it } from "vitest";
import { otherApps } from "./app-links";

describe("otherApps (account menu, AlUmmahNow docs/design/NAV.md)", () => {
  it("lists every other app in the shared order and labels, from the auth server's host", () => {
    expect(otherApps("https://auth.qa.alummahnow.net")).toEqual([
      { id: "www", label: "Website", href: "https://www.qa.alummahnow.net/en/" },
      { id: "videos", label: "Videos", href: "https://videos.qa.alummahnow.net/en" },
      { id: "profile", label: "Your profile", href: "https://profile.auth.qa.alummahnow.net/?lang=en" },
      { id: "cms", label: "Content management", href: "https://cms.qa.alummahnow.net/?lang=en" },
      { id: "admin", label: "Videos admin", href: "https://admin.qa.alummahnow.net" },
    ]);
  });

  it("lists nothing for a local or unknown auth host", () => {
    expect(otherApps("http://localhost:8787")).toEqual([]);
    expect(otherApps("not a url")).toEqual([]);
  });
});
