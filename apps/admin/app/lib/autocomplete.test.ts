/**
 * The user autocomplete: the ARIA 1.2 combobox keys (same as the videos admin's), the options each
 * mode offers, stale answers, the rendered markup, and the suggestion shape the route returns.
 */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserAutocomplete, type UserAutocompleteProps } from "../components/autocomplete";
import { failed, initialState, keyDown, looksLikeId, MIN_QUERY, optionsFor, received, typed, type AutocompleteState, type Suggestion } from "./autocomplete-model";
import { toSuggestion } from "./suggest-users.server";

const u = (id: string, label: string, email: string): Suggestion => ({ id, label, secondary: email, imageUrl: null });
const USERS = [u("4f1c2e8a-0000-4000-8000-000000000001", "Omar", "omar@example.com"), u("4f1c2e8a-0000-4000-8000-000000000002", "Omar F", "of@example.com")];
const ready = (mode: "search" | "pick", q: string, items = USERS): AutocompleteState => received(typed(initialState(), q), mode, q, items);
const press = (s: AutocompleteState, mode: "search" | "pick", ...keys: string[]) =>
  keys.reduce((r, k) => keyDown(r.state, mode, k), { state: s, effect: { type: "none" }, preventDefault: false } as ReturnType<typeof keyDown>);

describe("autocomplete model", () => {
  it("asks from two characters; drops stale answers", () => {
    expect(MIN_QUERY).toBe(2);
    const waiting = typed(initialState(), "omar");
    expect(waiting).toMatchObject({ open: true, status: "loading" });
    expect(received(waiting, "pick", "om", USERS)).toBe(waiting);
    expect(failed(waiting, "pick", "om")).toBe(waiting);
  });

  it("search mode ends with 'search everything'; pick mode offers a pasted id", () => {
    expect(optionsFor("search", "omar", USERS).map((o) => o.type)).toEqual(["suggestion", "suggestion", "searchAll"]);
    expect(optionsFor("pick", "9b2d1c3e-1111-4222-8333-444455556666", [])).toEqual([{ type: "useId", id: "9b2d1c3e-1111-4222-8333-444455556666" }]);
    expect(optionsFor("pick", "omar", [])).toEqual([]);
    expect(looksLikeId("omar")).toBe(false);
    expect(looksLikeId("10.0.0.1")).toBe(false);
  });

  it("keys: arrows wrap, Enter chooses, Escape closes then clears", () => {
    expect(press(ready("search", "omar"), "search", "ArrowDown").state.active).toBe(0);
    expect(press(ready("search", "omar"), "search", "ArrowUp").state.active).toBe(2);
    expect(press(ready("search", "omar"), "search", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown").state.active).toBe(0);
    expect(press(ready("search", "omar"), "search", "ArrowDown", "Enter").effect).toEqual({ type: "choose", option: { type: "suggestion", suggestion: USERS[0] } });
    expect(press(ready("search", "omar"), "search", "Enter")).toMatchObject({ effect: { type: "default" }, preventDefault: false });
    expect(press(ready("pick", "omar"), "pick", "Enter").effect).toEqual({ type: "choose", option: { type: "suggestion", suggestion: USERS[0] } });
    expect(press(ready("pick", "nobody", []), "pick", "Enter")).toMatchObject({ effect: { type: "none" }, preventDefault: true });
    const once = keyDown(ready("search", "omar"), "search", "Escape");
    expect(once.state.open).toBe(false);
    expect(keyDown(once.state, "search", "Escape").effect).toEqual({ type: "clear" });
  });
});

describe("autocomplete markup", () => {
  const render = (props: UserAutocompleteProps) => renderToStaticMarkup(React.createElement(UserAutocomplete, props));

  it("search mode is a labelled combobox carrying the query parameter", () => {
    const html = render({ mode: "search", name: "q", label: "Search users", defaultValue: "omar" });
    expect(html).toMatch(/role="combobox"/);
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/aria-autocomplete="list"/);
    expect(html).toMatch(/name="q"/);
    expect(html).toMatch(/value="omar"/);
    expect(html).toMatch(/role="listbox"[^>]*hidden=""/);
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });

  it("pick mode keeps the id in a hidden input; a chosen id shows as a chip", () => {
    const empty = render({ mode: "pick", name: "user_id", label: "User" });
    expect(empty).toMatch(/<input type="hidden" name="user_id" value=""\/>/);
    expect(empty.match(/name="/g)).toHaveLength(1);
    const chosen = render({ mode: "pick", name: "user_id", label: "User", defaultValue: USERS[0].id, testId: "s" });
    expect(chosen).toContain(`<input type="hidden" name="user_id" value="${USERS[0].id}"/>`);
    expect(chosen).toContain('data-testid="s-chip"');
    expect(chosen).toContain("Looking up…");
    expect(chosen).not.toMatch(/role="combobox"/);
  });
});

describe("suggestion shape", () => {
  it("shows the name with the email under it, or the email alone", () => {
    expect(toSuggestion({ id: "a", email: "a@x.com", name: " Aisha " })).toEqual({ id: "a", label: "Aisha", secondary: "a@x.com", imageUrl: null });
    expect(toSuggestion({ id: "b", email: "b@x.com" })).toEqual({ id: "b", label: "b@x.com", secondary: null, imageUrl: null });
  });
});
