/**
 * openauth_atomic key ranges of the issuer's short-lived records (keys are the storage key joined
 * with "::"; ':' is 0x3A, ';' 0x3B, so [prefix + '::', prefix + ':;') is exactly that family).
 */
export const CODE_RANGE = ['oauth:code::', 'oauth:code:;'] as const;
export const CODE_USED_RANGE = ['oauth:code_used::', 'oauth:code_used:;'] as const;
export const DEVICE_RANGE = ['oauth:device::', 'oauth:device:;'] as const;
/** Native passkey challenges (sign-in and registration), 2 minutes, single use. */
export const NATIVE_PASSKEY_RANGE = ['oauth:native-passkey::', 'oauth:native-passkey:;'] as const;
