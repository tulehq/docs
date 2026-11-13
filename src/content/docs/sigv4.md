---
title: sigv4
description: "tule.dev/sigv4 v0.3.0: AWS Signature Version 4 verification for Go servers."
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
  `Principal` that signed it.
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
[README at v0.3.0](https://github.com/tulehq/sigv4/blob/v0.3.0/README.md).
Source: [github.com/tulehq/sigv4](https://github.com/tulehq/sigv4).
