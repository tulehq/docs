---
title: policy
description: "tule.dev/policy v0.1.0: IAM policy parsing and evaluation for Go servers."
---

A Go library that parses AWS IAM policy documents and evaluates requests
against them with the logic AWS applies to identity-based policies within one
account, for the Tule services that stand in for AWS ones. It also evaluates
role trust policies for AssumeRole.

```sh
go get tule.dev/policy
```

Go 1.27.4 or later. It depends on the standard library only and has no Tule
types.

- `ParseIdentity` and `ParseTrust` parse an identity policy and a role trust
  policy, refusing what IAM refuses with its MalformedPolicyDocument wording.
  `Parse` is lenient and meant for tools, not authorization.
- `Evaluate` applies explicit deny, then allow, then implicit deny, and names
  the deciding statement.
- `TrustMatch` evaluates a trust policy for a caller, and reports whether the
  grant names the caller directly within the role's account, which decides
  whether AssumeRole also needs an identity policy.
- Malformed request values never grant and always deny.

None of the released services evaluates policies yet; see
[Identity and keys](/guides/identity/#policies).

The full semantics, their sources in the IAM User Guide, and the known gaps
are in the [README](https://github.com/tulehq/policy#readme).
