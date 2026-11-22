/** Browser side of the hydration check: hydrates the page the server rendered and records every hydration error. */
import { hydrateRoot } from "react-dom/client";
import { PageApp, type PageName } from "./app";

declare global {
  interface Window {
    __page: { page: PageName; url: string; authServerUrl?: string };
    __hydrationErrors: string[];
    __hydrated: boolean;
  }
}

window.__hydrationErrors = [];
const { page, url, authServerUrl } = window.__page;
hydrateRoot(document.getElementById("root")!, <PageApp page={page} url={url} authServerUrl={authServerUrl} />, {
  onRecoverableError: (error) => {
    window.__hydrationErrors.push(String((error as Error)?.message ?? error));
  },
});
// Hydration runs before the next task: give React a moment, then mark the page done
setTimeout(() => {
  window.__hydrated = true;
}, 500);
