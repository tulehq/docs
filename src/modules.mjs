// @ts-check
// The Go modules served under tule.dev. Each one gets a landing page at
// /<name>/ and a go-import and a go-source tag on every page of the site
// (astro.config.mjs). Adding a module is one entry here.
//
// Plain JavaScript, so that scripts/check-go-import.mjs can import it with
// node and no build step.

/**
 * @typedef {object} Module
 * @property {string} name The last element of the module path, tule.dev/<name>.
 * @property {string} repo The repository the go command fetches the module from.
 * @property {string} description One line on what the module is.
 */

/** @type {Module[]} */
export const modules = [
	{
		name: 'object-store',
		repo: 'https://github.com/tulehq/object-store',
		description: 'S3-compatible object storage.',
	},
	{
		name: 'secret-store',
		repo: 'https://github.com/tulehq/secret-store',
		description: 'Secrets Manager-compatible secret storage.',
	},
	{
		name: 'accounts',
		repo: 'https://github.com/tulehq/accounts',
		description: 'Organizations-compatible accounts.',
	},
	{
		name: 'identity',
		repo: 'https://github.com/tulehq/identity',
		description: 'IAM and STS-compatible users, access keys and role sessions.',
	},
	{
		name: 'mailbox',
		repo: 'https://github.com/tulehq/mailbox',
		description: 'SES v2-compatible mail that is stored for retrieval, never delivered.',
	},
	{
		name: 'queues',
		repo: 'https://github.com/tulehq/queues',
		description: 'SQS-compatible standard and FIFO queues.',
	},
	{
		name: 'functions',
		repo: 'https://github.com/tulehq/functions',
		description: 'Lambda-compatible container-image functions, triggered by queues.',
	},
	{
		name: 'console',
		repo: 'https://github.com/tulehq/console',
		description: 'A web console for every Tule service.',
	},
	{
		name: 'sigv4',
		repo: 'https://github.com/tulehq/sigv4',
		description: 'Shared AWS Signature Version 4 verification.',
	},
];

/** @param {Module} m */
export const modulePath = (m) => `tule.dev/${m.name}`;

/**
 * The content of the module's go-import tag.
 * @param {Module} m
 */
export const goImport = (m) => `${modulePath(m)} git ${m.repo}`;

/**
 * The content of the module's go-source tag.
 * @param {Module} m
 */
export const goSource = (m) =>
	`${modulePath(m)} ${m.repo} ${m.repo}/tree/main{/dir} ${m.repo}/blob/main{/dir}/{file}#L{line}`;
