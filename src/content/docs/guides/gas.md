---
title: Gas apps
description: Point a Gas app's SES, SQS, S3 and Secrets Manager modules at Tule.
---

The AWS-backed modules of [Gas](https://github.com/gasmod/gas) each take an
endpoint, a region and static credentials, which is all a Tule service needs.
The settings below are from the Gas v0.9.0 modules' package documentation.

Each module uses static credentials only when both the access key ID and the
secret are set; otherwise it falls back to the AWS SDK's default chain (the
environment, the shared files, roles). For email, queue and storage, an
endpoint must be an `http` or `https` URL with a host and nothing after it but
`/`.

## Email: gas/email/ses → mailbox

`github.com/gasmod/gas/email/ses` sends with SES v2's `SendEmail`. Its settings
live in the `email` section:

| Key | Value for mailbox |
|---|---|
| `email.endpoint` | `http://localhost:9040` |
| `email.region` | `us-east-1` |
| `email.accesskeyid` | the key mailbox accepts |
| `email.secretaccesskey` | its secret |
| `email.sessiontoken` | a role session's token, when the key is one |

mailbox stores every message instead of delivering it; read it back through
the [retrieval API](/mailbox/#retrieval-api).

## Queues: gas/queue/sqs → queues

`github.com/gasmod/gas/queue/sqs` reads the `queue` section:

| Key | Value for queues |
|---|---|
| `queue.endpoint` | `http://localhost:9050` |
| `queue.region` | `us-east-1` |
| `queue.accesskeyid` | the key queues accepts |
| `queue.secretaccesskey` | its secret |
| `queue.sessiontoken` | a role session's token, when the key is one |

It takes queue names, resolved with `GetQueueUrl`, or the queue URLs queues
returns. Requests go to `queue.endpoint` whatever the host of a queue URL.

## Storage: gas/storage/s3 → object-store

`github.com/gasmod/gas/storage/s3` reads the `storage` section, for both the
store and the presigner:

| Key | Value for object-store |
|---|---|
| `storage.endpoint` | `http://localhost:9000` |
| `storage.region` | `us-east-1` |
| `storage.accesskeyid` | the key object-store accepts |
| `storage.secretaccesskey` | its secret |
| `storage.sessiontoken` | a role session's token, when the key is one |
| `storage.usepathstyle` | defaults to `true` when `endpoint` is set |
| `storage.bucket` | the default bucket; the store does not create it, so create it with `TULE_Storage_Buckets` |

## Config: gas/config/secretsmanager → secret-store

`github.com/gasmod/gas/config/secretsmanager` reads no configuration keys of
its own; its options set everything:

```go
store := config.New(
	config.WithProvider(secretsmanager.NewProvider(
		secretsmanager.WithEndpoint("http://localhost:9010"),
		secretsmanager.WithRegion("us-east-1"),
		secretsmanager.WithStaticCredentials("test", "test"),
		secretsmanager.WithSecret("myapp/config"),
		secretsmanager.WithSecretAtKey("myapp/token", "Database.Token"),
	)),
)
```

`WithSecret` merges a secret whose value is a JSON object at the root of the
configuration; `WithSecretAtKey` places a secret at a key. secret-store's
`TULE_Store_Seed` creates such secrets at startup; see
[secret-store](/secret-store/#configuration).

## Setting the keys from the environment

Gas's `config.EnvProvider` turns variable names into keys, lowercased, with
`__` between levels by default, after removing the prefix it is given. With
`config.WithEnvPrefix("APP_")`:

```sh
APP_STORAGE__ENDPOINT=http://localhost:9000
APP_STORAGE__REGION=us-east-1
APP_STORAGE__ACCESSKEYID=test
APP_STORAGE__SECRETACCESSKEY=test
```

An `http` endpoint sends the access key ID, any session token and the data in
clear text; the secret key signs requests and is not sent. Use it only for a
local service.
