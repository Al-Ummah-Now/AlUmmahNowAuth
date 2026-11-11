/**
 * The admin autocomplete's behaviour, kept apart from React so every key and
 * every choice can be tested without a browser (autocomplete-model.test.ts).
 * A port of the videos admin's model (AlUmmahNow
 * apps/admin-web/src/components/search/autocomplete-model.ts): same keys, same
 * options, so every admin behaves the same.
 *
 * The keyboard follows the WAI-ARIA 1.2 combobox pattern with a listbox popup
 * and list autocomplete with manual selection: focus stays in the input, the
 * active option is pointed at with aria-activedescendant, and nothing is chosen
 * until Enter or a click.
 */
/** One suggestion: a user here (the only kind this admin looks up). */
export interface Suggestion {
  id: string;
  /** Name: what the admin recognises */
  label: string;
  /** Email: what tells two similar names apart */
  secondary: string | null;
  imageUrl: string | null;
}

/**
 * search: a free-text search box. Enter runs the full-text filter; choosing a
 *   suggestion opens that item.
 * pick: a field whose value is an id (a filter or an action's target). The admin
 *   types a name and chooses; the id goes in a hidden field.
 */
export type AutocompleteMode = 'search' | 'pick';

export type AutocompleteOption =
  | { type: 'suggestion'; suggestion: Suggestion }
  /** pick mode: the typed text looks like an id and no suggestion has it exactly */
  | { type: 'useId'; id: string }
  /** search mode: run the full-text filter for the typed text (what Enter does) */
  | { type: 'searchAll'; query: string };

export type AutocompleteStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Initial results (pick mode; owner rule 2026-11-11: pickers open with
 * content): the newest users, shown when the box opens before anything is
 * typed, paged on scroll. One typed character filters what is loaded; from
 * MIN_QUERY the server is asked as before. Same as the videos admin.
 */
export interface InitialList {
  items: Suggestion[];
  /** Cursor of the next page; null after the last */
  next: string | null;
  status: 'loading' | 'more' | 'ready' | 'error';
}

export interface AutocompleteState {
  query: string;
  open: boolean;
  /** Index into options; -1 when no option is active */
  active: number;
  options: AutocompleteOption[];
  status: AutocompleteStatus;
}

/** Characters before suggestions are asked for: one letter matches too much to be useful. */
export const MIN_QUERY = 2;
/** Wait after the last keystroke before asking, so typing a word sends one request. */
export const DEBOUNCE_MS = 200;

export const initialState = (query = ''): AutocompleteState => ({ query, open: false, active: -1, options: [], status: 'idle' });

/**
 * Ids in this platform are opaque tokens (usr_…, ch_…, UUIDs, nanoids): one
 * word of letters, digits, `_` and `-`, at least 6 long, with a digit or a
 * separator so ordinary words are not taken for ids.
 */
export function looksLikeId(text: string): boolean {
  const value = text.trim();
  return /^[A-Za-z0-9_-]{6,200}$/.test(value) && /[0-9_-]/.test(value);
}

/** The options shown for a query: the suggestions, then the fallback for the mode. */
export function optionsFor(mode: AutocompleteMode, query: string, suggestions: Suggestion[]): AutocompleteOption[] {
  const options: AutocompleteOption[] = suggestions.map((suggestion) => ({ type: 'suggestion', suggestion }));
  const q = query.trim();
  if (!q) return options;
  if (mode === 'search') options.push({ type: 'searchAll', query: q });
  else if (looksLikeId(q) && !suggestions.some((s) => s.id === q)) options.push({ type: 'useId', id: q });
  return options;
}

export const suggestUrl = (query: string): string => `/api/suggest/users?q=${encodeURIComponent(query.trim())}`;
/** A picker's page before anything is typed (null cursor: the first). */
export const initialUrl = (cursor: string | null): string => `/api/suggest/users?q=${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
export const resolveUrl = (id: string): string => `/api/suggest/users/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

/** The admin typed: the list opens and waits for suggestions (or closes when too short; with initial results it shows them). */
export function typed(state: AutocompleteState, query: string, initial?: InitialList | null): AutocompleteState {
  const asks = query.trim().length >= MIN_QUERY;
  if (!asks && initial !== undefined) return showInitial({ ...state, query, open: true, active: -1 }, initial);
  return {
    query,
    open: asks,
    active: -1,
    // Suggestions for a shorter query stay while the next answer comes; the initial list does not (it isn't a match)
    options: asks && state.query.trim().length >= MIN_QUERY ? state.options : [],
    status: asks ? 'loading' : 'idle',
  };
}

/** Suggestions arrived. Answers for an older query are dropped. */
export function received(state: AutocompleteState, mode: AutocompleteMode, query: string, suggestions: Suggestion[]): AutocompleteState {
  if (query.trim() !== state.query.trim()) return state;
  return { ...state, options: optionsFor(mode, query, suggestions), status: 'ready', active: -1 };
}

/** The request failed: the fallback option still works (Enter searches, a pasted id can be used). */
export function failed(state: AutocompleteState, mode: AutocompleteMode, query: string): AutocompleteState {
  if (query.trim() !== state.query.trim()) return state;
  return { ...state, options: optionsFor(mode, query, []), status: 'error', active: -1 };
}

export const closed = (state: AutocompleteState): AutocompleteState => ({ ...state, open: false, active: -1 });

const fold = (text: string | null | undefined) => (text ?? '').toLocaleLowerCase();

/** The initial list as the options while fewer than MIN_QUERY characters are typed (all of it, or the items containing the character). */
export function showInitial(state: AutocompleteState, initial: InitialList | null): AutocompleteState {
  const q = fold(state.query.trim());
  if (q.length >= MIN_QUERY) return state;
  const items = initial?.items ?? [];
  const shown = q ? items.filter((s) => fold(s.label).includes(q) || fold(s.secondary).includes(q) || fold(s.id).includes(q)) : items;
  const status: AutocompleteStatus = !initial || initial.status === 'loading' ? 'loading' : initial.status === 'error' && items.length === 0 ? 'error' : 'ready';
  const options: AutocompleteOption[] = shown.map((suggestion) => ({ type: 'suggestion', suggestion }));
  return { ...state, options, status, active: state.active < options.length ? state.active : -1 };
}

/** A page of the initial list arrived (the first replaces, later ones append; duplicates dropped). */
export function addPage(initial: InitialList | null, page: { items: Suggestion[]; next: string | null }, append: boolean): InitialList {
  const base = append && initial ? initial.items : [];
  const seen = new Set(base.map((s) => s.id));
  return { items: [...base, ...page.items.filter((s) => !seen.has(s.id))], next: page.next, status: 'ready' };
}

export type KeyEffect =
  | { type: 'none' }
  | { type: 'choose'; option: AutocompleteOption }
  /** Let the key do what it does in a form (Enter submits) */
  | { type: 'default' }
  | { type: 'clear' };

export interface KeyResult {
  state: AutocompleteState;
  effect: KeyEffect;
  /** Whether the browser's own handling of the key must be stopped */
  preventDefault: boolean;
}

const NONE: KeyEffect = { type: 'none' };

/** One key press in the input. */
export function keyDown(state: AutocompleteState, mode: AutocompleteMode, key: string, alt = false): KeyResult {
  const last = state.options.length - 1;
  switch (key) {
    case 'ArrowDown': {
      if (alt) return { state: { ...state, open: state.options.length > 0 || state.status === 'loading' }, effect: NONE, preventDefault: true };
      if (state.options.length === 0) return { state, effect: NONE, preventDefault: true };
      if (!state.open) return { state: { ...state, open: true, active: 0 }, effect: NONE, preventDefault: true };
      return { state: { ...state, active: state.active >= last ? 0 : state.active + 1 }, effect: NONE, preventDefault: true };
    }
    case 'ArrowUp': {
      if (alt) return { state: closed(state), effect: NONE, preventDefault: true };
      if (state.options.length === 0) return { state, effect: NONE, preventDefault: true };
      if (!state.open) return { state: { ...state, open: true, active: last }, effect: NONE, preventDefault: true };
      return { state: { ...state, active: state.active <= 0 ? last : state.active - 1 }, effect: NONE, preventDefault: true };
    }
    case 'Enter': {
      if (state.open && state.active >= 0 && state.options[state.active]) {
        return { state: closed(state), effect: { type: 'choose', option: state.options[state.active] }, preventDefault: true };
      }
      if (mode === 'search') return { state: closed(state), effect: { type: 'default' }, preventDefault: false };
      // pick: an empty box applies the rest of the form; typed text takes the top match (or the pasted id)
      if (!state.query.trim()) return { state: closed(state), effect: { type: 'default' }, preventDefault: false };
      const first = state.options[0];
      if (first && first.type !== 'searchAll') return { state: closed(state), effect: { type: 'choose', option: first }, preventDefault: true };
      if (looksLikeId(state.query)) return { state: closed(state), effect: { type: 'choose', option: { type: 'useId', id: state.query.trim() } }, preventDefault: true };
      return { state, effect: NONE, preventDefault: true };
    }
    case 'Escape': {
      if (state.open) return { state: closed(state), effect: NONE, preventDefault: true };
      if (state.query) return { state: initialState(), effect: { type: 'clear' }, preventDefault: true };
      return { state, effect: NONE, preventDefault: false };
    }
    case 'Tab':
      return { state: closed(state), effect: NONE, preventDefault: false };
    default:
      return { state, effect: NONE, preventDefault: false };
  }
}
