/**
 * @fileoverview In-page confirmation dialog for Auth's server-rendered pages.
 *
 * Never a browser prompt: a form that needs confirmation carries
 * `confirmAttributes(...)`; the page renders `renderConfirmDialog(locale)` once.
 * Submitting the form opens a native `<dialog>` (showModal: focus trap and Esc
 * built in). Cancel, Esc and a click on the backdrop leave the form unsent;
 * the confirm button sends it. Focus starts on Cancel.
 *
 * The CSP allows inline scripts (utils/security-headers.ts), so the script is
 * inline. Every text the script shows comes from data attributes and is set
 * with textContent, never as HTML.
 */
import { errorPageLocale } from './error-page';

export type UiLocale = 'en' | 'ar';

/** English unless the link asks for Arabic with `?lang=ar`. */
export function uiLocale(request?: Request): UiLocale {
	return errorPageLocale(request);
}

export interface ConfirmCopy {
	cancel: string;
	signOut: string;
	signOutAllOtherTitle: string;
	signOutAllOtherMessage: string;
	signOutAllOtherAction: string;
	signOutDeviceTitle: string;
	signOutDeviceMessage: string;
	signOutAccountTitle: string;
	/** `{email}` is replaced with the account's email */
	signOutAccountMessage: string;
	signOutAllAccountsTitle: string;
	signOutAllAccountsMessage: string;
	signOutAllAccountsAction: string;
	switchFailed: string;
	unknownError: string;
}

export const CONFIRM_COPY: Record<UiLocale, ConfirmCopy> = {
	en: {
		cancel: 'Cancel',
		signOut: 'Sign out',
		signOutAllOtherTitle: 'Sign out all other devices?',
		signOutAllOtherMessage: 'Every other device is signed out. You stay signed in on this device.',
		signOutAllOtherAction: 'Sign out other devices',
		signOutDeviceTitle: 'Sign out this device?',
		signOutDeviceMessage: 'That device will need to sign in again.',
		signOutAccountTitle: 'Sign out of this account?',
		signOutAccountMessage: '{email} is signed out of this browser.',
		signOutAllAccountsTitle: 'Sign out of all accounts?',
		signOutAllAccountsMessage: 'Every account is signed out of this browser. You will need to sign in again.',
		signOutAllAccountsAction: 'Sign out of all',
		switchFailed: "Couldn't switch account",
		unknownError: 'Unknown error',
	},
	ar: {
		cancel: 'إلغاء',
		signOut: 'تسجيل الخروج',
		signOutAllOtherTitle: 'تسجيل الخروج من كل الأجهزة الأخرى؟',
		signOutAllOtherMessage: 'سيتم تسجيل الخروج من كل الأجهزة الأخرى، وتبقى مسجّلًا على هذا الجهاز.',
		signOutAllOtherAction: 'تسجيل الخروج من الأجهزة الأخرى',
		signOutDeviceTitle: 'تسجيل الخروج من هذا الجهاز؟',
		signOutDeviceMessage: 'سيحتاج ذلك الجهاز إلى تسجيل الدخول مجددًا.',
		signOutAccountTitle: 'تسجيل الخروج من هذا الحساب؟',
		signOutAccountMessage: 'سيتم تسجيل خروج {email} من هذا المتصفح.',
		signOutAllAccountsTitle: 'تسجيل الخروج من كل الحسابات؟',
		signOutAllAccountsMessage: 'سيتم تسجيل الخروج من كل الحسابات في هذا المتصفح، وستحتاج إلى تسجيل الدخول مجددًا.',
		signOutAllAccountsAction: 'تسجيل الخروج من الكل',
		switchFailed: 'تعذّر تبديل الحساب',
		unknownError: 'خطأ غير معروف',
	},
};

export interface ConfirmRequest {
	title: string;
	message: string;
	/** Label of the destructive button */
	action: string;
}

/** Attributes for a `<form>` that must be confirmed in the dialog before it is sent. */
export function confirmAttributes({ title, message, action }: ConfirmRequest): string {
	return `data-confirm-title="${escapeHtml(title)}" data-confirm-message="${escapeHtml(message)}" data-confirm-action="${escapeHtml(action)}"`;
}

export const CONFIRM_DIALOG_ID = 'aun-confirm-dialog';

/**
 * The page's confirmation dialog, its styles and the script that opens it.
 * Render once per page, after the forms.
 */
export function renderConfirmDialog(locale: UiLocale): string {
	const t = CONFIRM_COPY[locale];
	const dir = locale === 'ar' ? 'rtl' : 'ltr';
	return `
<dialog id="${CONFIRM_DIALOG_ID}" class="aun-confirm" role="alertdialog" lang="${locale}" dir="${dir}" aria-labelledby="${CONFIRM_DIALOG_ID}-title" aria-describedby="${CONFIRM_DIALOG_ID}-message">
  <form method="dialog" class="aun-confirm__body">
    <h2 id="${CONFIRM_DIALOG_ID}-title" class="aun-confirm__title"></h2>
    <p id="${CONFIRM_DIALOG_ID}-message" class="aun-confirm__message"></p>
    <div class="aun-confirm__actions">
      <button type="submit" value="cancel" class="aun-confirm__cancel" autofocus>${escapeHtml(t.cancel)}</button>
      <button type="submit" value="confirm" class="aun-confirm__danger" data-confirm-button>${escapeHtml(t.signOut)}</button>
    </div>
  </form>
</dialog>
<style>
  .aun-confirm { padding: 0; border: 1px solid #e5e7eb; border-radius: 12px; max-inline-size: min(28rem, calc(100vw - 2rem)); inline-size: 100%; color: #111827; background: #fff; box-shadow: 0 20px 40px rgba(0,0,0,.2); }
  .aun-confirm::backdrop { background: rgba(17,24,39,.5); }
  .aun-confirm__body { padding: 1.5rem; margin: 0; font-family: inherit; }
  .aun-confirm__title { margin: 0 0 .5rem; font-size: 1.125rem; font-weight: 600; text-align: start; }
  .aun-confirm__message { margin: 0 0 1.5rem; font-size: .875rem; line-height: 1.5; color: #4b5563; text-align: start; overflow-wrap: anywhere; }
  .aun-confirm__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
  .aun-confirm__actions button { padding: .5rem 1rem; border-radius: 8px; font-size: .875rem; font-weight: 500; cursor: pointer; font-family: inherit; }
  .aun-confirm__cancel { border: 1px solid #d1d5db; background: #fff; color: #111827; }
  .aun-confirm__danger { border: 1px solid #b91c1c; background: #dc2626; color: #fff; }
  .aun-confirm__actions button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    .aun-confirm { color: #f9fafb; background: #1f2937; border-color: #374151; }
    .aun-confirm__message { color: #d1d5db; }
    .aun-confirm__cancel { background: #111827; color: #f9fafb; border-color: #4b5563; }
  }
</style>
<script>
(function () {
  if (window.__aunConfirmDialog) return;
  window.__aunConfirmDialog = true;
  var pending = null;
  function dialog() { return document.getElementById('${CONFIRM_DIALOG_ID}'); }
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-confirm-title')) return;
    // Never sent without the in-page confirmation
    event.preventDefault();
    var dlg = dialog();
    if (!dlg || typeof dlg.showModal !== 'function' || dlg.open) return;
    pending = form;
    dlg.querySelector('#${CONFIRM_DIALOG_ID}-title').textContent = form.getAttribute('data-confirm-title');
    dlg.querySelector('#${CONFIRM_DIALOG_ID}-message').textContent = form.getAttribute('data-confirm-message');
    dlg.querySelector('[data-confirm-button]').textContent = form.getAttribute('data-confirm-action');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.querySelector('.aun-confirm__cancel').focus();
  }, true);
  document.addEventListener('click', function (event) {
    var dlg = dialog();
    // A click on the backdrop lands on the dialog element itself: cancel
    if (dlg && dlg.open && event.target === dlg) dlg.close('cancel');
  });
  document.addEventListener('close', function (event) {
    var dlg = dialog();
    if (event.target !== dlg) return;
    var form = pending;
    pending = null;
    if (form && dlg.returnValue === 'confirm') HTMLFormElement.prototype.submit.call(form);
  }, true);
})();
</script>
`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
