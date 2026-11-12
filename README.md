# tule.dev

The site at https://tule.dev, built with [Starlight](https://starlight.astro.build)
and served from GitHub Pages. Its main job is the Go vanity import metadata
that lets `go get tule.dev/<module>` resolve: every page carries a
`go-import` and a `go-source` tag for every module.

## Run it locally

Needs Node 22.23.4 or later and pnpm 12.11.2, the version pinned by
`packageManager` in package.json.

```sh
pnpm install
pnpm dev               # http://localhost:4321
pnpm build             # writes dist/
pnpm check-go-import   # checks the go-import and go-source tags in dist/
pnpm preview           # serves dist/
```

To see what the go command sees, run `pnpm preview` and fetch a path with
`?go-get=1`, such as `curl 'http://localhost:4321/sigv4/sub/pkg?go-get=1'`.
A path with no page of its own gets the 404 page, which carries the same tags.

## Add a module

Add an entry to `modules` in `src/modules.mjs`:

```js
{
	name: 'queue',
	repo: 'https://github.com/tulehq/queue',
	description: 'SQS-compatible job queues.',
},
```

That gives the module a landing page at `/queue/`, a sidebar link, a line on
the home page, and its `go-import` and `go-source` tags on every page.
`pnpm check-go-import` checks for the new module's tags too.

## Deploy

`.github/workflows/deploy.yml` builds and checks the site on every pull
request, and on a push to main, or when run by hand, deploys it to GitHub
Pages. The repository's Pages source must be set to GitHub Actions.

The custom domain, tule.dev, is set in the repository's Pages settings
(Settings, Pages, Custom domain), not in a CNAME file in this repository.
