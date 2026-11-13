---
title: Identity and keys
description: Static keys, identity-issued keys, AssumeRole into member accounts, and what every key shares.
---

## Standalone: one static key

Every service is configured with one key, `TULE_Auth_AccessKeyID` and
`TULE_Auth_SecretAccessKey`, and accepts it for every operation. Run alone, a
service accepts only that key and never contacts another service. The key is
long-term, so a request that carries a session token on it is refused.

## With identity: issued keys on every service

[identity](/identity/) stands in for IAM and STS, and issues the keys the other
services verify. To make a service accept them, set
`TULE_Auth_IdentityEndpoint` to identity's base URL:

```sh
TULE_Auth_IdentityEndpoint=http://identity:9030
```

The service's configured key must then be identity's root key:
`TULE_Auth_AccessKeyID` and `TULE_Auth_SecretAccessKey` set to the same values
on both. The service signs its calls to identity's signing-key endpoint with
it.

- The root key is checked locally first and never asks identity.
- Any other key is looked up in identity on every request, with nothing
  cached, so a key identity deactivates or deletes is refused on the next
  request.
- A lookup that fails, such as identity being unreachable or not answering
  within 10 seconds, fails the request with a `500`. It is never treated as
  an unknown key or as a valid one, and the root key keeps working.

[The full stack](/getting-started/full-stack/) sets this up for every service.

## Principals

identity has three kinds of principal:

| Principal | Key | Acts in |
|---|---|---|
| The root user | The configured root key | The management account, `TULE_Identity_AccountID` (`000000000000` by default) |
| IAM users | Up to two access keys each, from `CreateAccessKey` | Its own account |
| Role sessions | A key, secret, session token and expiration, from `AssumeRole` | The role's member account |

With no policies, the rules are fixed:

- IAM operations may be called by the root user and by
  `OrganizationAccountAccessRole` sessions, each in its own account. An IAM
  user gets `AccessDenied`.
- Every active principal may call `GetCallerIdentity` and `GetAccessKeyInfo`,
  and every active key works against the other Tule services.
- `AssumeRole` may be called by the root user only.

## Create a user and a key

With the root key and the [endpoint variables](/guides/aws-clients/) set:

```sh
aws iam create-user --user-name dev
aws iam create-access-key --user-name dev
```

The `CreateAccessKey` response is the only one that carries the secret. Or
with curl:

```sh
curl -fsS --aws-sigv4 aws:amz:us-east-1:iam \
  --user AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --data-binary 'Action=CreateUser&Version=2010-05-08&UserName=dev' \
  http://localhost:9030/
```

## AssumeRole into a member account

identity can assume one role,
`arn:aws:iam::<account>:role/OrganizationAccountAccessRole`, where `<account>`
is an `ACTIVE` member of the organization in [accounts](/accounts/) other than
the management account. Only the root user may call it.

It needs `TULE_Identity_AccountsEndpoint` set on identity (the full stack sets
it to `http://accounts:9020`). identity asks accounts which account manages
the organization, which must be `TULE_Identity_AccountID`, and whether the
account is an active member. Without the endpoint, every role is refused with
`AccessDenied`.

```sh
aws organizations create-organization --feature-set ALL
aws organizations create-account --email dev@example.com --account-name dev
# CreateAccount finishes at once; read the new account's ID from its status
# or from:
aws organizations list-accounts
aws sts assume-role \
  --role-arn arn:aws:iam::<account>:role/OrganizationAccountAccessRole \
  --role-session-name dev
```

The session lasts `DurationSeconds`, 3600 by default and at most 3600. Its
key, secret and token sign requests to every service pointed at identity; set
`AWS_SESSION_TOKEN` with them. A session's `UserId` is `<role ID>:<session>`
and its ARN
`arn:aws:sts::<account>:assumed-role/OrganizationAccountAccessRole/<session>`.
Role chaining is not possible.

## What is shared

There is no per-account data isolation. Every accepted key, the root key, an
IAM user's or a role session's in any account, sees and changes the same data:

- object-store: every bucket and object;
- secret-store: every secret, with ARNs that keep `TULE_Store_AccountID`
  whoever signed;
- accounts: the one organization, with every Organizations operation;
- mailbox: every stored message;
- queues: every queue, in the configured account;
- functions: every function. Each function's containers get the root key by
  default.

identity itself keeps users per account: users a role session creates belong
to its member account.

## Policies

IAM policies are in progress. In the released services no policy is
evaluated: beyond identity's fixed rules above, every accepted key may call
every operation.
