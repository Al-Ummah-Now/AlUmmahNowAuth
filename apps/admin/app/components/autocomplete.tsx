/**
 * The user autocomplete for every user search and lookup box in this admin. Same behaviour and
 * keys as the videos admin's autocomplete (AlUmmahNow admin-web components/search/Autocomplete.tsx):
 *
 * - search mode (the Users list search): suggestions appear as the admin types; Enter still runs
 *   the full search, choosing a suggestion goes to that user.
 * - pick mode (a user filter: Sessions, Audit): the admin types a name or email (or pastes an id)
 *   and chooses; the id travels in a hidden input named `name` (GET forms keep it in the URL) and
 *   is passed to onChange. A chosen user shows as a chip with name, email and id.
 *
 * WAI-ARIA 1.2 combobox with a listbox popup (autocomplete-model.ts has the keys). The result count
 * is announced in a polite live region. Layout uses logical properties; ids are shown left-to-right.
 *
 * Initial results (pick mode by default; owner rule 2026-11-11): the box opens with the newest
 * users before anything is typed, pages on as the list is scrolled (or arrowed) to its end, and
 * shows a skeleton while loading, a note when there is nothing and a retry when it fails. The
 * current value is marked when the admin changes it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Input } from "./ui/input";
import {
  DEBOUNCE_MS,
  MIN_QUERY,
  addPage,
  closed,
  failed,
  initialState,
  initialUrl,
  keyDown,
  received,
  resolveUrl,
  showInitial,
  suggestUrl,
  typed,
  type AutocompleteMode,
  type AutocompleteOption,
  type AutocompleteState,
  type InitialList,
  type Suggestion,
} from "../lib/autocomplete-model";

import { AUTOCOMPLETE_STRINGS } from "../lib/autocomplete-strings";

const S = AUTOCOMPLETE_STRINGS;

export interface UserAutocompleteProps {
  mode: AutocompleteMode;
  label: string;
  /** search: the query parameter. pick: the hidden input carrying the id. */
  name?: string;
  /** search: the text. pick: the id. */
  defaultValue?: string;
  /** search: where choosing a suggestion goes */
  hrefFor?: (s: Suggestion) => string;
  /** pick: called with the chosen id ('' when cleared) */
  onChange?: (id: string, item: Suggestion | null) => void;
  /** pick: submit the surrounding form when a value is chosen or cleared */
  submitOnChange?: boolean;
  /** search: run instead of submitting a form when Enter (or "Search everything") asks for the full search */
  onSearch?: (query: string) => void;
  /** search: every change of the text (a list that also filters what it already shows) */
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  className?: string;
  testId?: string;
  /** Open with the newest users before anything is typed (default: pick mode yes, search mode no: the list below shows them) */
  initialResults?: boolean;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" }, credentials: "same-origin" });
  if (!res.ok) throw new Error(`Suggestions answered ${res.status}`);
  return (await res.json()) as T;
}

export function UserAutocomplete({ mode, label, name, defaultValue = "", hrefFor, onChange, submitOnChange = false, onSearch, onQueryChange, placeholder, className = "", testId, initialResults }: UserAutocompleteProps) {
  const initialOn = initialResults ?? mode === "pick";
  const ids = useId();
  const inputId = `${ids}-input`;
  const listId = `${ids}-list`;
  const optionId = (i: number) => `${ids}-opt-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AutocompleteState>(() => initialState(mode === "search" ? defaultValue : ""));
  const [picked, setPicked] = useState<{ id: string; item: Suggestion | null; missing: boolean } | null>(() =>
    mode === "pick" && defaultValue ? { id: defaultValue, item: null, missing: false } : null,
  );
  const [editing, setEditing] = useState(false);
  // Initial results: loaded on first open, kept for the life of the box
  const [initial, setInitial] = useState<InitialList | null>(null);
  const initialRef = useRef<InitialList | null>(null);
  const initialAbort = useRef<AbortController | null>(null);

  const loadInitial = useCallback((cursor: string | null) => {
    initialAbort.current?.abort();
    const controller = new AbortController();
    initialAbort.current = controller;
    const loading: InitialList = cursor && initialRef.current ? { ...initialRef.current, status: "more" } : { items: [], next: null, status: "loading" };
    initialRef.current = loading;
    setInitial(loading);
    if (!cursor) setState((s) => showInitial(s, loading));
    getJson<{ items: Suggestion[]; next?: string | null }>(initialUrl(cursor), controller.signal)
      .then(({ items, next }) => {
        const list = addPage(initialRef.current, { items, next: next ?? null }, !!cursor);
        initialRef.current = list;
        setInitial(list);
        setState((s) => showInitial(s, list));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        const list: InitialList = { ...(initialRef.current ?? { items: [], next: null }), status: "error" };
        initialRef.current = list;
        setInitial(list);
        setState((s) => showInitial(s, list));
      });
  }, []);
  useEffect(() => () => initialAbort.current?.abort(), []);

  const openInitial = useCallback(() => {
    if (!initialOn) return;
    setState((s) => (s.query.trim().length >= MIN_QUERY ? { ...s, open: s.options.length > 0 } : showInitial({ ...s, open: true }, initialRef.current)));
    if (!initialRef.current || (initialRef.current.status === "error" && initialRef.current.items.length === 0)) loadInitial(null);
  }, [initialOn, loadInitial]);

  const loadMore = useCallback(() => {
    const list = initialRef.current;
    if (list && list.status === "ready" && list.next && state.query.trim().length === 0) loadInitial(list.next);
  }, [loadInitial, state.query]);

  // The chip's name for an id that came from the URL
  useEffect(() => {
    if (!picked || picked.item || picked.missing) return;
    const controller = new AbortController();
    getJson<{ item: Suggestion | null }>(resolveUrl(picked.id), controller.signal)
      .then(({ item }) => setPicked((p) => (p && p.id === picked.id ? { ...p, item, missing: !item } : p)))
      .catch(() => {
        if (!controller.signal.aborted) setPicked((p) => (p && p.id === picked.id ? { ...p, missing: true } : p));
      });
    return () => controller.abort();
  }, [picked]);

  // Suggestions after the admin stops typing; a newer query aborts the older request
  const query = state.query;
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getJson<{ items: Suggestion[] }>(suggestUrl(q), controller.signal)
        .then(({ items }) => setState((s) => received(s, mode, q, items)))
        .catch(() => {
          if (!controller.signal.aborted) setState((s) => failed(s, mode, q));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, query]);

  // Arrowing onto the last option of the initial list asks for the next page
  useEffect(() => {
    if (initialOn && state.active >= 0 && state.active >= state.options.length - 1) loadMore();
  }, [initialOn, state.active, state.options.length, loadMore]);

  useEffect(() => {
    if (state.active >= 0) document.getElementById(optionId(state.active))?.scrollIntoView?.({ block: "nearest" });
    // optionId derives from a stable useId value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);

  const fullSearch = useCallback(
    (q: string) => {
      if (onSearch) onSearch(q);
      else inputRef.current?.form?.requestSubmit();
    },
    [onSearch],
  );

  const setValue = useCallback(
    (id: string, item: Suggestion | null) => {
      flushSync(() => {
        setPicked(id ? { id, item, missing: false } : null);
        setEditing(false);
        setState(initialState());
      });
      if (initialRef.current) setState((s) => showInitial(s, initialRef.current));
      onChange?.(id, item);
      if (submitOnChange) hiddenRef.current?.form?.requestSubmit();
    },
    [onChange, submitOnChange],
  );

  const choose = useCallback(
    (option: AutocompleteOption) => {
      if (option.type === "searchAll") {
        flushSync(() => setState((s) => closed({ ...s, query: option.query })));
        fullSearch(option.query);
        return;
      }
      if (mode === "search") {
        setState(closed);
        if (option.type === "suggestion" && hrefFor) window.location.assign(hrefFor(option.suggestion));
        return;
      }
      if (option.type === "suggestion") setValue(option.suggestion.id, option.suggestion);
      else setValue(option.id, null);
    },
    [fullSearch, hrefFor, mode, setValue],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape" && mode === "pick" && picked && !state.open && !state.query) {
      e.preventDefault();
      setEditing(false);
      return;
    }
    const result = keyDown(state, mode, e.key, e.altKey);
    if (result.preventDefault) e.preventDefault();
    setState(result.state);
    if (result.effect.type === "choose") choose(result.effect.option);
    else if (result.effect.type === "default" && mode === "search" && onSearch) {
      e.preventDefault();
      onSearch(state.query.trim());
    }
  };

  const showChip = mode === "pick" && picked && !editing;
  const expanded = state.open && !showChip && (state.options.length > 0 || state.status !== "idle");
  const suggestionCount = state.options.filter((o) => o.type === "suggestion").length;
  // The box shows the initial list (nothing, or one character, typed)
  const showingInitial = initialOn && state.query.trim().length < MIN_QUERY;
  const emptyInitial = showingInitial && !state.query.trim() && state.status === "ready" && suggestionCount === 0;
  const announcement = !expanded
    ? ""
    : state.status === "loading" && state.options.length === 0
      ? showingInitial
        ? S.loadingList
        : S.searching
      : state.status === "error"
        ? showingInitial
          ? S.listFailed
          : S.failed
        : emptyInitial
          ? S.emptyList
          : suggestionCount === 0
            ? S.noMatches
            : showingInitial && !state.query.trim()
              ? S.recent(suggestionCount)
              : S.count(suggestionCount);

  return (
    <div className={`flex flex-col gap-1 ${className}`} data-testid={testId} data-mode={mode}>
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      {mode === "pick" && name !== undefined && <input ref={hiddenRef} type="hidden" name={name} value={picked?.id ?? ""} />}
      {showChip ? (
        <Chip
          picked={picked}
          inputId={inputId}
          testId={testId}
          onChange={() => {
            flushSync(() => setEditing(true));
            inputRef.current?.focus();
          }}
          onClear={() => setValue("", null)}
        />
      ) : (
        <div className="relative">
          <Input
            ref={inputRef}
            id={inputId}
            type={mode === "search" ? "search" : "text"}
            name={mode === "search" ? name : undefined}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={expanded && state.active >= 0 ? optionId(state.active) : undefined}
            autoComplete="off"
            spellCheck={false}
            dir="auto"
            maxLength={100}
            value={state.query}
            placeholder={placeholder ?? (mode === "search" ? S.searchPlaceholder : S.pickPlaceholder)}
            onChange={(e) => {
              setState((s) => (initialOn ? typed(s, e.target.value, initialRef.current) : typed(s, e.target.value)));
              onQueryChange?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setState(closed);
              if (mode === "pick" && picked && !state.query.trim()) setEditing(false);
            }}
            onFocus={() => (initialOn ? openInitial() : setState((s) => (s.options.length > 0 && s.query.trim().length >= MIN_QUERY ? { ...s, open: true } : s)))}
            onClick={() => {
              if (initialOn && !state.open) openInitial();
            }}
            data-testid={testId ? `${testId}-input` : undefined}
          />
          <div
            hidden={!expanded}
            className="absolute start-0 top-full z-50 mt-1 w-full min-w-72 overflow-hidden rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-popover))] text-[rgb(var(--color-popover-foreground))] shadow-lg"
            data-testid={testId ? `${testId}-popup` : undefined}
            // A press on the list (its scrollbar too) must not blur the input and close it
            onMouseDown={(e) => e.preventDefault()}
          >
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            aria-busy={(showingInitial && (state.status === "loading" || initial?.status === "more")) || undefined}
            hidden={!expanded}
            className="max-h-80 overflow-auto py-1"
            data-testid={testId ? `${testId}-list` : undefined}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (showingInitial && el.scrollTop + el.clientHeight >= el.scrollHeight - 48) loadMore();
            }}
          >
            {state.options.map((option, i) => (
              <li
                key={option.type === "suggestion" ? option.suggestion.id : option.type}
                id={optionId(i)}
                role="option"
                aria-selected={i === state.active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setState(closed);
                  choose(option);
                }}
                onMouseMove={() => i !== state.active && setState((s) => ({ ...s, active: i }))}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${i === state.active ? "bg-[rgb(var(--color-muted))] outline outline-2 -outline-offset-2 outline-[rgb(var(--color-ring))]" : ""}`}
                data-option={option.type}
                data-id={option.type === "suggestion" ? option.suggestion.id : undefined}
              >
                <OptionContent option={option} current={picked?.id} />
              </li>
            ))}
            {state.status === "loading" && state.options.length === 0 &&
              (showingInitial ? (
                [0, 1, 2, 3].map((i) => (
                  <li key={`sk-${i}`} role="presentation" aria-hidden="true" className="flex items-center gap-3 px-3 py-2" data-testid={testId ? `${testId}-skeleton` : undefined}>
                    <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-[rgb(var(--color-muted))] motion-reduce:animate-none" />
                    <span className="flex flex-1 flex-col gap-1.5">
                      <span className="h-3 w-3/4 animate-pulse rounded bg-[rgb(var(--color-muted))] motion-reduce:animate-none" />
                      <span className="h-2.5 w-1/3 animate-pulse rounded bg-[rgb(var(--color-muted))] motion-reduce:animate-none" />
                    </span>
                  </li>
                ))
              ) : (
                <li role="presentation" className="px-3 py-2 text-sm text-[rgb(var(--color-muted-foreground))]">
                  {S.searching}
                </li>
              ))}
          </ul>
          {emptyInitial && (
            <p className="px-3 py-2 text-sm text-[rgb(var(--color-muted-foreground))]" data-testid={testId ? `${testId}-empty` : undefined}>
              {S.emptyList}
            </p>
          )}
          {showingInitial && initial?.status === "more" && (
            <p className="px-3 py-2 text-xs text-[rgb(var(--color-muted-foreground))]" data-testid={testId ? `${testId}-loading-more` : undefined}>
              {S.loadingMore}
            </p>
          )}
          {showingInitial && initial?.status === "error" && (
            <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--color-border))] px-3 py-2 text-sm text-[rgb(var(--color-muted-foreground))]" data-testid={testId ? `${testId}-error` : undefined}>
              <span>{S.listFailed}</span>
              <button
                type="button"
                onClick={() => {
                  loadInitial(initial.items.length ? initial.next : null);
                  inputRef.current?.focus();
                }}
                className="rounded border border-[rgb(var(--color-border))] px-2 py-1 text-xs hover:bg-[rgb(var(--color-muted))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-ring))]"
                data-testid={testId ? `${testId}-retry` : undefined}
              >
                {S.retry}
              </button>
            </div>
          )}
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function Initial({ label }: { label: string }) {
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--color-muted))] text-sm font-medium text-[rgb(var(--color-muted-foreground))]">
      {Array.from(label.trim())[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function OptionContent({ option, current }: { option: AutocompleteOption; current?: string }) {
  if (option.type === "searchAll") {
    return (
      <span>
        {S.searchAll} <bdi className="font-medium">“{option.query}”</bdi>
      </span>
    );
  }
  if (option.type === "useId") {
    return (
      <span>
        {S.useId}{" "}
        <bdi dir="ltr" className="font-mono text-xs">
          {option.id}
        </bdi>
      </span>
    );
  }
  const s = option.suggestion;
  return (
    <>
      <Initial label={s.label} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" dir="auto">
            {s.label}
          </span>
          {current === s.id && (
            <span className="shrink-0 rounded-full border border-[rgb(var(--color-border))] px-2 text-xs text-[rgb(var(--color-muted-foreground))]" data-testid="autocomplete-current">
              {S.current}
            </span>
          )}
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-[rgb(var(--color-muted-foreground))]">
          {s.secondary && (
            <span className="truncate" dir="auto">
              {s.secondary}
            </span>
          )}
          <bdi dir="ltr" className="shrink-0 font-mono">
            {s.id}
          </bdi>
        </span>
      </span>
    </>
  );
}

function Chip({
  picked,
  inputId,
  testId,
  onChange,
  onClear,
}: {
  picked: { id: string; item: Suggestion | null; missing: boolean };
  inputId: string;
  testId?: string;
  onChange: () => void;
  onClear: () => void;
}) {
  const { id, item, missing } = picked;
  const name = item?.label ?? (missing ? S.notFound : S.lookingUp);
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-md border border-[rgb(var(--color-input))] py-1 ps-1 pe-1" data-testid={testId ? `${testId}-chip` : undefined} data-id={id}>
      {item ? <Initial label={item.label} /> : <span aria-hidden="true" className="h-8 w-1" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm" dir="auto">
          {name}
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-[rgb(var(--color-muted-foreground))]">
          {item?.secondary && (
            <span className="truncate" dir="auto">
              {item.secondary}
            </span>
          )}
          <bdi dir="ltr" className="shrink-0 font-mono">
            {id}
          </bdi>
        </span>
      </span>
      <button
        type="button"
        id={inputId}
        onClick={onChange}
        className="rounded px-2 py-1 text-sm text-[rgb(var(--color-primary))] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-ring))]"
        aria-label={S.changeLabel(name)}
        data-testid={testId ? `${testId}-change` : undefined}
      >
        {S.change}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded px-2 py-1 text-sm text-[rgb(var(--color-muted-foreground))] hover:text-[rgb(var(--color-foreground))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--color-ring))]"
        aria-label={S.clearLabel(name)}
        data-testid={testId ? `${testId}-clear` : undefined}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
