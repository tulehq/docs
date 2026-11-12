// @ts-check
// Checks that the built site serves every module's go-import and go-source
// tags on the home page, the 404 page and each module's landing page, and
// exits 1 otherwise.
//
// Usage: node scripts/check-go-import.mjs <dist directory>
//
// Like the go command, it reads tags only from the document up to <body> or
// </head>, so a tag placed later fails the check.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { goImport, goSource, modules } from '../src/modules.mjs';

const dist = process.argv[2];
if (!dist) {
	console.error('usage: node scripts/check-go-import.mjs <dist directory>');
	process.exit(2);
}

const pages = ['index.html', '404.html', ...modules.map((m) => join(m.name, 'index.html'))];

/**
 * The content of each <meta> tag named `name` before <body> or </head>.
 * @param {string} html
 * @param {string} name
 */
function metaContents(html, name) {
	const end = html.search(/<body[\s>]|<\/head\s*>/i);
	const head = end < 0 ? html : html.slice(0, end);
	const contents = [];
	for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
		const attr = (/** @type {string} */ key) =>
			tag.match(new RegExp(`\\s${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
		if (attr('name') === name) contents.push(attr('content'));
	}
	return contents;
}

let failures = 0;
for (const page of pages) {
	const html = await readFile(join(dist, page), 'utf8');
	const imports = metaContents(html, 'go-import');
	const sources = metaContents(html, 'go-source');
	for (const m of modules) {
		if (!imports.includes(goImport(m))) {
			console.error(`${page}: missing <meta name="go-import" content="${goImport(m)}">`);
			failures++;
		}
		if (!sources.includes(goSource(m))) {
			console.error(`${page}: missing <meta name="go-source" content="${goSource(m)}">`);
			failures++;
		}
	}
}

if (failures > 0) {
	console.error(`${failures} tag(s) missing`);
	process.exit(1);
}
console.log(`go-import and go-source tags for ${modules.length} modules found on ${pages.length} pages: ${pages.join(', ')}`);
