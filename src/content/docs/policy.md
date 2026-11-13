---
title: policy
description: "tule.dev/policy v0.2.1: IAM policy parsing and evaluation for Go servers."
---

A Go library that parses AWS IAM policy documents and evaluates requests
against them with the logic AWS applies, for the Tule services that stand in
for AWS ones: identity-based policies within one account, role trust
policies for AssumeRole, and identity-based and resource-based policies
together, within one account and across accounts.

```sh
go get tule.dev/policy
```

Go 1.27.4 or later. It depends on the standard library only and has no Tule
types.

- `ParseIdentity` and `ParseTrust` parse an identity policy and a role trust
  policy, refusing what IAM refuses with its MalformedPolicyDocument wording.
  `Parse` is lenient and meant for tools, not authorization.
- `ParseResource` parses a resource-based policy, such as a bucket, queue,
  secret, function or email identity policy: each statement needs a
  `Principal` or `NotPrincipal` and a `Resource` or `NotResource`. An `AWS`
  principal is `"*"`, an account ID, a user or role unique ID, or a root,
  user, role, session or federated-user ARN with a blank region and a
  12-digit account; a group, a partial wildcard or a `Federated` principal
  is refused with `Invalid principal in policy`. A `Sid` may be any string
  unique in the policy, since its service sets the rule.
- `Evaluate` applies explicit deny, then allow, then implicit deny, and names
  the deciding statement.
- `TrustMatch` evaluates a trust policy for a caller, and reports whether the
  grant names the caller directly within the role's account, which decides
  whether AssumeRole also needs an identity policy.
- `Authorize` evaluates a request's identity policies and the resource's
  policy together, for a `Caller` (the account, ARN, role ARN with its path,
  unique ID and type, as [tule.dev/sigv4](/sigv4/)'s `Principal` carries
  them). An explicit deny in either wins. Within one account an Allow in
  either allows, but a resource grant that names the caller only through its
  account also needs an identity Allow. Across accounts both an identity
  Allow and a resource Allow are needed; another account's root user needs
  only the resource Allow. The result carries a `Reason` whose `Message` is
  the phrase AWS ends its AccessDenied message with, such as `because no
  resource-based policy allows the <action> action`.
- `Authorize` refuses, before reading any policy, a `Caller` whose fields
  disagree and a session whose role was deleted. The caller's
  `aws:PrincipalArn`, `aws:PrincipalAccount`, `aws:userid`,
  `aws:PrincipalType` and `aws:username` come from the `Caller`, never from
  the request context.
- Malformed request values never grant and always deny.

v0.2.0 tightened `Parse` and `ParseTrust`: an `AWS` principal ARN needs a
blank region and a 12-digit account, so a trust policy such as one naming
`arn:aws:iam:us-east-1:ACCOUNT:root` is now refused.

The known gaps include permissions boundaries, session policies, SCPs and
RCPs, which are not evaluated; matching stored principals by ARN rather than
unique ID, so a user or role recreated under the same name inherits a
grant; `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths`, which are not
supplied; and service, CanonicalUser and federated-user principals, which
match no caller.

[identity](/identity/) parses the policies it stores with it and evaluates
identity and trust policies with it, and [object-store](/object-store/),
[secret-store](/secret-store/), [accounts](/accounts/), [mailbox](/mailbox/),
[queues](/queues/) and [functions](/functions/) authorize the keys identity
issued with it, together with their own resource policies; see
[Identity and keys](/guides/identity/#policies).

The full semantics, their sources in the IAM User Guide, and the known gaps
are in the
[README at v0.2.1](https://github.com/tulehq/policy/blob/v0.2.1/README.md).
Source: [github.com/tulehq/policy](https://github.com/tulehq/policy).
