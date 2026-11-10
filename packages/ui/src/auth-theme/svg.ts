/**
 * Header graphics are inlined into the sign-in page so they can use the
 * theme's colours and motion. Uploaded SVG is untrusted: only drawing
 * elements and attributes survive, links may only point inside the SVG, and
 * <style> keeps plain CSS (no @import, no url() other than #ids).
 */

const ELEMENTS = new Set(
	[
		'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient',
		'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'use', 'symbol', 'title', 'desc', 'style', 'filter',
		'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'fedropshadow',
	]
);

const ATTRIBUTE = /^(?:[a-z][a-z0-9-]*|xlink:href|xml:space|xmlns(?::xlink)?|viewBox|preserveAspectRatio|gradientUnits|gradientTransform|patternUnits|patternContentUnits|patternTransform|clipPathUnits|maskUnits|maskContentUnits|stdDeviation|flood-color|flood-opacity|in2|result|dx|dy|textLength|lengthAdjust|startOffset|spreadMethod|filterUnits|primitiveUnits|values|operator|mode|k[1-4])$/;

function safeCss(css: string): string {
	return css
		.replace(/<!\[CDATA\[|\]\]>/g, '')
		.replace(/<\/?[a-z]/gi, '')
		.replace(/@import[^;]*;?/gi, '')
		.replace(/expression\s*\(/gi, '')
		.replace(/javascript:/gi, '')
		.replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
		.replace(/\\/g, '');
}

function safeAttr(name: string, value: string): string | null {
	const lower = name.toLowerCase();
	if (lower.startsWith('on') || !ATTRIBUTE.test(name)) return null;
	if (/javascript:|data:|vbscript:/i.test(value)) return null;
	if ((lower === 'href' || lower === 'xlink:href') && !value.startsWith('#')) return null;
	if (lower === 'style') return safeCss(value);
	if (/url\(/i.test(value) && !/^url\(#[A-Za-z0-9_-]+\)$/.test(value.trim())) return null;
	return value;
}

const esc = (v: string) => v.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Sanitized SVG markup, or null when there is no <svg> root. */
export function sanitizeSvg(input: string): string | null {
	const src = input.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
	const start = src.search(/<svg[\s>]/i);
	if (start < 0) return null;
	let out = '';
	let skipDepth = 0;
	let inStyle = false;
	const re = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
	re.lastIndex = start;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const [, closing, rawName, attrs, selfClose, text, stray] = m;
		if (text !== undefined || stray !== undefined) {
			if (skipDepth === 0) out += inStyle ? safeCss(text ?? '') : esc(text ?? '&lt;');
			continue;
		}
		const name = rawName.toLowerCase();
		const allowed = ELEMENTS.has(name);
		if (closing) {
			if (skipDepth > 0) {
				skipDepth--;
				continue;
			}
			if (!allowed) continue;
			if (name === 'style') inStyle = false;
			out += `</${rawName}>`;
			continue;
		}
		if (skipDepth > 0 || !allowed) {
			if (!selfClose) skipDepth++;
			continue;
		}
		let kept = '';
		for (const a of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
			const value = a[3] ?? a[4] ?? a[5] ?? '';
			const safe = safeAttr(a[1], value);
			if (safe !== null) kept += a[2] === undefined ? ` ${a[1]}` : ` ${a[1]}="${esc(safe)}"`;
		}
		out += `<${rawName}${kept}${selfClose ? '/' : ''}>`;
		if (name === 'style' && !selfClose) inStyle = true;
	}
	return out.trim() || null;
}
