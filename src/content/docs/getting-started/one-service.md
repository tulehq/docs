---
title: One service alone
description: Run a single Tule service with a static key, such as object-store for an app that only uses S3.
---

Every service runs on its own with one static access key, and needs no other
Tule service. This page uses object-store; the others work the same way, on
their own ports.

## Run object-store

```sh
docker run --rm -p 9000:9000 -v s3data:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  -e TULE_Storage_Buckets=uploads,assets \
  ghcr.io/tulehq/object-store:0.7.0
```

- `TULE_Auth_AccessKeyID` and `TULE_Auth_SecretAccessKey` are the one key the
  service accepts. They are required: the server refuses to start without
  them, and every request must be signed with them. Any web page you visit
  can send requests to a server on localhost; signatures are what stop it.
- `TULE_Storage_Buckets` creates the buckets at startup, if missing.
- The `/data` volume keeps the objects across restarts.

Check that it is ready:

```sh
curl -fsS http://localhost:9000/_ready
```

## Point the app at it

Set the endpoint, the key and a region in the app's environment:

```sh
export AWS_ENDPOINT_URL_S3=http://localhost:9000
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
```

```sh
aws s3 ls s3://uploads
```

Path-style addressing always works with object-store; set it in SDK clients
(`UsePathStyle` in Go, `forcePathStyle` in JavaScript), as shown on the
[object-store page](/object-store/#connecting-a-client). See
[AWS SDKs and the CLI](/guides/aws-clients/) for every service's variable, and
[Gas apps](/guides/gas/) for Gas's settings.

## The other services alone

```sh
docker run --rm -p 9010:9010 -v secretdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  ghcr.io/tulehq/secret-store:0.4.0

docker run --rm -p 9020:9020 -v accountsdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  ghcr.io/tulehq/accounts:0.4.0

docker run --rm -p 9030:9030 -v identitydata:/data \
  -e TULE_Auth_AccessKeyID=AKIAIOSFODNN7EXAMPLE \
  -e TULE_Auth_SecretAccessKey=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  ghcr.io/tulehq/identity:0.4.1

docker run --rm -p 9040:9040 -v mailboxdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  ghcr.io/tulehq/mailbox:0.3.0

docker run --rm -p 9050:9050 -v queuesdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  ghcr.io/tulehq/queues:0.3.0
```

functions needs the Docker socket; see [functions](/functions/#running-it).
The console needs at least one service endpoint; see [console](/console/).

A service started alone accepts only its configured key, evaluates no
policies, and never contacts identity. To also accept keys identity issues,
each held to its IAM policies, see [Identity and keys](/guides/identity/).
