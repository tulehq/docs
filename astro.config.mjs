// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { goImport, goSource, modules } from './src/modules.mjs';

// The go command resolves tule.dev/<module> by fetching
// https://tule.dev/<path>?go-get=1 and reading the go-import tags in the
// response's <head>. It parses those tags from any response, a 404
// included, and checks the status only when it finds none; it then picks
// the tag whose prefix is a path prefix of the import path it asked for
// (cmd/go/internal/vcs metaImportsForPrefix and matchGoImport). So every
// page carries the tags of every module, and a path with no page of its
// own, such as tule.dev/sigv4/sub/pkg, resolves through the 404 page.
//
// These entries apply to every page, the 404 page included. Starlight
// replaces a config head entry when a page's frontmatter head has a meta
// tag with the same name, so no page may set a go-import or go-source tag
// of its own: it would drop the tags of every other module.
const goHead = modules.flatMap((m) => [
	{ tag: 'meta', attrs: { name: 'go-import', content: goImport(m) } },
	{ tag: 'meta', attrs: { name: 'go-source', content: goSource(m) } },
]);

// Deployed to GitHub Pages behind the custom domain tule.dev, so the site
// lives at the root.
export default defineConfig({
	site: 'https://tule.dev',
	integrations: [
		starlight({
			title: 'Tule',
			description: 'Local drop-in replacements for AWS services.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tulehq' }],
			head: goHead,
			plugins: [starlightLinksValidator()],
			// Every module in src/modules.mjs has a page at /<name>/, listed
			// under Services or Libraries; scripts/check-go-import.mjs fails
			// when one is missing.
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'The full stack', link: '/getting-started/full-stack/' },
						{ label: 'One service alone', link: '/getting-started/one-service/' },
						{ label: 'Signing in to the console', link: '/getting-started/console/' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'AWS SDKs and the CLI', link: '/guides/aws-clients/' },
						{ label: 'Gas apps', link: '/guides/gas/' },
						{ label: 'Identity and keys', link: '/guides/identity/' },
					],
				},
				{
					label: 'Services',
					items: [
						'object-store',
						'secret-store',
						'accounts',
						'identity',
						'mailbox',
						'queues',
						'functions',
						'console',
					].map((name) => ({ label: name, link: `/${name}/` })),
				},
				{
					label: 'Libraries',
					items: [
						{ label: 'sigv4', link: '/sigv4/' },
						{ label: 'policy', link: '/policy/' },
					],
				},
			],
		}),
	],
});
