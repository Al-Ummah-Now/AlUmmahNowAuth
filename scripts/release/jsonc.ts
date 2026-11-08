/**
 * Minimal JSONC reader for wrangler config files: strips // and block comments
 * and trailing commas (outside strings), then JSON.parse. No dependency, so the
 * release scripts run with plain `node --experimental-strip-types`.
 */
export function parseJsonc(text: string): unknown {
	let out = '';
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += next ?? '';
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return JSON.parse(stripTrailingCommas(out));
}

function stripTrailingCommas(text: string): string {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += text[i + 1] ?? '';
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ',') {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === '}' || text[j] === ']') continue;
		}
		out += ch;
	}
	return out;
}
