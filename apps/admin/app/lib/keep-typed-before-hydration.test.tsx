// @vitest-environment happy-dom
/**
 * #1462: text typed into a server-rendered field before hydration is kept. Also a guard on React
 * upgrades: the first test pins React's behaviour this works around, the second the fix itself
 * (it uses React's per-node value tracker).
 */
import React, { act, useState } from 'react';
import { beforeEach, expect, it } from 'vitest';

// React's act() outside a test renderer
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { keepTypedBeforeHydration, TYPED_RECORDER_SCRIPT } from './keep-typed-before-hydration';

// The <head> recorder, as the page runs it before hydration
// eslint-disable-next-line no-new-func
new Function(TYPED_RECORDER_SCRIPT)();

const state: Record<string, string> = {};
const changes: string[] = [];

function Form() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('server text');
  const [other, setOther] = useState('');
  state.subject = subject;
  state.body = body;
  state.other = other;
  return (
    <form>
      <input aria-label="subject" value={subject} onChange={(e) => { changes.push('subject'); setSubject(e.target.value); }} />
      <textarea aria-label="body" value={body} onChange={(e) => { changes.push('body'); setBody(e.target.value); }} />
      <input aria-label="other" value={other} onChange={(e) => { changes.push('other'); setOther(e.target.value); }} />
      <input aria-label="free" defaultValue="" />
      <input type="checkbox" aria-label="box" />
    </form>
  );
}

async function serverPageTypedThenHydrated(typed: Record<string, string>) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(<Form />);
  document.body.replaceChildren(container);
  for (const [label, text] of Object.entries(typed)) {
    const field = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await act(async () => {
    hydrateRoot(container, <Form />);
  });
  return container;
}

beforeEach(() => {
  changes.length = 0;
});

it('React alone: an input shows the typed text but state holds the server value; a textarea is reset', async () => {
  await serverPageTypedThenHydrated({ subject: 'Typed early', body: 'edited text' });
  expect((document.querySelector('[aria-label="subject"]') as HTMLInputElement).value).toBe('Typed early');
  expect(state.subject).toBe('');
  expect((document.querySelector('[aria-label="body"]') as HTMLTextAreaElement).value).toBe('server text');
});

it('restores typed text into state, for inputs and textareas, and runs no other onChange', async () => {
  const container = await serverPageTypedThenHydrated({ subject: 'Typed early', body: 'edited text', free: 'uncontrolled' });
  let restored = 0;
  await act(async () => {
    restored = keepTypedBeforeHydration(container);
  });
  expect(restored).toBe(2);
  expect(state).toMatchObject({ subject: 'Typed early', body: 'edited text', other: '' });
  expect(changes.sort()).toEqual(['body', 'subject']);
  // A later render (typing elsewhere) no longer wipes the text
  const other = container.querySelector('[aria-label="other"]') as HTMLInputElement;
  await act(async () => {
    (other as HTMLInputElement & { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue('');
    other.value = 'x';
    other.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect((container.querySelector('[aria-label="subject"]') as HTMLInputElement).value).toBe('Typed early');
  expect((container.querySelector('[aria-label="body"]') as HTMLTextAreaElement).value).toBe('edited text');
  expect((container.querySelector('[aria-label="free"]') as HTMLInputElement).value).toBe('uncontrolled');
  // Typing after hydration is not recorded, so a later pass never brings old text back
  await act(async () => {
    expect(keepTypedBeforeHydration(container)).toBe(0);
  });
});

it('does nothing when nothing was typed (a second pass is a no-op)', async () => {
  const container = await serverPageTypedThenHydrated({});
  await act(async () => {
    expect(keepTypedBeforeHydration(container)).toBe(0);
  });
  expect(changes).toEqual([]);
});
