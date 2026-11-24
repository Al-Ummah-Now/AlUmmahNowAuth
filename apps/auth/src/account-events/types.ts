/** Account events (docs/account-hub/SPEC.md §5.4). Never an email, a name, a date of birth or an age band. */
export const ACCOUNT_EVENT_TYPES = ['account-disabled', 'account-enabled', 'account-purged', 'account-export-requested', 'verification'] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/** The event URIs in a SET: RISC, OpenID Shared Signals, and our own for exports. */
export const EVENT_URIS: Record<AccountEventType, string> = {
	'account-disabled': 'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
	'account-enabled': 'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
	'account-purged': 'https://schemas.openid.net/secevent/risc/event-type/account-purged',
	'account-export-requested': 'https://alummahnow.dev/events/account-export-requested',
	verification: 'https://schemas.openid.net/secevent/ssf/event-type/verification',
};

export type AccountEvent =
	| { type: 'account-disabled'; userId: string; reason: 'age' | 'deleted' }
	| { type: 'account-enabled' | 'account-purged'; userId: string }
	| { type: 'account-export-requested'; userId: string; exportId: string };

export interface AccountEventsEnv {
	AUTH_DB: D1Database;
	AUTH_STORAGE: KVNamespace;
	OPENAUTH_ISSUER?: string;
	/** "on" in an environment that sends account events; anything else is off. */
	ACCOUNT_EVENTS?: string;
	ACCOUNT_EVENTS_QUEUE?: Queue;
}

export const accountEventsOn = (env: { ACCOUNT_EVENTS?: string }) => env.ACCOUNT_EVENTS === 'on';

/** The same env with events off: for accounts no app should hear about (E2E run accounts). */
export const withoutAccountEvents = <T extends object>(env: T): T & { ACCOUNT_EVENTS: 'off' } => ({ ...env, ACCOUNT_EVENTS: 'off' });

export interface AccountEventMessage {
	type: 'account-event.deliver';
	jti: string;
}
