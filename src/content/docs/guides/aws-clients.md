---
title: AWS SDKs and the CLI
description: Point AWS SDKs and the AWS CLI at Tule with per-service endpoint variables, credentials and a region.
---

Tule services speak the AWS APIs they replace, so an AWS SDK or the AWS CLI
reaches them by changing only the endpoint, the credentials and the region.

## Endpoints

The AWS SDKs and the AWS CLI read a per-service endpoint from
`AWS_ENDPOINT_URL_<SERVICE>`, where `<SERVICE>` is the service's SDK ID in
upper case with spaces as underscores (the AWS SDK reference guide's
[service-specific endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html)).
`AWS_ENDPOINT_URL` sets one endpoint for every service, which does not suit
Tule, where each service has its own port.

```sh
export AWS_ENDPOINT_URL_S3=http://localhost:9000
export AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:9010
export AWS_ENDPOINT_URL_ORGANIZATIONS=http://localhost:9020
export AWS_ENDPOINT_URL_IAM=http://localhost:9030
export AWS_ENDPOINT_URL_STS=http://localhost:9030
export AWS_ENDPOINT_URL_SESV2=http://localhost:9040
export AWS_ENDPOINT_URL_SQS=http://localhost:9050
export AWS_ENDPOINT_URL_LAMBDA=http://localhost:9060
```

| Variable | Service | Tule service |
|---|---|---|
| `AWS_ENDPOINT_URL_S3` | S3 | [object-store](/object-store/) |
| `AWS_ENDPOINT_URL_SECRETS_MANAGER` | Secrets Manager | [secret-store](/secret-store/) |
| `AWS_ENDPOINT_URL_ORGANIZATIONS` | Organizations | [accounts](/accounts/) |
| `AWS_ENDPOINT_URL_IAM` | IAM | [identity](/identity/) |
| `AWS_ENDPOINT_URL_STS` | STS | [identity](/identity/), the same URL as IAM |
| `AWS_ENDPOINT_URL_SESV2` | SES v2 | [mailbox](/mailbox/) |
| `AWS_ENDPOINT_URL_SQS` | SQS | [queues](/queues/) |
| `AWS_ENDPOINT_URL_LAMBDA` | Lambda | [functions](/functions/) |

mailbox serves SES v2. SES v2 clients (Go's `sesv2`, JavaScript's
`SESv2Client`, `aws sesv2`) read `AWS_ENDPOINT_URL_SESV2`;
`AWS_ENDPOINT_URL_SES` is the SES v1 clients', and mailbox does not serve the
SES v1 API.

A single command can also take `--endpoint-url`:

```sh
aws --endpoint-url http://localhost:9060 lambda list-functions
```

## Credentials

Sign with a key the service accepts: its configured key, or, when it is
pointed at identity, a key identity issued. See
[Identity and keys](/guides/identity/).

```sh
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# For a role session from AssumeRole, also:
export AWS_SESSION_TOKEN=...
```

A session token is accepted only on a key identity issued. A service's
configured key is long-term, so a request that carries a token on it is
refused.

## Region

Use `us-east-1`:

```sh
export AWS_REGION=us-east-1
```

identity asks clients to sign for `us-east-1`. The other services do not check
the credential's region, so any region verifies; the ARNs they mint carry their
own configured region (`TULE_Store_Region`, `TULE_Queues_Region`,
`TULE_Functions_Region`, `us-east-1` by default). S3 buckets report
`us-east-1`.

## In code

Each service page shows a Go and a JavaScript client. The pattern is the same
everywhere, here for S3 with Go (AWS SDK v2):

```go
client := s3.New(s3.Options{
	Region:       "us-east-1",
	BaseEndpoint: aws.String("http://localhost:9000"),
	UsePathStyle: true,
	Credentials:  credentials.NewStaticCredentialsProvider("test", "test", ""),
})
```

`UsePathStyle` (`forcePathStyle` in JavaScript) is for S3 only. Path-style
addressing always works with object-store; virtual-hosted style works when the
client can resolve `<bucket>.<TULE_Server_Domain>` to the server.

## curl

curl signs requests with `--aws-sigv4`, which suits the non-AWS APIs of
mailbox, queues and functions:

```sh
curl -fsS --aws-sigv4 aws:amz:us-east-1:sqs --user test:test \
  http://localhost:9050/_queues/queues
```

curl signs the path as written, without the second URI encoding SigV4 gives
every service but S3. A path with characters other than letters, digits, `-`,
`.`, `_`, `~` and `/`, such as an email identity's `@` in an SES path, does not
verify with curl; use an SDK or the AWS CLI for those.

## From a function

Functions run in their own containers, outside the Compose network, and reach
the other services through the Docker host on their published ports. Set the
endpoint variables in the function's own `Environment`:

```sh
aws --endpoint-url http://localhost:9060 lambda update-function-configuration \
  --function-name hello --environment 'Variables={
    AWS_ENDPOINT_URL_S3=http://host.docker.internal:9000,
    AWS_ENDPOINT_URL_SQS=http://host.docker.internal:9050,
    AWS_ENDPOINT_URL_SESV2=http://host.docker.internal:9040}'
```

Every function gets the configured root key as its credentials by default; see
[functions](/functions/#calling-tule-services-from-a-function).
