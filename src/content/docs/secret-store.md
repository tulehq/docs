---
title: secret-store
description: "secret-store 0.6.0: a local stand-in for Secrets Manager."
---

An AWS Secrets Manager-compatible secret store that keeps secrets on the local
filesystem. It is built to stand in for Secrets Manager in local development
and end-to-end tests: point an AWS SDK at it and the usual secret, version and
staging-label calls work.

It is not a production secret store. Values are kept as plain JSON files on one
machine and nothing is encrypted. The root key has access to every secret;
the keys [identity](/identity/) issues have what their IAM policies and the
secrets' resource policies allow.

## Running it

With Docker:

```sh
docker run --rm -p 9010:9010 -v secretdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  -e TULE_Store_Seed='{"myapp/config":{"Database":{"Host":"db.internal"}}}' \
  ghcr.io/tulehq/secret-store:0.6.0
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
| `TULE_Store_AccountID` | `000000000000` | Account in the ARNs the store mints, and the account every secret belongs to |
| `TULE_Store_Seed` | unset | JSON object of secret name to value, created at startup if missing |
| `TULE_Store_FunctionsEndpoint` | unset | The [functions](/functions/) service's base URL, such as `http://localhost:9060`, to serve `RotateSecret` and `CancelRotateSecret` by invoking rotation functions there ([Rotation](#rotation)). Unset, both answer `501` |
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
on localhost. It also refuses an identity or functions endpoint that is not an
`http` or `https` URL.

### The functions endpoint

The setting is in the `Store` section, this service's own, as every Tule
service names the services it calls in its own section; only identity's
endpoint is under `Auth`. With `TULE_Store_FunctionsEndpoint` set, rotation
functions are invoked through the functions service's
[service invoke endpoint](/functions/#the-service-invoke-endpoint)
(functions v0.5.0 or later), with its client
`tule.dev/functions/serviceinvoke`. The calls are signed with
`TULE_Auth_AccessKeyID` and `TULE_Auth_SecretAccessKey`, which that endpoint
accepts only as the root user of its account: functions' own configured key,
or, when both services use identity, identity's root key. Configure the two
services with the same key, as for identity. A call has no timeout of its
own below 16 minutes, since a step runs as long as the function, up to its
900-second limit.

Set, it needs a fixed `TULE_Server_Port`: the server refuses to start with
port `0` (see [Restarts](#restarts)).

Unset, `RotateSecret` and `CancelRotateSecret` answer `501
NotImplementedException` to every caller, without evaluating any policy;
nothing is scheduled, and a rotation a previous run left in progress waits,
untouched, until the server runs with an endpoint again.

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

identity v0.5.0 or later is required: the service asks the signing-key
endpoint for each principal's policies and attributes (a session's role ARN
with its path, the unique ID, the principal type, the tags and the
organization keys), and with an older identity every request signed with one
of its keys fails with `InternalServiceError`. It also binds the resource
policies the store saves through identity's principal-ID endpoint (see
[Unique IDs in resource policies](#unique-ids-in-resource-policies)).

### IAM policies

Every request signed with a key identity issued, an IAM user's or a role
session's, is evaluated against that principal's identity-based policies
(inline and attached managed, a session carrying its role's) and the
resource policy of the secret it acts on, together, with
[tule.dev/policy](/policy/)'s `Authorize` and AWS's logic (see
[Resource policies](#resource-policies)). The root key, the root of
`TULE_Store_AccountID`, is never evaluated, so without
`TULE_Auth_IdentityEndpoint` nothing is. A root principal identity reports
for another account is evaluated like any principal of that account.

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

or, by the reason, `... with an explicit deny in an identity-based policy`,
`... with an explicit deny in a resource-based policy` or `... because no
resource-based policy allows the <action> action`. When both kinds deny, the
identity-based one is named.

### Resource policies

A secret's resource policy is attached with `PutResourcePolicy`, read with
`GetResourcePolicy`, removed with `DeleteResourcePolicy` and checked with
`ValidateResourcePolicy`. It is stored with the secret and read under the
same lock, so the policy a check evaluates is always the one stored for the
secret acted on. It is evaluated with the caller's identity policies as AWS
evaluates them:

- An explicit `Deny` in either kind of policy denies.
- **Same account:** an `Allow` in either allows. A resource policy that
  names the principal directly (its user ARN, its role's ARN with the path,
  which reaches the role's sessions, its session ARN, or `"*"`) is enough
  without any identity policy. One that names only the account
  (`000000000000` or `arn:aws:iam::000000000000:root`) also needs the
  principal's identity `Allow`.
- **Another account:** both an identity `Allow` and a resource-policy
  `Allow` naming it, directly or through its account, are needed. Another
  account's root user needs only the resource-policy grant. `ListSecrets`
  and `CreateSecret` act on the store's own account, which no resource
  policy covers, so they are denied to other accounts. Another account must
  name a secret by its ARN, as Secrets Manager requires: a name is read in
  the caller's own account, where the store holds no secret, and answers
  `ResourceNotFoundException` when the caller's identity policies allow it.
  Cross-account `BatchGetSecretValue` is served, each secret named by ARN
  and evaluated with its own policy. The
  [cross-account walkthrough](/guides/identity/#cross-account-access) shows
  one end to end.
- **`GetRandomPassword` is evaluated as the caller's own:** it acts on no
  secret and reads nothing of the store's, so another account's principal
  needs only its identity `Allow`.
- A session whose role was deleted is denied everything.
- A stored policy that no longer parses fails every evaluated request on its
  secret with `InternalServiceError`; the root key still reaches the secret
  and can replace or delete the policy.

#### Unique IDs in resource policies

With `TULE_Auth_IdentityEndpoint` set, a policy is bound as AWS binds it when
it is saved: each IAM user or role ARN in its `Principal` (and
`NotPrincipal`) is replaced by that user's or role's unique ID (`AIDA...`,
`AROA...`), through identity's principal-ID endpoint, so a user or role
deleted and created again under the same ARN is another principal, which the
policy does not name. The bound policy is what is stored and evaluated;
evaluation never asks identity. `GetResourcePolicy` shows it as AWS does: an
ID whose user or role still exists as that principal's current ARN, and one
whose principal is gone as the ID. The bound policy is held to the same
20,480 characters as the one sent, `ValidationException` otherwise.

- Account IDs, root ARNs, assumed-role session ARNs, `"*"`, service
  principals and ARNs in conditions, such as `aws:PrincipalArn`, are not
  bound, as AWS does not convert them.
- A user or role ARN that no user or role has is refused with
  `MalformedPolicyDocumentException`, `Invalid principal in policy`, by
  `PutResourcePolicy`, and nothing is stored. The principals are looked up
  only once the request is allowed on the secret, so a caller not allowed
  the action learns nothing of which users and roles exist.
- `ValidateResourcePolicy` does not look principals up, and passes a policy
  naming a user or role that does not exist, since without a `SecretId` it
  is evaluated in the caller's own account and the check would let a caller
  of any account learn which users and roles exist.
- Failing to reach identity fails the call with `InternalServiceError`: a
  write is never stored unbound, and a read never shows the stored IDs in
  place of the ARNs.
- Without `TULE_Auth_IdentityEndpoint` there are no unique IDs: a policy is
  stored and returned as it was sent, matched by ARN.
- A policy stored by v0.4.0 or earlier is not bound until it is saved again.

A secret scheduled for deletion keeps its policy, and only a purge
(`ForceDeleteWithoutRecovery`) removes it. A secret has one policy, named
`default`. A `ResourcePolicy` must be 1 to 20,480 characters, and a document
that is not a valid resource-based policy as tule.dev/policy's
`ParseResource` reads one is `MalformedPolicyDocumentException` with the
parser's message and is never stored. With identity, a user or role ARN no
user or role has is `MalformedPolicyDocumentException` too on
`PutResourcePolicy`, checked only after the request is allowed.

With `BlockPublicPolicy` set, a policy that grants broad access is refused
with `PublicPolicyException`. AWS documents no exact rule for this, so the
service applies the one AWS documents for S3 bucket policies: an `Allow`
whose `Principal` is `"*"` is broad unless its `Condition` fixes, with a
positive operator and values holding no wildcard or policy variable, one of
`aws:PrincipalArn`, `aws:PrincipalAccount`, `aws:PrincipalOrgID`,
`aws:userid`, `aws:SourceArn`, `aws:SourceVpc`, `aws:SourceVpce`,
`aws:SourceOwner`, `aws:SourceAccount`, or `aws:SourceIp` with ranges no
broader than a `/8` (IPv4) or `/32` (IPv6). Locally that last rule is weak:
every caller of a store on a developer's machine connects from loopback, so
`"Principal": "*"` with `aws:SourceIp` `127.0.0.0/8` is not refused as
public, yet reaches every principal of every account. `ValidateResourcePolicy`
reports the same finding as `PolicyValidationPassed: false` with a
`BROAD_ACCESS` entry in `ValidationErrors`, a name of the service's own; it
does not check that the policy locks out the caller.

### Actions and condition keys

| Operation | Actions | Resource |
|---|---|---|
| `CreateSecret` | `secretsmanager:CreateSecret`, and `secretsmanager:TagResource` when the request has `Tags` | the new secret's ARN, suffix included |
| `BatchGetSecretValue` | `secretsmanager:BatchGetSecretValue`, then `secretsmanager:GetSecretValue` for each secret | `*`, then each secret |
| `ListSecrets` | `secretsmanager:ListSecrets` | `*` |
| `GetRandomPassword` | `secretsmanager:GetRandomPassword` | `*` |
| `RotateSecret` | `secretsmanager:RotateSecret`, then `lambda:InvokeFunction` | the secret, then the rotation function (see [Rotation](#permissions-for-rotation)) |
| every other operation | `secretsmanager:<Operation>` | the secret |

A secret is evaluated on its full ARN, rebuilt from this store's region and
account, never on the string the request gave. A secret that does not exist
is evaluated on `arn:aws:secretsmanager:<region>:<account>:secret:<name>`, so
a caller that may not touch it is denied rather than told it is missing. In
`BatchGetSecretValue` a secret the caller may not read is reported in
`Errors` and the others are returned.

The condition keys supplied are the global `aws:SourceIp`,
`aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`,
`aws:RequestedRegion` (`TULE_Store_Region`), `aws:PrincipalTag/<key>` for
each of the principal's tags (a user's own, or a session's role's),
`aws:PrincipalOrgID` and `aws:PrincipalOrgPaths` (for an account that is a
member or the management account of the organization), and
`aws:PrincipalAccount`, `aws:PrincipalArn` (for a role session its role's
ARN with its path), `aws:userid`, `aws:PrincipalType`, for a user
`aws:username`, and `aws:PrincipalIsAWSService` as `false`; with an action
on a secret, `secretsmanager:SecretId`, `secretsmanager:SecretPrimaryRegion`,
its tags as `aws:ResourceTag/<key>` and `secretsmanager:ResourceTag/<key>`
and, for a secret with a rotation
function stored, that function's ARN as
`secretsmanager:resource/AllowRotationLambdaArn`; and per operation keys
such as `secretsmanager:Name`, `secretsmanager:VersionStage`,
`aws:RequestTag/<key>`, `aws:TagKeys`, `secretsmanager:PolicyName`,
`secretsmanager:BlockPublicPolicy`, and `secretsmanager:RotationLambdaARN`,
`secretsmanager:RotateImmediately` and `secretsmanager:ModifyRotationRules`
on `RotateSecret`, listed in the README. Tag keys
that repeat, or differ only by case for an evaluated principal, are refused
with `InvalidParameterException`. Policies are fetched from identity on every
request, so a change applies on the next one.

When identity reports that it could not ask the accounts service for a
principal's organization, `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths`
are evaluated as unknown, never as absent: a condition on them never holds
in an `Allow` and always holds in a `Deny`, whatever its operator. Identity
keeps an account's organization keys for up to 30 seconds, so an account
removed or moved keeps its old keys that long.

Not enforced: binding for policies stored without identity, or by v0.4.0 or
earlier until they are saved again, whose user and role principals are
matched by ARN; a policy naming a unique ID is stored as it is, and matches
no one once its principal is gone; service principals, which never match,
since a rotation function calls secret-store as its execution role's
session, not as Secrets Manager; the KMS, managed external secret and
replication keys; permissions boundaries, session policies, SCPs and RCPs;
and the check that a tag change leaves the caller its access.

**Changes from v0.5.0:** `RotateSecret` and `CancelRotateSecret` are served
when `TULE_Store_FunctionsEndpoint` names a functions service v0.5.0 or
later ([Rotation](#rotation)); without it they still answer `501`. The
caller of `RotateSecret` also needs `lambda:InvokeFunction` on the rotation
function, and the function's policy must allow
`secretsmanager.amazonaws.com` to invoke it. `GetRandomPassword` is served,
authorized as `secretsmanager:GetRandomPassword` on `*`.
`aws:PrincipalIsAWSService` is `false` for every evaluated principal, where
v0.5.0 left it absent, so a `Bool` `Deny` on it being `false` now applies,
and `aws:PrincipalServiceName` is absent whatever the request carries.
`secretsmanager:resource/AllowRotationLambdaArn` is supplied on every
secret action of a secret with a rotation function stored.

**Changes from v0.4.0:** identity v0.5.0 is required. Resource policies are
bound to unique IDs when identity is configured, so a `PutResourcePolicy`
naming a user or role ARN that no user or role has, which v0.4.0 accepted,
is now refused with `MalformedPolicyDocumentException`, and a user or role
deleted and created again under the same ARN no longer inherits what the
policy granted. Policies stored by v0.4.0 are not bound, and keep matching
by ARN until saved again with `PutResourcePolicy`; nothing binds them on its
own, so to bind every stored policy, read each with `GetResourcePolicy` and
put it back. `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths` are supplied,
so a positive condition on them can now hold, and a `Deny` with a negated
operator on them no longer denies every evaluated principal.

**Changes from v0.3.0:** identity v0.4.0 is required. A principal of another
account was denied every operation; it is now allowed what its identity
policies and the secret's resource policy both grant. `aws:PrincipalArn`
carries a role's path, so a condition on a role ARN with its path now
matches the role's sessions, and one on the path-less ARN of a role that has
a path no longer does. The resource-policy operations are served, where they
answered `501`.

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
| `PutResourcePolicy` | Attaches the secret's one policy, `default`, replacing any |
| `GetResourcePolicy` | Without a policy, answers the secret's `ARN` and `Name` only |
| `DeleteResourcePolicy` | Succeeds whether or not the secret has a policy |
| `ValidateResourcePolicy` | Checks syntax and broad access without storing; `SecretId` optional |
| `GetRandomPassword` | Draws from `crypto/rand`; every option the API reference lists; see below |
| `RotateSecret` | With a functions endpoint: configures rotation and rotates through a rotation function, in the background; see [Rotation](#rotation) |
| `CancelRotateSecret` | With a functions endpoint: turns rotation off and stops a rotation in progress; see [Rotation](#rotation) |

A secret is addressable by name, by its full ARN, or by its ARN without the
random suffix, as Secrets Manager allows. An ARN whose last segment ends in
a hyphen and six characters is always read as a full ARN, as Secrets
Manager's troubleshooting guide describes, so use the name or the full ARN
of a secret whose name ends that way. Both string and binary values round
trip, and a read reports back whichever kind was written. A value is capped at
65536 bytes, as on AWS, so a secret that is accepted here is accepted there.

`GetRandomPassword` follows the API reference: `PasswordLength` defaults to
32 and must be 1 to 4096, and `ExcludeCharacters` may be up to 4,096
characters, else `ValidationException`. A password draws on uppercase and
lowercase letters, digits and the punctuation
``! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~``, less
what `ExcludeUppercase`, `ExcludeLowercase`, `ExcludeNumbers`,
`ExcludePunctuation` and `ExcludeCharacters` remove, and on the space only
with `IncludeSpace`. `RequireEachIncludedType` defaults to true and then
puts at least one of each included type in the password. Each character is
chosen uniformly from its alphabet. Options that leave no character, or a
`PasswordLength` shorter than the number of required types, are
`InvalidParameterException`. A type whose every character
`ExcludeCharacters` removes is no longer included, so it is not required,
and the space is never a required type.

`ClientRequestToken` works as an idempotency token on `CreateSecret`,
`PutSecretValue` and `UpdateSecret`: reusing one with the same value returns
the version already stored, and reusing one with a different value is a
`ResourceExistsException`.

## Rotation

With `TULE_Store_FunctionsEndpoint` set
([The functions endpoint](#the-functions-endpoint)), `RotateSecret` and
`CancelRotateSecret` are served with Lambda rotation: secret-store invokes a
rotation function, a function of that [functions](/functions/) service, as
Secrets Manager invokes one. Managed rotation and managed external secrets
are not served: a request with `ExternalSecretRotationRoleArn` or
`ExternalSecretRotationMetadata` is refused with
`InvalidParameterException`.

### Turning rotation on

`RotateSecret` takes these members:

- **`RotationLambdaARN`**, the rotation function, up to 2048 characters. It
  must be a Lambda function's ARN,
  `arn:aws:lambda:<region>:<account>:function:<name>`, with or without a
  version or alias, else `InvalidParameterException`, and of the functions
  service's own account and region, or every invocation of it fails as of a
  function that does not exist. Left out, the function stored for the
  secret is used, and a secret with none is refused with
  `InvalidRequestException`, `No Lambda rotation function ARN is associated
  with this secret.`
- **`RotationRules`**: `AutomaticallyAfterDays`, 1 to 1000, or
  `ScheduleExpression`, but not both, and `Duration`, such as `3h`. A value
  outside the model's range, length or pattern is `ValidationException`; a
  schedule the User Guide's rules refuse is `InvalidParameterException`
  (see [Schedules](#schedules)). Rules given replace the stored ones whole;
  left out, the stored ones stay. A secret may have rotation on without any
  rules: it then rotates only when asked.
- **`RotateImmediately`**, `true` when left out: the rotation starts now.
  With `false`, the rotation configuration is tested by invoking
  `testSecret` once, not retried, on the empty `AWSPENDING` version
  `RotateSecret` creates, and `AWSPENDING` is taken off that version however
  the step ended. A function whose `testSecret` reads the pending value, as
  the database templates' do, fails the test, which is logged as a failed
  rotation and changes nothing else.
- **`ClientRequestToken`**, 32 to 64 characters: the ID of the version the
  rotation creates, and the `VersionId` `RotateSecret` answers. The SDKs
  fill one in; a request without one gets a generated UUID.

`RotateSecret` turns rotation on (`RotationEnabled` true), stores the
function and the rules, creates the version the rotation rotates to,
holding `AWSPENDING` and no value, and answers `ARN`, `Name` and `VersionId`
at once. The rotation runs in the background. A version without a value
answers `GetSecretValue` with `ResourceNotFoundException`, which is what the
rotation function templates expect when `createSecret` first looks for it,
and a `PutSecretValue` whose `ClientRequestToken` is its ID stores the value
in it, keeping its labels. It is listed in `VersionIdsToStages` and by
`ListSecretVersionIds`, which the templates check before every step.

**A rotation in progress.** A `RotateSecret` on a secret whose `AWSPENDING`
is on a version other than `AWSCURRENT`'s, or on one a rotation is running
on, is refused with `InvalidRequestException`, `A previous rotation isn't
complete. That rotation will be reattempted.` A `ClientRequestToken` that is
the running rotation's, or the `AWSCURRENT` version's, repeats a request
already served, as an SDK retry does, and answers that version without
starting anything; one that is the `AWSPENDING` version's starts that
rotation again, to that version. A token that names any other existing
version is `ResourceExistsException`. A secret scheduled for deletion is
`InvalidRequestException`.

### How a rotation runs

A rotation invokes the function once for each step, in order:
`createSecret`, `setSecret`, `testSecret` and `finishSecret`. Each
invocation is synchronous, a `RequestResponse` one, and the next step is
invoked only once it has returned. Each step's event is

```json
{"Step": "createSecret", "SecretId": "<the secret's ARN>", "ClientRequestToken": "<the AWSPENDING version's ID>"}
```

with the step names the rotation function templates compare `Step` with.
`RotationToken` is not sent, and `PutSecretValue` ignores it.

Each invocation goes through the functions service's service invoke
endpoint, as the service principal `secretsmanager.amazonaws.com`, with the
secret's ARN as `SourceArn` and `TULE_Store_AccountID` as `SourceAccount`.
functions evaluates the function policy for that principal, with the two as
`aws:SourceArn` and `aws:SourceAccount`, and runs the invocation as `Invoke`
runs one; its history records it with the source `service`.

A step fails when its invocation is refused (the function policy does not
allow it, there is no such function, the function is not active or is at
its container cap), cannot be made (functions does not answer), or the
function returns an error. Once `finishSecret` has returned, the rotation
has succeeded only if `AWSCURRENT` is on the rotation's version; otherwise
the attempt failed. A success records `LastRotatedDate` and leaves
`AWSPENDING` where the function left it.

Before each step the rotation checks that it is still the secret's, so one
that `CancelRotateSecret` or `DeleteSecret` ended invokes no further step. A
step already running is not stopped in the function: its invocation is
abandoned, and the function runs on to its end.

### The function policy

As on AWS, the function policy must allow Secrets Manager to invoke the
function. The User Guide's command, against functions:

```sh
aws --endpoint-url http://localhost:9060 lambda add-permission \
  --function-name my-rotation-function \
  --action lambda:InvokeFunction \
  --statement-id SecretsManager \
  --principal secretsmanager.amazonaws.com \
  --source-account 000000000000
```

`--source-arn` with the secret's ARN narrows it to that secret. A function
whose policy does not allow `secretsmanager.amazonaws.com`, or allows it
only for another `SourceArn` or `SourceAccount`, is never run: each
attempt's first invocation is refused, and the rotation fails.

### The execution role

The function runs with its execution role when functions gives its
containers role sessions (`TULE_Functions_FunctionCredentials=role`, its
default with identity; see [Execution roles](/functions/#execution-roles)),
and its calls to secret-store are signed with that session and evaluated
against the role's policies like any principal's. The role needs what the
User Guide gives a rotation function's execution role, less the EC2 actions
a function in a VPC needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecretVersionStage"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:000000000000:secret:myapp/db-??????"
    },
    {"Effect": "Allow", "Action": "secretsmanager:GetRandomPassword", "Resource": "*"}
  ]
}
```

and a trust policy that lets `lambda.amazonaws.com` assume it. The function
reaches secret-store through the Docker host: set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=http://host.docker.internal:9010` in its
`Environment` (see
[Calling Tule services from a function](/functions/#calling-tule-services-from-a-function)),
and run secret-store where the containers can reach that port. Without
identity, functions gives the containers its configured key, the root key,
which may do everything.

### Permissions for rotation

- **`RotateSecret`** is evaluated as `secretsmanager:RotateSecret` on the
  secret, with the secret's keys and the three rotation keys, and then, once
  that is allowed, as `lambda:InvokeFunction` on the rotation function: the
  request's `RotationLambdaARN`, or the secret's stored function when it
  names none. `lambda:InvokeFunction` is evaluated on the caller's identity
  policies alone, on the function's ARN as a resource of the account in it;
  the function policy is the functions service's, and is not read here. A
  caller of the function's own account therefore needs an identity `Allow`,
  and a caller of another account is always denied it. `iam:PassRole` is
  never evaluated, since `ExternalSecretRotationRoleArn` is refused. The
  root key is not evaluated.
- **`CancelRotateSecret`** is evaluated as
  `secretsmanager:CancelRotateSecret` on the secret.
- **Rotations the schedule starts, and retries**, are the service's own, and
  nothing is evaluated for them in secret-store; the function policy is
  still evaluated by functions for every invocation.
- **The function's calls** are evaluated against its execution role, as
  above.

### Schedules

The rules follow the User Guide's "Rotation schedules", in UTC:

- **`AutomaticallyAfterDays` N, and `rate(N days)`** (or `day`), N up to 999
  for a rate: the window is the UTC day N days after the last rotation,
  from midnight.
- **`rate(N hours)`** (or `hour`): windows every N hours from midnight,
  resetting each UTC day, which is `cron(0 0/N * * ? *)`. N under 4 is
  refused, and so is N of 24 or more, with a hint to write the rate in days.
- **`cron(Minutes Hours Day-of-month Month Day-of-week Year)`**, as the User
  Guide's table allows: Minutes `0`, Year `*`; Hours an hour from 0 to 23 or
  an increment, `2/10` or `/8`, of at least 4; Day-of-month 1 to 31 with
  `, - * ? /` and `L`; Month 1 to 12 or `JAN` to `DEC` with `, - * /`;
  Day-of-week 1 (`SUN`) to 7 (`SAT`) with `, - * ? /`, `L`, `<day>#<n>` and
  `<day>L`. Exactly one of the two day fields is `?`. An expression no date
  matches, such as the 31st of February, is refused. The window is the
  first match after the last rotation.
- **`Duration`**, 1 to 24 hours. Left out, the window lasts an hour for a
  schedule in hours, one with more than one window a day, and to the end of
  the UTC day for a schedule in days. A window that would reach into the
  next UTC day or the next window is refused.

The last rotation the next window counts from is the latest of: the last
rotation that succeeded; the creation of the `AWSCURRENT` version, so that
a value stored by hand with `PutSecretValue` or `UpdateSecret` counts as
one; and the time rotation was turned on. A failed rotation does not move
it, so `NextRotationDate` stays where the failed window was, in the past.
The scheduler does not start that window again: it next rotates in the
first window that starts after the failure. Changing the rules of a secret
whose rotation is on does not reset it, so the new schedule counts from the
last rotation.

A scheduled rotation starts when its window opens, within the scheduler's
one-minute check. `NextRotationDate` is the end of the next window. A
window that passed while the server was down is rotated once, at the first
check, and not retried. A scheduled rotation of a secret whose `AWSPENDING`
version a failed rotation left apart from `AWSCURRENT` rotates to that
version again.

### Failures and retries

A rotation is tried three times, a minute apart, each attempt from
`createSecret`, with the same version, as the templates' steps are written
to be repeated. A scheduled rotation is not retried past the end of its
window. The numbers are this service's; AWS gives none.

After the last attempt the rotation is over and has failed: `AWSCURRENT` is
where it was, the rotation's version keeps `AWSPENDING`, empty if
`createSecret` never stored a value, and `LastRotatedDate` is unchanged.
Each failed attempt is logged as a warning and the end of the rotation as an
error, with the step and the function's error; CloudTrail events are not
modelled. Until `AWSPENDING` comes off that version
(`UpdateSecretVersionStage` with `RemoveFromVersionId`), a `RotateSecret`
with another token is refused as above, one with that version's token
rotates to it again, and so does the next scheduled window.

### Restarts

A secret's rotation configuration, its dates and the rotation running on it
are kept in the secret's own file. A shutdown cancels the invocation in
flight, which the function finishes on its own, waits for the rotations to
stop, and leaves each as it was recorded. When the server starts with a
functions endpoint, every rotation it finds is resumed, from `createSecret`,
at the attempt it was at, after its retry wait if it was in one; an attempt
a shutdown interrupted does not count as failed. No rotation, resumed or
new, invokes its function before the server listens: the rotation service
dials the configured `TULE_Server_Host` and `TULE_Server_Port` until a
connection is accepted, and only then invokes anything, logging a warning
naming the address while it waits longer than 5 seconds, and again every 30
seconds. That is why `TULE_Server_Port=0` is refused at startup when
`TULE_Store_FunctionsEndpoint` is set. So a restart never leaves a secret in
progress for good: every rotation ends after its attempts. Started without a
functions endpoint, the server leaves the recorded rotations as they are,
for a later start with one. Files written before rotation was served load
unchanged.

### CancelRotateSecret

`CancelRotateSecret` turns off automatic rotation and, if a rotation is in
progress, cancels it: `RotationEnabled` becomes false and a running rotation
invokes no further step. The function and the rules stay, and are still
reported; `LastRotatedDate` and `NextRotationDate` are no longer reported.
The rotation's version keeps `AWSPENDING`, as AWS leaves it, and its ID is
the `VersionId` the call answers whenever `AWSPENDING` is on a version that
is not `AWSCURRENT`; otherwise the call answers `ARN` and `Name` alone. A
secret never configured for rotation is left as it is. `RotateSecret` turns
rotation on again. `DeleteSecret` also ends a rotation in progress,
abandoning the step in flight as a cancel does, and a secret scheduled for
deletion is never rotated; a rotation after `RestoreSecret` is a new one.

### DescribeSecret and ListSecrets

Both report `RotationEnabled`, left out for a secret never configured for
rotation; `RotationLambdaARN`; `RotationRules`, as `RotateSecret` set them;
and, while rotation is on, `LastRotatedDate`, once a rotation has
succeeded, and `NextRotationDate`, for a secret with rules. The rules are
reported as they were set, never with an `AutomaticallyAfterDays` worked
out from a `ScheduleExpression`.

## Differences from AWS

- **Nothing is encrypted.** Each secret is one JSON file under
  `TULE_Store_RootDir`, named after a hash of the secret's name, holding its
  metadata and every version of its value in the clear.
- **One account's secrets.** Every secret belongs to `TULE_Store_AccountID`,
  and a principal of another account reaches one only through its resource
  policy (see [Resource policies](#resource-policies)). Identity-based and
  resource-based policies are enforced.
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
- **No replication.** These return `501 NotImplemented` with a
  `NotImplementedException`: `ReplicateSecretToRegions`,
  `RemoveRegionsFromReplication` and `StopReplicationToReplica`. So do
  `RotateSecret` and `CancelRotateSecret` without a functions endpoint (see
  [Rotation](#rotation)). A target that names no Secrets Manager operation
  gets `UnknownOperationException`.
- **Lambda rotation only, through functions.** Rotation functions are
  functions of the Tule functions service, invoked through its service
  invoke endpoint; managed rotation and managed external secrets are not
  served. Where AWS leaves rotation open (how steps are invoked, how often
  and when a failed rotation is retried, when in its window a scheduled
  rotation runs, what a restart does), [Rotation](#rotation) says what this
  service does.
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
[v0.6.0](https://github.com/tulehq/secret-store/blob/v0.6.0/README.md), released as
`ghcr.io/tulehq/secret-store:0.6.0`. Its Go module is `tule.dev/secret-store`, with the
source at [github.com/tulehq/secret-store](https://github.com/tulehq/secret-store).
