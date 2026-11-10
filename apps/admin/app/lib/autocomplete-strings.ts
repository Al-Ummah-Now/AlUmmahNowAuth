/** This admin's interface strings (it is English-only; the videos admin has the Arabic). */
export const AUTOCOMPLETE_STRINGS = {
  searchPlaceholder: "Type a name or email",
  pickPlaceholder: "Name, email or user ID",
  searching: "Searching…",
  noMatches: "No matches. Press Enter to search anyway.",
  failed: "Suggestions are unavailable right now. Press Enter to search.",
  count: (n: number) => `${n} suggestion${n === 1 ? "" : "s"}. Use the up and down arrows to choose, Enter to open.`,
  searchAll: "Search everything for",
  useId: "Use this user ID:",
  lookingUp: "Looking up…",
  notFound: "No user has this ID",
  change: "Change",
  changeLabel: (name: string) => `Change the user (${name})`,
  clearLabel: (name: string) => `Remove the chosen user (${name})`,
};
