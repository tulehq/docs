---
title: Identity and keys
description: Static keys, identity-issued keys, identity and resource policies, AssumeRole into member accounts, cross-account access, and what every key shares.
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

- The root key is checked locally first, never asks identity, and is never
  evaluated against policies.
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
| Role sessions | A key, secret, session token and expiration, from `AssumeRole` | The role's account |

The root user may do everything. Every other principal may do what its
identity policies, and the policies of the resources it acts on, allow, on
identity and on every service pointed at it; see [Policies](#policies).

## Create a user and a key

With the root key and the [endpoint variables](/guides/aws-clients/) set:

```sh
aws iam create-user --user-name dev
aws iam create-access-key --user-name dev
```

The `CreateAccessKey` response is the only one that carries the secret. The
new key is denied everything but `GetCallerIdentity` until `dev` has a
policy; see [Policies](#policies). Or with curl:

```sh
curl -fsS --aws-sigv4 aws:amz:us-east-1:iam \
  --user AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --data-binary 'Action=CreateUser&Version=2010-05-08&UserName=dev' \
  http://localhost:9030/
```

## Roles and AssumeRole

`CreateRole` makes a role with a trust policy, which says who may assume it.
A role can be assumed when its trust policy allows the caller, and, unless
the caller is the root user, the caller's own policies allow `sts:AssumeRole`
on the role; within one account, a trust policy that names the caller
directly is enough. The session carries the role's policies:

```sh
aws iam create-role --role-name deployer --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:user/dev"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name deployer \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

The session lasts `DurationSeconds`, 3600 by default and at most the role's
`MaxSessionDuration`. Its key, secret and token sign requests to every
service pointed at identity; set `AWS_SESSION_TOKEN` with them. A session's
`UserId` is `<role ID>:<session>` and its ARN
`arn:aws:sts::<account>:assumed-role/<role name>/<session>`. A session of a
role that is deleted still authenticates until it expires, but is denied
everything but `GetCallerIdentity`, even if a role of the same name is
created again.

### Into a member account

From the management account, the caller may also assume a role in an
`ACTIVE` member account of the organization in [accounts](/accounts/). The
first time `arn:aws:iam::<account>:role/OrganizationAccountAccessRole` is
assumed from the management account, identity creates that role, as
Organizations would have: a trust policy for the management account's root
and `AdministratorAccess` attached. After that it is an ordinary role.

It needs `TULE_Identity_AccountsEndpoint` set on identity (the full stack sets
it to `http://accounts:9020`). identity asks accounts which account manages
the organization, which must be `TULE_Identity_AccountID`, and whether the
account is an active member. Without the endpoint, only roles of the
caller's own account can be assumed.

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

A member account's session is a principal of that account. In identity it
manages that account's users, roles and policies. On the other services it
reaches the management account's resources only where a resource policy
grants it, as on AWS; see [Cross-account access](#cross-account-access).

## Policies

identity stores managed and inline identity policies and role trust
policies. Every service pointed at identity evaluates the identity policies
of the keys it issued together with the resource policy of what the request
acts on, as AWS does, with [tule.dev/policy](/policy/)'s `Authorize`:

- The root key is never evaluated, and may do everything.
- Every other key is evaluated on every request against its principal's
  identity policies, a user's inline policies and the default versions of
  its attached managed policies, or a session's role's, as they are at that
  request, and against the resource's policy, if it has one.
- An explicit `Deny` in either kind of policy wins.
- **Within the service's account**, an `Allow` in either kind allows. A
  resource policy that names the principal itself (its user ARN, its role's
  ARN with the path, its session ARN, or `"*"`) is enough on its own; one
  that names only the account also needs an identity `Allow`.
- **Across accounts**, both an identity `Allow` in the caller's account and
  a resource policy `Allow` are needed; see
  [Cross-account access](#cross-account-access).
- **A key with no policy is denied** every request, `AccessDenied` in the
  service's own protocol, except identity's `GetCallerIdentity`, unless a
  resource policy in its own account names it.
- Each action is the one the Service Authorization Reference lists for the
  operation, such as `s3:GetObject` on `arn:aws:s3:::<bucket>/<key>`; each
  service's page lists its actions, resources and condition keys.

To give a user permissions, attach a managed policy or put an inline one.
`AdministratorAccess`, the one AWS managed policy shipped, allows everything:

```sh
aws iam attach-user-policy --user-name dev \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

Or something narrower, such as read access to one bucket:

```sh
aws iam put-user-policy --user-name dev --policy-name read-uploads \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":["arn:aws:s3:::uploads","arn:aws:s3:::uploads/*"]}]}'
```

A change applies on the next request, since nothing is cached. A role gets
policies the same way, with `attach-role-policy` and `put-role-policy`.

The Tule-specific retrieval routes of mailbox and queues are behind
`tule:Inspect`, an action of Tule's own, which a policy names beside the
service's actions, as in `"Action": ["sqs:*", "tule:Inspect"]`. So are the
retrieval routes of functions.

The resource policies are object-store's bucket policies, secret-store's
secret resource policies, queues' queue policies (`Policy` and
`AddPermission`), functions' function policies and mailbox's sending
authorization policies; each service's page describes its own. accounts
serves no resource policy.

A role session's `aws:PrincipalArn` is its role's ARN with the role's path,
as on AWS, so a condition on a path-scoped role ARN, such as
`arn:aws:iam::*:role/restricted/*`, matches the role's sessions. The
services also supply `aws:userid` and `aws:PrincipalTag/<key>`.

Not evaluated anywhere: permissions boundaries, session policies, service
control policies and resource control policies. Resource policies match
principals by ARN, so a user or role deleted and created again under the
same name keeps its grants, where AWS would not. `aws:PrincipalOrgID` is not
supplied, so a `Deny` written with a negated operator on it denies every
evaluated principal.

## Cross-account access

A principal of a member account, such as an `OrganizationAccountAccessRole`
session, reaches a resource of the management account when its own
identity policies allow the action and the resource's policy grants it,
directly or through its account. Neither is enough alone.

This walkthrough grants a member account's role session read access to a
secret and to a bucket, with the [full stack](/getting-started/full-stack/)
running and the [endpoint variables](/guides/aws-clients/) set. First, as
the management account's root key, create the secret and the bucket, and
give each a resource policy naming the member account's role (`<member>`
is the account ID from `list-accounts`, [above](#into-a-member-account)):

```sh
aws secretsmanager create-secret --name shared/config --secret-string '{"mode":"demo"}'
aws secretsmanager put-resource-policy --secret-id shared/config --resource-policy \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<member>:role/OrganizationAccountAccessRole"},"Action":"secretsmanager:GetSecretValue","Resource":"*"}]}'
aws secretsmanager describe-secret --secret-id shared/config --query ARN --output text

aws s3api create-bucket --bucket shared
echo hello > hello.txt
aws s3api put-object --bucket shared --key hello.txt --body hello.txt
aws s3api put-bucket-policy --bucket shared --policy \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<member>:role/OrganizationAccountAccessRole"},"Action":"s3:GetObject","Resource":"arn:aws:s3:::shared/*"}]}'
```

Then assume the role and switch to its session's credentials:

```sh
aws sts assume-role \
  --role-arn arn:aws:iam::<member>:role/OrganizationAccountAccessRole \
  --role-session-name reader
export AWS_ACCESS_KEY_ID=<AccessKeyId> AWS_SECRET_ACCESS_KEY=<SecretAccessKey> \
  AWS_SESSION_TOKEN=<SessionToken>
```

The role has `AdministratorAccess` attached in the member account, which is
its identity `Allow`; the resource policies are the other half. The session
can now read both, naming the secret by the ARN `describe-secret` printed,
since another account must name a secret by its ARN:

```sh
aws secretsmanager get-secret-value --secret-id <secret ARN>
aws s3api get-object --bucket shared --key hello.txt copy.txt
```

Anything the policies do not grant is still refused: a `put-object` to
`shared`, or a `get-secret-value` of another secret, fails with `... because
no resource-based policy allows the <action> action`. Detaching
`AdministratorAccess` from the role refuses the reads too, with `... because
no identity-based policy allows ...`. Some operations cannot be granted to
another account at all, such as `ListSecrets`, `CreateSecret`,
`CreateBucket`, and queues' `CreateQueue` and `SetQueueAttributes`; each
service's page lists them.

## What is shared

There is no per-account data isolation: each service's resources belong to
its own account, `000000000000` by default, identity's default management
account. Within that account, every accepted key sees the same data, as far
as its policies allow, and a principal of another account reaches it only
through resource policies ([Cross-account access](#cross-account-access)):

- object-store: every bucket and object, in `TULE_Auth_AccountID`;
- secret-store: every secret, in `TULE_Store_AccountID`;
- accounts: the one organization. A member account's principal may call
  `DescribeOrganization` only, as accounts serves no resource policy;
- mailbox: every stored message, in `TULE_Mailbox_AccountID`;
- queues: every queue, in `TULE_Queues_AccountID`;
- functions: every function, in `TULE_Functions_AccountID`. With identity,
  each function's containers get a session of its execution role by
  default, so function code has what the role's policies allow; see
  [functions](/functions/#execution-roles).

identity itself keeps users, roles and policies per account: what a member
account's session creates belongs to that account.
