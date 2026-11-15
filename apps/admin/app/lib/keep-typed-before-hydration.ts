/**
 * Text typed before hydration survives it (#1462).
 *
 * A server-rendered page shows its form fields before React has hydrated them, and a person on a
 * slow connection can type into them in that moment. React hydrates without reading that text: a
 * textarea is reset to its server value at once, and an input keeps the text on screen while the
 * component's state holds the server value, so the next render writes it back over the text (an
 * emptied Subject field in the admin's newsletter editor, #1459).
 *
 * Two parts:
 * - TYPED_RECORDER_SCRIPT, inline in <head>, notes the last text typed into each field React has
 *   not hydrated yet (a property on the element, nothing in the DOM).
 * - keepTypedBeforeHydration(), after hydration, gives each noted field its text back through
 *   React's own change handling, so onChange runs and state matches what the person typed. Fields
 *   still waiting for hydration are left for a later pass. Nothing else is touched.
 *
 * The same code runs in the videos site and admin (AlUmmahNow apps/web, apps/admin-web
 * src/lib/forms/keep-typed-before-hydration.ts); keep them alike.
 */

/** Where the recorder keeps a field's pre-hydration text */
export const TYPED_PROP = '__aunTypedBeforeHydration';

/** Inline in <head>, before any field is shown. Records only fields React has not hydrated yet. */
export const TYPED_RECORDER_SCRIPT = `document.addEventListener('input',function(e){var t=e.target;if(!t||(t.tagName!=='INPUT'&&t.tagName!=='TEXTAREA'))return;for(var k in t){if(k.indexOf('__reactProps$')===0)return}t.${TYPED_PROP}=t.value},true);`;

type Field = (HTMLInputElement | HTMLTextAreaElement) & {
  [TYPED_PROP]?: string;
  /** React's per-node value tracker: decides whether an input event is a change */
  _valueTracker?: { setValue(value: string): void };
};

/** React's current props for a hydrated element (undefined until it is hydrated) */
function reactProps(el: Element): Record<string, unknown> | undefined {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : undefined;
}

/** Gives fields typed into before hydration their text back. Returns how many it restored. */
export function keepTypedBeforeHydration(root: Pick<ParentNode, "querySelectorAll"> = document): number {
  let restored = 0;
  for (const el of Array.from(root.querySelectorAll<Field>('input, textarea'))) {
    const typed = el[TYPED_PROP];
    if (typed === undefined) continue;
    const props = reactProps(el);
    if (!props) continue; // not hydrated yet: a later pass
    delete el[TYPED_PROP];
    const controlled = props.value != null;
    // React already has it: nothing to do (and no onChange)
    const known = controlled ? String(props.value) : el.value;
    if (known === typed) continue;
    // Put the text back (React's value setter tracks it), then make React see it as a change
    el.value = typed;
    el._valueTracker?.setValue(known);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    restored++;
  }
  return restored;
}

/** Runs the pass after hydration, and again for parts that hydrate later (Suspense, slow chunks). */
export function scheduleKeepTypedBeforeHydration(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const run = () => keepTypedBeforeHydration();
  run();
  const timers = [500, 2000, 5000].map((ms) => window.setTimeout(run, ms));
  window.addEventListener('load', run, { once: true });
  return () => {
    timers.forEach((t) => window.clearTimeout(t));
    window.removeEventListener('load', run);
  };
}
