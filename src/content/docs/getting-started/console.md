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
Without identity, a read the service denies by policy still signs the key in,
since the service answers it only past the signature check.

What a section shows is what the service allows the signed-in principal. A
key with no policy signs in, since `GetCallerIdentity` needs no permission,
but sees `AccessDenied` in every section; give its user or role a policy, as
[Identity and keys](/guides/identity/#policies) shows. A role session of a
member account sees what a resource policy shares with it besides its own
identity policies, as [cross-account access](/guides/identity/#cross-account-access)
describes, and of accounts only `DescribeOrganization`.

Each bucket, secret, queue, function and email identity page has a Policy
section to read, edit and delete its resource-based policy; a save from a
page whose policy changed since it was loaded is refused rather than
overwriting the change. See [console](/console/#resource-policies).

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
| `/iam` | identity | IAM users, their access keys and policies; roles at `/iam/roles` and managed policies at `/iam/policies` |
| `/mail` | mailbox | Stored messages and rendering failures; email identities and their sending authorization policies at `/mail/identities` |
| `/sqs` | queues | Queues, their attributes and messages; send, purge, delete |
| `/lambda` | functions | Functions, invocations, event source mappings; invoke |

A section appears only when its service's endpoint is configured. See
[console](/console/) for its configuration.
