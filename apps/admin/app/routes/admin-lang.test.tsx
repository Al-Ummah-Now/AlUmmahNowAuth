// @vitest-environment happy-dom
/**
 * Language persistence (?lang=ar) across admin search/filter forms and actions,
 * localized dialog close label, and localized action errors (English + Arabic).
 * Language comes strictly from ?lang=ar — never Accept-Language or cookies.
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { cloudflareLoadContext } from "../lib/cloudflare-context";
import { adminCopy } from "../lib/admin-copy";
import { pagesCopy } from "../lib/pages-copy";

const mockRequireAuth = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockNavigate = vi.fn();
let mockLoaderData: unknown = {};
let mockSearchParams = new URLSearchParams();

vi.mock("../lib/auth.server", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  requireStepUp: vi.fn(),
}));

vi.mock("../components/admin-layout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

vi.mock("../components/autocomplete", () => ({
  UserAutocomplete: (props: {
    testId?: string;
    onSearch?: (q: string) => void;
    hrefFor?: (s: { id: string; label: string; secondary?: string }) => string;
    onChange?: (id: string) => void;
  }) => (
    <div data-testid={props.testId ?? "autocomplete"}>
      {props.onSearch && (
        <>
          <button type="button" data-testid="trigger-search" onClick={() => props.onSearch!("ali@example.com")}>
            search
          </button>
          <button type="button" data-testid="trigger-search-empty" onClick={() => props.onSearch!("")}>
            clear-search
          </button>
        </>
      )}
      {props.hrefFor && (
        <a
          data-testid="suggestion-link"
          href={props.hrefFor({ id: "u2", label: "Ali", secondary: "ali@example.com" })}
        >
          Ali
        </a>
      )}
      {props.onChange && (
        <button type="button" data-testid="pick-user" onClick={() => props.onChange!("u-picked")}>
          pick
        </button>
      )}
    </div>
  ),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => mockLoaderData,
    useNavigate: () => mockNavigate,
    useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
    useRevalidator: () => ({ revalidate: vi.fn() }),
    useSearchParams: () => [mockSearchParams, vi.fn()],
  };
});

const sessionsMod = await import("./sessions");
const auditMod = await import("./audit");
const usersMod = await import("./users._index");
const clientsMod = await import("./clients");
const loginMod = await import("./login");

const ADMIN_USER = { id: "admin-1", email: "admin@example.com", roles: ["Admin"] };

function actionArgs(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  const request = new Request(new URL(path, "https://admin.auth.example"), {
    method: "POST",
    headers,
    body: fd,
  });
  return {
    request,
    params: {},
    context: cloudflareLoadContext({ AUTH_STORAGE: {} as KVNamespace }, undefined),
  } as never;
}

describe("admin ?lang=ar persistence and localized UI/action copy", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockRequireAuth.mockResolvedValue(ADMIN_USER);
    mockGetAuthenticatedUser.mockResolvedValue({ user: ADMIN_USER });
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  describe("/sessions GET filter form", () => {
    const sessionsData = {
      sessions: [],
      stats: { totalSessions: 0, activeSessions: 0, loginsLast24h: 0, uniqueUsers: 0 },
      suspicious: { multipleIPsInShortTime: [], failedThenSuccessfulLogins: [] },
      total: 0,
      limit: 50,
      offset: 0,
      user: { id: ADMIN_USER.id, email: ADMIN_USER.email },
      authServerUrl: "https://auth.example",
    };

    it("includes hidden lang=ar input on ?lang=ar", () => {
      mockLoaderData = sessionsData;
      mockSearchParams = new URLSearchParams("lang=ar");
      const { container } = render(
        <MemoryRouter initialEntries={["/sessions?lang=ar"]}>
          <sessionsMod.default />
        </MemoryRouter>,
      );
      const hidden = container.querySelector('form[method="get"] input[type="hidden"][name="lang"]') as HTMLInputElement | null;
      expect(hidden).not.toBeNull();
      expect(hidden?.value).toBe("ar");
    });

    it("omits hidden lang input in English", () => {
      mockLoaderData = sessionsData;
      mockSearchParams = new URLSearchParams();
      const { container } = render(
        <MemoryRouter initialEntries={["/sessions"]}>
          <sessionsMod.default />
        </MemoryRouter>,
      );
      expect(container.querySelector('form[method="get"] input[name="lang"]')).toBeNull();
    });
  });

  describe("/audit applyFilters and clearFilters", () => {
    const auditData = {
      events: [],
      pagination: { page: 1, limit: 50, total: 0, pages: 0 },
      filters: { event_type: "auth.login.success" },
      user: { id: ADMIN_USER.id, email: ADMIN_USER.email },
      authServerUrl: "https://auth.example",
      names: {},
    };

    it("keeps ?lang=ar on applyFilters and clearFilters", () => {
      mockLoaderData = auditData;
      mockSearchParams = new URLSearchParams("lang=ar&event_type=auth.login.success");
      render(
        <MemoryRouter initialEntries={["/audit?lang=ar&event_type=auth.login.success"]}>
          <auditMod.default />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByText(pagesCopy("ar").audit.showFilters));
      fireEvent.click(screen.getByText(pagesCopy("ar").audit.apply));
      expect(mockNavigate).toHaveBeenLastCalledWith("/audit?lang=ar&event_type=auth.login.success&page=1");

      fireEvent.click(screen.getAllByText(pagesCopy("ar").audit.clear)[0]);
      expect(mockNavigate).toHaveBeenLastCalledWith("/audit?lang=ar");
    });

    it("omits lang on applyFilters and clearFilters in English", () => {
      mockLoaderData = auditData;
      mockSearchParams = new URLSearchParams("event_type=auth.login.success");
      render(
        <MemoryRouter initialEntries={["/audit?event_type=auth.login.success"]}>
          <auditMod.default />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByText(pagesCopy("en").audit.showFilters));
      fireEvent.click(screen.getByText(pagesCopy("en").audit.apply));
      expect(mockNavigate).toHaveBeenLastCalledWith("/audit?event_type=auth.login.success&page=1");

      fireEvent.click(screen.getAllByText(pagesCopy("en").audit.clear)[0]);
      expect(mockNavigate).toHaveBeenLastCalledWith("/audit");
    });
  });

  describe("/users onSearch and hrefFor", () => {
    const usersData = {
      users: [],
      allRoles: [],
      currentUser: ADMIN_USER,
      user: { id: ADMIN_USER.id, email: ADMIN_USER.email },
      authServerUrl: "https://auth.example",
      systemAccounts: null,
      systemView: false,
      query: "",
    };

    it("keeps ?lang=ar in onSearch (non-empty and empty) and hrefFor", () => {
      mockLoaderData = usersData;
      mockSearchParams = new URLSearchParams("lang=ar");
      render(
        <MemoryRouter initialEntries={["/users?lang=ar"]}>
          <usersMod.default />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByTestId("trigger-search"));
      expect(mockNavigate).toHaveBeenLastCalledWith("/users?q=ali%40example.com&lang=ar");

      fireEvent.click(screen.getByTestId("trigger-search-empty"));
      expect(mockNavigate).toHaveBeenLastCalledWith("/users?lang=ar");

      expect(screen.getByTestId("suggestion-link").getAttribute("href")).toBe("/users?q=ali%40example.com&lang=ar");
    });

    it("omits lang in onSearch and hrefFor in English", () => {
      mockLoaderData = usersData;
      mockSearchParams = new URLSearchParams();
      render(
        <MemoryRouter initialEntries={["/users"]}>
          <usersMod.default />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByTestId("trigger-search"));
      expect(mockNavigate).toHaveBeenLastCalledWith("/users?q=ali%40example.com");

      fireEvent.click(screen.getByTestId("trigger-search-empty"));
      expect(mockNavigate).toHaveBeenLastCalledWith("/users");

      expect(screen.getByTestId("suggestion-link").getAttribute("href")).toBe("/users?q=ali%40example.com");
    });
  });

  describe("DialogContent localized close label", () => {
    it("renders Arabic close label from ?lang=ar via router context even without an explicit lang prop", () => {
      const Stub = createRoutesStub([
        {
          path: "/roles",
          Component: () => (
            <Dialog open>
              <DialogContent>
                <DialogTitle>عنوان</DialogTitle>
                <DialogDescription>وصف</DialogDescription>
              </DialogContent>
            </Dialog>
          ),
        },
      ]);
      render(<Stub initialEntries={["/roles?lang=ar"]} />);
      expect(screen.getByText(adminCopy("ar").common.close)).toBeTruthy();
      expect(screen.queryByText("Close")).toBeNull();
    });

    it("renders English close label by default and respects explicit lang='ar'", () => {
      const { rerender } = render(
        <Dialog open>
          <DialogContent lang="en">
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Desc</DialogDescription>
          </DialogContent>
        </Dialog>,
      );
      expect(screen.getByText("Close")).toBeTruthy();

      rerender(
        <Dialog open>
          <DialogContent lang="ar">
            <DialogTitle>عنوان</DialogTitle>
            <DialogDescription>وصف</DialogDescription>
          </DialogContent>
        </Dialog>,
      );
      expect(screen.getByText(adminCopy("ar").common.close)).toBeTruthy();
    });
  });

  describe("action error localization (?lang=ar only, never Accept-Language or cookie)", () => {
    it("clients.action localizes invalid metadata JSON and unknown action", async () => {
      const createAr = await clientsMod.action(
        actionArgs("/clients?lang=ar", { intent: "create", name: "App", metadata: "{bad" }),
      );
      expect(createAr).toEqual({ error: pagesCopy("ar").clients.invalidMetadataJson });

      const updateAr = await clientsMod.action(
        actionArgs("/clients?lang=ar", { intent: "update", client_id: "c1", redirect_uris: "https://a.test/cb", metadata: "{bad" }),
      );
      expect(updateAr).toEqual({ error: pagesCopy("ar").clients.invalidMetadataJson });

      const unknownAr = await clientsMod.action(actionArgs("/clients?lang=ar", { intent: "bogus" }));
      expect(unknownAr).toEqual({ error: adminCopy("ar").common.unknownAction });

      // Accept-Language and cookies must never switch the language to Arabic
      const createEn = await clientsMod.action(
        actionArgs(
          "/clients",
          { intent: "create", name: "App", metadata: "{bad" },
          { "Accept-Language": "ar-SA,ar;q=0.9", Cookie: "lang=ar; locale=ar" },
        ),
      );
      expect(createEn).toEqual({ error: pagesCopy("en").clients.invalidMetadataJson });

      const unknownEn = await clientsMod.action(
        actionArgs("/clients", { intent: "bogus" }, { "Accept-Language": "ar" }),
      );
      expect(unknownEn).toEqual({ error: adminCopy("en").common.unknownAction });
    });

    it("sessions.action localizes unknown action from ?lang=ar only", async () => {
      const ar = await sessionsMod.action(actionArgs("/sessions?lang=ar", { _action: "bogus" }));
      expect(ar).toEqual({ success: false, error: adminCopy("ar").common.unknownAction });

      const en = await sessionsMod.action(
        actionArgs("/sessions", { _action: "bogus" }, { "Accept-Language": "ar", Cookie: "lang=ar" }),
      );
      expect(en).toEqual({ success: false, error: adminCopy("en").common.unknownAction });
    });

    it("login.loader respects ?lang=ar directly on /login?lang=ar&error=invalid_state", async () => {
      const request = new Request("https://admin.auth.example/login?lang=ar&error=invalid_state");
      const data = (await loginMod.loader({
        request,
        params: {},
        context: cloudflareLoadContext({ APP_URL: "https://admin.auth.example" }, undefined),
      } as never)) as { error: string; lang: string };
      expect(data.lang).toBe("ar");
      expect(data.error).toBe(adminCopy("ar").signIn.expired);
    });
  });
});
