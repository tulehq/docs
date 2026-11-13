---
title: Signing in to the console
description: Sign in to the Tule console with the root key, an IAM user's key, or a role session.
---

The console runs at `http://localhost:9070` in [the full stack](/getting-started/full-stack/).
It has no data of its own: it calls each service's real API, signed with the
key you sign in with.

## Sign in

The sign-in page takes an access key ID, its secret, and, for a role session,
its session token. Every key a service accepts works:

- the root key the services are configured with (in the full stack,
  `AKIAIOSFODNN7EXAMPLE` and `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`);
- a key identity issued to an IAM user;
- a role session's key and token from identity's `AssumeRole`.

See [Identity and keys](/guides/identity/) for making the last two.

The console checks the key with a signed call: identity's `GetCallerIdentity`
when identity is configured, which also names who signed in, shown at the top
of every page. Without identity it makes the cheapest read of the first
configured service (`ListBuckets`, `ListSecrets`, `DescribeOrganization`,
`GetAccount`, `ListQueues` or `ListFunctions`). A key the service answers `401`
or `403` to is refused; a service that cannot be reached is reported as such.

What a section shows is what the service allows the signed-in principal. An IAM
user, for example, sees identity's `AccessDenied` in the Identity section,
since only the root user and role sessions may call IAM operations.

## Sessions

- The key is held server-side, in a session in memory. The browser gets an
  opaque `HttpOnly`, `SameSite=Strict` cookie, `tule_console_session`, and the
  key never reaches the browser after sign-in.
- A session lasts `TULE_Console_SessionTTL`, 12 hours by default. Signing out
  drops the key.
- A console restart signs everyone out. Sessions are not shared between two
  consoles.
- Sign-in is limited per client: ten failed attempts, then one more every six
  seconds. Behind a proxy, or Docker Desktop's port forwarding, every client
  shares the proxy's limit unless `TULE_Console_TrustedProxies` names it.

## Sections

| Path | Service | What it does |
|---|---|---|
| `/s3` | object-store | Buckets and objects: browse by prefix, upload, download, delete |
| `/secrets` | secret-store | Secrets, versions and staging labels; reveal, put, delete, restore |
| `/accounts` | accounts | The organization tree; create the organization, accounts and OUs |
| `/iam` | identity | IAM users and their access keys |
| `/mail` | mailbox | Stored messages and rendering failures |
| `/sqs` | queues | Queues, their attributes and messages; send, purge, delete |
| `/lambda` | functions | Functions, invocations, event source mappings; invoke |

A section appears only when its service's endpoint is configured. See
[console](/console/) for its configuration.
