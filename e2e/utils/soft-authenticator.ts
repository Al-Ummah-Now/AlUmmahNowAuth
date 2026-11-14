/**
 * A software WebAuthn authenticator (ES256, "none" attestation) for the native passkey E2E.
 *
 * It answers exactly as the native platform APIs do: Apple (ASAuthorization) and Windows
 * (WebAuthn.dll) put the origin https://<RP ID> in clientDataJSON, so the spec can drive
 * /native/passkey/* on deployed QA and stage without a browser (wiki AUTH-PASSKEYS "Native apps").
 * Same construction as apps/auth/src/__tests__/native-passkeys.test.ts.
 */
function cborHead(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 256) return [(major << 5) | 24, n];
	return [(major << 5) | 25, n >> 8, n & 255];
}
function cbor(v: unknown): number[] {
	if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
	if (typeof v === 'string') {
		const b = [...new TextEncoder().encode(v)];
		return [...cborHead(3, b.length), ...b];
	}
	if (v instanceof Uint8Array) return [...cborHead(2, v.length), ...v];
	if (v instanceof Map) {
		const out = cborHead(5, v.size);
		for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
		return out;
	}
	throw new Error('cbor: unsupported');
}
export const b64url = (b: Uint8Array | ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
function der(raw: Uint8Array) {
	const int = (x: Uint8Array) => {
		let i = 0;
		while (i < x.length - 1 && x[i] === 0) i++;
		let v = [...x.slice(i)];
		if (v[0] & 0x80) v = [0, ...v];
		return [0x02, v.length, ...v];
	};
	const r = int(raw.slice(0, 32));
	const s = int(raw.slice(32));
	return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export class SoftAuthenticator {
	id = crypto.getRandomValues(new Uint8Array(16));
	counter = 0;
	keys!: CryptoKeyPair;
	async init() {
		this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
		return this;
	}
	get credentialId() {
		return b64url(this.id);
	}
	async cose() {
		const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
		return new Uint8Array(cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]])));
	}
	async create(options: any, origin: string) {
		const rpHash = await sha256(new TextEncoder().encode(options.rp.id));
		const authData = new Uint8Array([...rpHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, this.id.length, ...this.id, ...(await this.cose())]);
		const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
		const attestationObject = new Uint8Array(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			clientExtensionResults: {},
			response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
		};
	}
	async get(options: any, origin: string, userHandle?: string) {
		this.counter++;
		const rpHash = await sha256(new TextEncoder().encode(options.rpId));
		const authData = new Uint8Array(37);
		authData.set(rpHash);
		authData[32] = 0x05;
		new DataView(authData.buffer).setUint32(33, this.counter);
		const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
		const signed = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
		const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed as BufferSource));
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authData),
				signature: b64url(der(raw)),
				...(userHandle ? { userHandle: b64url(new TextEncoder().encode(userHandle)) } : {}),
			},
		};
	}
}

