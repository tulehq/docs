---
title: secret-store
description: "secret-store 0.3.0: a local stand-in for Secrets Manager."
---

An AWS Secrets Manager-compatible secret store that keeps secrets on the local
filesystem. It is built to stand in for Secrets Manager in local development
and end-to-end tests: point an AWS SDK at it and the usual secret, version and
staging-label calls work.

It is not a production secret store. Values are kept as plain JSON files on one
machine and nothing is encrypted. The root key has access to every secret;
the keys [identity](/identity/) issues have what their IAM policies allow.

## Running it

With Docker:

```sh
docker run --rm -p 9010:9010 -v secretdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  -e TULE_Store_Seed='{"myapp/config":{"Database":{"Host":"db.internal"}}}' \
  ghcr.io/tulehq/secret-store:0.3.0
```

The image is based on Alpine, so `docker exec -it <container> sh` gives you a
shell. It runs as the unprivileged `nonroot` user, and its Docker health check
polls `/_ready`.

From source (Go 1.27.4 or later):

```sh
make build
TULE_Auth_AccessKeyID=test TULE_Auth_SecretAccessKey=test ./build/tule-secret-store
```

It listens on port 9010, so it does not collide with
[object-store](/object-store/) on 9000.

## Configuration

Settings come from environment variables prefixed with `TULE_`, and from a
`.env` file in the working directory (without the prefix).

| Variable | Default | Purpose |
|---|---|---|
| `TULE_Server_Port` | `9010` | Listen port |
| `TULE_Store_RootDir` | `./data` (`/data` in the image) | Where secrets are stored |
| `TULE_Store_Region` | `us-east-1` | Region in the ARNs the store mints |
| `TULE_Store_AccountID` | `000000000000` | Account in the ARNs the store mints, and the account whose principals are accepted |
| `TULE_Store_Seed` | unset | JSON object of secret name to value, created at startup if missing |
| `TULE_HSTS_MaxAge` | unset | `Strict-Transport-Security` max age; the header is only sent when set |
| `TULE_Server_ReadTimeout` | `30s` | How long the server may take to read a request, body included |
| `TULE_Server_ReadHeaderTimeout` | `30s` | How long it may take to read a request's headers; must be positive |
| `TULE_Server_WriteTimeout` | `30s` | How long it may take to write a response |
| `TULE_Server_IdleTimeout` | `2m` | How long a keep-alive connection may sit idle between requests |
| `TULE_Server_ShutdownTimeout` | `7s` | How long a graceful shutdown waits for in-flight requests |
| `TULE_Auth_AccessKeyID` | required | The root key clients sign requests with; it must be identity's root key when `TULE_Auth_IdentityEndpoint` is set |
| `TULE_Auth_SecretAccessKey` | required | Its secret |
| `TULE_Auth_IdentityEndpoint` | unset | The [identity](/identity/) service's base URL, such as `http://localhost:9030`, to also accept the keys it issues, each request evaluated against the principal's IAM policies. Unset, only the root key is accepted |
| `TULE_GasEnv` | | `development` logs console output at trace level, `production` logs at warn level, `testing` disables logging |

The read and write timeouts are sized for a signed request body of up to 1 MiB,
which is the largest this service accepts. Logs go to the console only; there
is no log shipping.

The server refuses to start without an access key, because every request is
verified against it and any web page the developer has open can reach a server
on localhost. It also refuses an identity endpoint that is not an `http` or
`https` URL.

### Keys issued by identity

With `TULE_Auth_IdentityEndpoint` set, a request signed with any other key is
verified against identity's signing-key endpoint: its IAM users' access keys
and the session keys of the roles it lets you assume, token and all. The
root key is checked locally first, without asking identity, and it is also
what the calls to identity are signed with, so it must be identity's root
key: `TULE_Auth_AccessKeyID` and `TULE_Auth_SecretAccessKey` set to the same
values on both services.

identity is asked on every request and nothing is cached, so a key it
deactivates or deletes is refused on the next request, with
`UnrecognizedClientException`. A session token that is not the key's is
refused the same way, and an expired one with `ExpiredTokenException`. A
lookup that fails, such as identity being unreachable or not answering within
10 seconds, fails the request with `500 InternalServiceError`; it is never
treated as an unknown key or as a valid one, and the root key keeps working.

Unset, the service runs on its own exactly as without identity: only the
root key is accepted, and identity is never contacted.

identity v0.2.0 or later is required: the service asks the signing-key
endpoint for each principal's policies, and with an older identity every
request signed with one of its keys fails with `InternalServiceError`.

### IAM policies

Every request signed with a key identity issued, an IAM user's or a role
session's, is evaluated against that principal's identity-based policies
(inline and attached managed, a session carrying its role's) with
[tule.dev/policy](/policy/): an explicit `Deny` wins, then any `Allow`, and
otherwise the request is denied. The root key, the root of
`TULE_Store_AccountID`, is never evaluated, so without
`TULE_Auth_IdentityEndpoint` nothing is.

**This is a breaking change.** Before, every key identity issued could read
and write every secret. Now a key whose principal has no policy is denied
every operation. Give the IAM user or role a policy for what it does, for
example:

```json
{
  "Version": "2012-10-17",
  "Statement": {
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    "Resource": "arn:aws:secretsmanager:us-east-1:000000000000:secret:myapp/*"
  }
}
```

A denied request is `400 AccessDeniedException` with AWS's message, naming
the `SecretId` as the request gave it:

```
User: arn:aws:iam::000000000000:user/dev is not authorized to perform: secretsmanager:GetSecretValue on resource: myapp/config because no identity-based policy allows the secretsmanager:GetSecretValue action
```

**Cross-account access is refused** until resource-based policies are
enforced. A principal of another account than `TULE_Store_AccountID`, such
as a member account's `OrganizationAccountAccessRole` session, is denied
every operation, since on AWS it would also need a resource policy and every
account shares this store's secrets.

| Operation | Actions | Resource |
|---|---|---|
| `CreateSecret` | `secretsmanager:CreateSecret`, and `secretsmanager:TagResource` when the request has `Tags` | the new secret's ARN, suffix included |
| `BatchGetSecretValue` | `secretsmanager:BatchGetSecretValue`, then `secretsmanager:GetSecretValue` for each secret | `*`, then each secret |
| `ListSecrets` | `secretsmanager:ListSecrets` | `*` |
| every other operation | `secretsmanager:<Operation>` | the secret |

A secret is evaluated on its full ARN, rebuilt from this store's region and
account, never on the string the request gave. A secret that does not exist
is evaluated on `arn:aws:secretsmanager:<region>:<account>:secret:<name>`, so
a caller that may not touch it is denied rather than told it is missing. In
`BatchGetSecretValue` a secret the caller may not read is reported in
`Errors` and the others are returned.

The condition keys supplied are the global `aws:SourceIp`,
`aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`,
`aws:PrincipalAccount`, `aws:PrincipalArn`, `aws:RequestedRegion`
(`TULE_Store_Region`) and, for a user, `aws:username`; with an action on a
secret, `secretsmanager:SecretId`, `secretsmanager:SecretPrimaryRegion` and
its tags as `aws:ResourceTag/<key>`; and per operation keys such as
`secretsmanager:Name`, `secretsmanager:VersionStage`,
`aws:RequestTag/<key>` and `aws:TagKeys`, listed in the README. Tag keys
that repeat, or differ only by case for an evaluated principal, are refused
with `InvalidParameterException`. Policies are fetched from identity on every
request, so a change applies on the next one.

Not enforced: resource-based policies; the role's path in
`aws:PrincipalArn` for a session, so a condition on a role ARN with a path
does not match one; `aws:PrincipalTag/*` and `aws:userid`; the KMS, rotation
and replication keys; permissions boundaries, session policies and SCPs; and
the check that a tag change leaves the caller its access.

`TULE_Store_Seed` is read as a JSON object: each key is a secret name, and each
value becomes that secret's value, a JSON string unquoted and anything else
stored as its JSON. Seeded secrets are created before the server listens and
existing secrets are left alone, so a restart keeps whatever the app wrote.
Seeding through the environment is for local fixtures; it is not a way to hand
real secrets to a deployment.

## Health checks

`GET /_health` (liveness) and `GET /_ready` (readiness) answer without a
signature. They respond `200` when every service reports healthy or ready and
`503` otherwise, with a JSON object of each service's status. Readiness fails
when the store directory cannot be read.

Seeded secrets are created before the server listens, so once either probe
answers, they exist.

## Connecting a client

Use any region; the ARNs the store mints report `TULE_Store_Region`. Every call
is a signed `POST /` whose `X-Amz-Target` header names the operation, which is
the AWS JSON 1.1 protocol the SDKs already speak.

Go (AWS SDK v2):

```go
client := secretsmanager.New(secretsmanager.Options{
	Region:       "us-east-1",
	BaseEndpoint: aws.String("http://localhost:9010"),
	Credentials:  credentials.NewStaticCredentialsProvider("test", "test", ""),
})
```

JavaScript (AWS SDK v3):

```js
const client = new SecretsManagerClient({
  region: "us-east-1",
  endpoint: "http://localhost:9010",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

A [gas](https://github.com/gasmod/gas) app resolves its config secrets from it
with the `secretsmanager` config provider:

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

Or with `curl`, which signs requests too:

```sh
curl -fsS --aws-sigv4 aws:amz:us-east-1:secretsmanager --user test:test \
  -H 'Content-Type: application/x-amz-json-1.1' \
  -H 'X-Amz-Target: secretsmanager.GetSecretValue' \
  --data-binary '{"SecretId":"myapp/config"}' http://localhost:9010/
```

## Supported operations

| Operation | Notes |
|---|---|
| `CreateSecret` | `ClientRequestToken` becomes the first version's ID |
| `GetSecretValue` | By `VersionId` or `VersionStage`, defaulting to `AWSCURRENT` |
| `PutSecretValue` | Moves `AWSCURRENT` and `AWSPREVIOUS`, or sets the stages you ask for |
| `UpdateSecret` | Changes the description, and stores a new current version when given a value |
| `DescribeSecret` | Also answers for a secret scheduled for deletion |
| `DeleteSecret` | Schedules deletion after 7 to 30 days, or `ForceDeleteWithoutRecovery` |
| `RestoreSecret` | Cancels a scheduled deletion |
| `ListSecrets` | Paginated, in name order |
| `ListSecretVersionIds` | Paginated, newest version first |
| `UpdateSecretVersionStage` | Moves one staging label; moving `AWSCURRENT` carries `AWSPREVIOUS` to the version it left, and a label held by another version needs `RemoveFromVersionId` |
| `TagResource` / `UntagResource` | Tags are stored and reported, and reach IAM conditions as `aws:ResourceTag/<key>`; list filters on them are refused |
| `BatchGetSecretValue` | By `SecretIdList`, reporting per-secret errors |

A secret is addressable by name, by its full ARN, or by its ARN without the
random suffix, as Secrets Manager allows. An ARN whose last segment ends in
a hyphen and six characters is always read as a full ARN, as Secrets
Manager's troubleshooting guide describes, so use the name or the full ARN
of a secret whose name ends that way. Both string and binary values round
trip, and a read reports back whichever kind was written. A value is capped at
65536 bytes, as on AWS, so a secret that is accepted here is accepted there.

`ClientRequestToken` works as an idempotency token on `CreateSecret`,
`PutSecretValue` and `UpdateSecret`: reusing one with the same value returns
the version already stored, and reusing one with a different value is a
`ResourceExistsException`.

## Differences from AWS

- **Nothing is encrypted.** Each secret is one JSON file under
  `TULE_Store_RootDir`, named after a hash of the secret's name, holding its
  metadata and every version of its value in the clear.
- **One account's secrets.** There is no per-account isolation, so a
  principal of another account is refused (see [IAM policies](#iam-policies)),
  and the ARNs keep `TULE_Store_AccountID`. Identity-based policies are
  enforced; resource policies are not.
- **`KmsKeyId` is stored but does nothing.** It is kept with the secret and
  reported back by `DescribeSecret` and `ListSecrets`, so a client sees its own
  setting, and the server logs a warning naming any secret that asks for a key.
  The value beside it is still in the clear. Other request fields the service
  does not model (`AddReplicaRegions`, `ForceOverwriteReplicaSecret`,
  `RotationToken`) are ignored outright, since the AWS JSON protocol ignores
  unknown fields.
- **Ambiguous JSON bodies are refused.** A body that names a member twice,
  regardless of case, or spells a member in another case (`secretId` for
  `SecretId`) is `SerializationException`, so what a request is authorized
  on is exactly what it acts on. AWS does not document its handling of
  either.
- **No filtering or sorting.** `Filters`, `SortBy` and `SortOrder` are
  rejected with `InvalidParameterException` rather than ignored, so a filtered
  listing never looks like a filter that matched everything. List and filter
  client-side.
- **`BatchGetSecretValue` is not paginated.** It answers in one page and
  rejects a `NextToken`.
- **Scheduled deletions are never swept.** `DeleteSecret` records a deletion
  date and the secret stops answering everything but `DescribeSecret` and
  `RestoreSecret`, but nothing removes it when that date passes;
  `ForceDeleteWithoutRecovery` removes it immediately.
- **Versions are never pruned.** AWS deprecates versions beyond its per-secret
  limit; here every version a secret has ever held stays readable by its
  version ID, and `ListSecretVersionIds` reports the unlabelled ones with
  `IncludeDeprecated`.
- **`LastAccessedDate` has day granularity,** as on AWS, and is only written
  when the day changes.
- **No rotation, no replication, no resource policies.** These return
  `501 NotImplemented` with a `NotImplementedException`: `RotateSecret`,
  `CancelRotateSecret`, `GetRandomPassword`, `PutResourcePolicy`,
  `GetResourcePolicy`, `DeleteResourcePolicy`, `ValidateResourcePolicy`,
  `ReplicateSecretToRegions`, `RemoveRegionsFromReplication` and
  `StopReplicationToReplica`. A target that names no Secrets Manager
  operation gets `UnknownOperationException`.
- **Signature verification is request-level.** The method, path, query, signed
  headers and the body's hash are checked, along with the credential's access
  key, its service, which must be `secretsmanager` (its region is not
  checked), and a 15-minute clock skew. There are no presigned URLs in this
  protocol. A request body larger than 1 MiB is refused. A signature must
  cover `host`, `x-amz-date`, `x-amz-target` and every other `x-amz-*` header
  the request carries, its `SignedHeaders` must be as SigV4 specifies them
  (lowercase, sorted and unique), and it must carry a real SHA-256 of the
  body: `UNSIGNED-PAYLOAD` is rejected, since it would leave the body
  outside the signature and let a relay swap one operation's body for
  another's. The root key is a long-term one, so a request carrying a
  session token on it is refused with `UnrecognizedClientException`; session
  tokens are only accepted on the keys identity issued them for.
- **Writes are not fsynced.** Each change is written to a temporary file and
  renamed over the old one, so a reader never sees half a secret, but the data
  is only as durable as the page cache: a power loss can lose a write that was
  already acknowledged. Likewise the store assumes a single process: one lock
  inside this server serializes its own writes, and nothing coordinates two
  servers pointed at the same directory.
- **Logs record the connection's peer address.** `X-Forwarded-For` is not
  trusted, since nothing is expected in front of this service and the header
  is unsigned.
- **Stricter than AWS in one place.** Removing `AWSCURRENT` from a version
  without moving it elsewhere is refused with `InvalidParameterException`. The
  AWS documentation does not say what the real service does here, so this is a
  deliberate choice rather than a matched behaviour: a secret with no current
  version answers no ordinary read, and a client cannot put it right without a
  version ID it has no way to discover.

## Release and module

This page follows the secret-store README at
[v0.3.0](https://github.com/tulehq/secret-store/blob/v0.3.0/README.md), released as
`ghcr.io/tulehq/secret-store:0.3.0`. Its Go module is `tule.dev/secret-store`, with the
source at [github.com/tulehq/secret-store](https://github.com/tulehq/secret-store).
