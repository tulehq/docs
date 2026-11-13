---
title: sigv4
description: "tule.dev/sigv4 v0.4.1: AWS Signature Version 4 verification for Go servers."
---

A Go library that verifies AWS Signature Version 4 on incoming requests, for
the Tule services that stand in for AWS ones.

```sh
go get tule.dev/sigv4
```

Go 1.27.4 or later. It depends on the standard library only.

- It checks the signature in the `Authorization` header and, when enabled, in
  presigned URLs, against signing keys from a `KeySource`, including the
  session tokens of temporary credentials.
- On success, `Verify` returns the request to serve, whose context carries the
  `Principal` that signed it: its account, ARN and access key, whether it is
  `Root`, its identity policy documents (opaque JSON for a policy
  evaluator), and the values of its condition keys as its `KeySource`
  supplies them: `PrincipalARN` (`aws:PrincipalArn`, a session's role ARN
  with its path), `UserID` (`aws:userid`), `Type` (`aws:PrincipalType`:
  `Account`, `User` or `AssumedRole`) and `Tags` (`aws:PrincipalTag/<key>`).
- For an `AssumedRole`, an empty `PrincipalARN` means the session's role no
  longer exists. A service must then supply `aws:PrincipalArn` to its policy
  evaluator as an empty slice, never derive it from the assumed-role `ARN`,
  and never let the session match a role ARN in a resource-based policy's
  `Principal`: a role created again under the same name is another role.
- A failure is a `*sigv4.Error` with a `Kind`, so each service answers in its
  own protocol.
- `NewStaticKey` is a `KeySource` for one long-term key; `sigv4.Chain` asks
  several in order, such as a service's root key and then identity.

```go
v, err := sigv4.New(
	keys,
	sigv4.WithRequiredSignedHeaders("host", "x-amz-date", "x-amz-target"),
	sigv4.WithErrorMap(toAPIError), // func(*sigv4.Error) error
)
verified, err := v.Verify(r)
```

It verifies the request-level signature. It does not verify the per-chunk
signatures of `aws-chunked` (`STREAMING-*`) bodies, trailing checksums, or
SigV4A.

The options, error kinds and key-source contract are in the
[README at v0.4.1](https://github.com/tulehq/sigv4/blob/v0.4.1/README.md).
Source: [github.com/tulehq/sigv4](https://github.com/tulehq/sigv4).
