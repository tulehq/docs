---
title: object-store
description: "object-store 0.9.0: a local stand-in for S3."
---

An S3-compatible object store that keeps objects on the local filesystem. It is
built to stand in for S3 in local development and end-to-end tests: point an
AWS SDK at it and the usual bucket, object, multipart and presigned-URL calls
work.

It is not a production object store. There is one storage root on one machine,
no replication, and listings read the bucket's whole key index on every call.

## Running it

With Docker:

```sh
docker run --rm -p 9000:9000 -v s3data:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  -e TULE_Storage_Buckets=uploads,assets \
  ghcr.io/tulehq/object-store:0.9.0
```

The image is based on Alpine, so `docker exec -it <container> sh` gives you a
shell. It runs as the unprivileged `nonroot` user, and its Docker health check
polls `/_ready`.

From source (Go 1.27):

```sh
make build
TULE_Auth_AccessKeyID=test TULE_Auth_SecretAccessKey=test ./build/tule-object-store
```

It listens on port 9000.

## Configuration

Settings come from environment variables prefixed with `TULE_`, and from a
`.env` file in the working directory (without the prefix).

| Variable | Default | Purpose |
|---|---|---|
| `TULE_Server_Port` | `9000` | Listen port |
| `TULE_Storage_RootDir` | `./data` (`/data` in the image) | Where buckets and objects are stored |
| `TULE_Storage_Buckets` | unset | Comma-separated buckets to create at startup, if missing |
| `TULE_HSTS_MaxAge` | unset | `Strict-Transport-Security` max age; the header is only sent when set |
| `TULE_Server_Domain` | `localhost` | Enables virtual-hosted-style requests to `<bucket>.<domain>` |
| `TULE_Auth_AccessKeyID` | required | The access key clients sign requests with |
| `TULE_Auth_SecretAccessKey` | required | Its secret |
| `TULE_Auth_AccountID` | `000000000000` | The account the configured key and the buckets belong to: identity's management account (`TULE_Identity_AccountID`), 12 digits. Principals of other accounts need a bucket policy granting them ([below](#cross-account-access)) |
| `TULE_Auth_IdentityEndpoint` | unset | The [identity](/identity/) service's base URL, such as `http://localhost:9030`, to also accept the keys it issues and enforce their IAM policies and bucket policies ([below](#permissions)). Must be an absolute `http` or `https` URL; needs identity v0.5.0 or later |
| `TULE_GasEnv` | | `development` logs at trace level, `testing` disables logging |

The server refuses to start without credentials, and every request must be
signed with them (SigV4) or carry a presigned URL made with them. Any web page
you visit can send requests to a server on localhost; signatures are what stop
it from using this one.

Those two settings are all it needs: it runs on its own, with no IAM,
organizations or permissions. To also accept the access keys and STS
session credentials of the identity service, and enforce their IAM
policies, set `TULE_Auth_IdentityEndpoint`. The configured key must then be identity's root
key, since the server authenticates to identity's signing-key endpoint with
it. The root key is still checked locally first. Any other key is looked up
in identity on every request, so a key made inactive or deleted there is
refused on the next one with `403 InvalidAccessKeyId`. A lookup that fails,
such as identity being unreachable or not answering within 10 seconds, fails
the request with `500 InternalError`; it is never treated as an unknown key
or as a valid one.

## Permissions

Without `TULE_Auth_IdentityEndpoint` nothing is evaluated: the configured key
is the account's root and may do everything. Bucket policies can still be
set and read, but no request is evaluated against them, and they are stored
and returned as sent, their principals unbound (see
[Bucket policies](#bucket-policies)).

With it, every request signed with a key identity issued, an IAM user's
access key or a role session's credentials, is evaluated against that
principal's identity-based policies and the policy of the bucket it acts on,
together, as S3 evaluates them (tule.dev/policy's `Authorize`). The
identity-based policies are its inline policies and the default versions of
its attached managed policies, or a session's role's, as identity reports
them on each request. The configured key, identity's root key, is never
evaluated, and neither is identity's root principal of
`TULE_Auth_AccountID`; a root principal of any other account is evaluated
like that account's other principals. A presigned URL is evaluated as the
principal that signed it.

**Breaking change in v0.6.0:** up to v0.5.0 any key identity issued could do
everything. An IAM user or role with no policy that allows S3 actions, in an
identity policy or a bucket policy, is denied every request. Give it a
policy, such as one allowing `s3:*` on `*`, or attach
`arn:aws:iam::aws:policy/AdministratorAccess`; see
[Identity and keys](/guides/identity/#policies).

Every bucket belongs to `TULE_Auth_AccountID`. For a principal of that
account, an explicit `Deny` in either policy wins, and otherwise an `Allow`
in either allows. A bucket policy statement that names the principal itself
(its user ARN, its role's ARN with the path, for a session its session ARN,
or `"*"`) is enough on its own, with no identity policy; one that names only
the account (`"000000000000"` or `arn:aws:iam::000000000000:root`) delegates
to the account, so the principal also needs an identity `Allow`.

A refused request is `403 AccessDenied` with the message S3 returns, ending
with the reason, such as:

```
User: arn:aws:iam::000000000000:user/dev is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::bkt/key" because no identity-based policy allows the s3:GetObject action
User: arn:aws:iam::000000000000:user/dev is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::bkt/key" with an explicit deny in a resource-based policy
User: arn:aws:iam::111111111111:user/partner is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::bkt/key" because no resource-based policy allows the s3:GetObject action
```

When both kinds deny, the identity-based deny is named. A HEAD request's 403 has no body, as on S3, and a key DeleteObjects may not
delete gets its own `AccessDenied` entry in the result. A GetObject,
HeadObject or CopyObject of an object that does not exist answers `404
NoSuchKey` only to a caller allowed `s3:ListBucket` on the bucket, and `403
AccessDenied` naming `s3:ListBucket` to any other. A bucket name over 63
characters (`400 InvalidBucketName`) and a key over 1024 bytes (`400
KeyTooLongError`) are refused for every caller before any evaluation. An
`x-amz-expected-bucket-owner` header (or CopyObject's
`x-amz-source-expected-bucket-owner`) other than `TULE_Auth_AccountID` is
refused with `403 AccessDenied` for every caller before evaluation, and
fails a DeleteObjects as a whole rather than per key.

### Bucket generations

Each operation reads the bucket's policy once, together with the bucket's
generation, a token that is new each time the bucket is created, and then
acts only on that generation. A bucket deleted, or deleted and created
again under the same name, since the request was evaluated is answered with
`404 NoSuchBucket`. So a grant in a deleted bucket's policy never reaches a
new bucket of the same name, and an upload started in the old bucket does
not complete into, or list in, the new one; DeleteBucket removes the
bucket's uploads.

DeleteBucket answers a bucket that is not empty at once. Otherwise it waits
up to 2 seconds for operations in progress on the bucket, such as an upload,
without blocking the bucket's other requests, then gives up with `409
OperationAborted`. A bucket policy that changes while a request is in flight
may be evaluated in its previous version. A stored policy that cannot be
read or no longer parses fails every evaluated request on its bucket with
`500 InternalError`; it is never treated as absent. Buckets created by
earlier versions keep working, under one fixed generation.

### Cross-account access

A principal of another account, such as an `OrganizationAccountAccessRole`
session in a member account or a user it created, needs an `Allow` in its
own identity policies and an `Allow` in the bucket's policy, of any kind
(its ARN, its account, or `"*"`), and no `Deny` in either. Another account's
root needs only the bucket policy's `Allow`. The
[cross-account walkthrough](/guides/identity/#cross-account-access) shows
one end to end.

ListBuckets lists the caller's own account's buckets, as on S3, so another
account's principal gets an empty list. Other accounts cannot create
buckets here, since a bucket that does not exist has no policy to grant it;
CreateBucket of an existing bucket that its policy allows them answers `409
BucketAlreadyExists`. PutBucketPolicy, GetBucketPolicy and
DeleteBucketPolicy answer another account's allowed principal with `405
MethodNotAllowed`, as S3 does. Every object is evaluated as the bucket
owner's, whoever writes it, as under S3's default Object Ownership setting,
`BucketOwnerEnforced`, so a bucket policy applies to every object in its
bucket. Under the other settings an object's owner is recorded and reported
by GetObjectAcl, but not evaluated
([Object Ownership and ACLs](#object-ownership-and-acls)).

### Bucket policies

PutBucketPolicy (`PUT /<bucket>?policy`), GetBucketPolicy and
DeleteBucketPolicy take S3's request and response shapes, and each takes
`x-amz-expected-bucket-owner`.

- **PutBucketPolicy** takes the document as the body and answers `204 No
  Content`. It is evaluated before the body is read, and the policy is
  validated, and its principals bound, before the bucket is looked up. It
  refuses with `400 MalformedPolicy` a policy over 20 KB, one that is not a
  valid resource-based policy (with tule.dev/policy's message, such as
  `Invalid principal in policy`), a `Resource` that is not the bucket or an
  object in it ("Policy has invalid resource"), an `Action` that is not
  `"*"` or an `s3:` action ("Policy has invalid action"), and an IAM user or
  role ARN that no user or role has ("Invalid principal in policy"; see
  [Unique-ID principals](#unique-id-principals)); an empty body is `400
  MissingRequestBodyError`. A public policy on a bucket whose
  `BlockPublicPolicy` is on, as it is on every new bucket, is refused with
  `403 AccessDenied` ([Block Public Access](#block-public-access)).
- **GetBucketPolicy** answers `200` with the document as stored, its
  principals shown as S3 shows them (below), or `404 NoSuchBucketPolicy`.
- **DeleteBucketPolicy** answers `204 No Content`, also when the bucket had
  no policy.

They are evaluated as `s3:PutBucketPolicy`, `s3:GetBucketPolicy` and
`s3:DeleteBucketPolicy` on the bucket. The configured root key is never
evaluated, so it can always change a policy that denies everyone else.
Deleting a bucket deletes its policy, and a new bucket has none.

#### Unique-ID principals

With `TULE_Auth_IdentityEndpoint` set, a bucket policy's principals are
bound to unique IDs, as AWS binds them. PutBucketPolicy asks identity's
[principal-ID endpoint](/identity/#the-principal-id-endpoint) (identity
v0.5.0) for the unique ID (`AIDA...` or `AROA...`) of each user and role ARN
in the `AWS` values of `Principal` and `NotPrincipal`, and stores the policy
with the IDs in their place. Accounts, root ARNs, `*`, session ARNs, service
principals and ARNs in conditions, such as `aws:PrincipalArn`, are kept as
written, as AWS keeps them. The document is otherwise kept as sent.

- Requests are evaluated against the stored, bound policy, which matches a
  user or a role session by its unique ID (`aws:userid`). A user or role
  deleted and created again under the same name has a new ID, so it is not
  granted, or denied, what the policy names the old one for.
- GetBucketPolicy shows each ID that a user or role still has as its
  current ARN, and an ID no user or role has any more as the ID, as AWS
  shows it.
- An ARN no user or role has is refused, `400 MalformedPolicy`, "Invalid
  principal in policy", and nothing is stored. A policy that is over 20 KB
  once bound is refused as one sent over 20 KB is.
- When identity cannot be asked, PutBucketPolicy fails with `500
  InternalError` and stores nothing, and GetBucketPolicy fails with `500
  InternalError`; both are logged.

Standalone, without an identity endpoint, there are no users or roles to
bind: policies are stored and returned as sent, and matched by ARN.

### Actions and resources

Each operation is evaluated as the actions and resource types the
[Service Authorization Reference for S3](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html)
lists for it, on `arn:aws:s3:::<bucket>` or `arn:aws:s3:::<bucket>/<key>`:

| Operation | Action | Resource |
|---|---|---|
| ListBuckets | `s3:ListAllMyBuckets` | `*` |
| CreateBucket | `s3:CreateBucket` | bucket |
| HeadBucket | `s3:ListBucket` | bucket |
| DeleteBucket | `s3:DeleteBucket` | bucket |
| GetBucketLocation | `s3:GetBucketLocation` | bucket |
| GetBucketVersioning | `s3:GetBucketVersioning` | bucket |
| ListObjects, ListObjectsV2 | `s3:ListBucket` | bucket |
| ListMultipartUploads | `s3:ListBucketMultipartUploads` | bucket |
| GetObject, HeadObject | `s3:GetObject` | object |
| PutObject | `s3:PutObject` | object |
| CopyObject | `s3:PutObject`, then `s3:GetObject` | destination, then source object |
| DeleteObject, DeleteObjects | `s3:DeleteObject` | object, each key for DeleteObjects |
| CreateMultipartUpload, UploadPart, CompleteMultipartUpload | `s3:PutObject` | object |
| AbortMultipartUpload | `s3:AbortMultipartUpload` | object |
| ListParts | `s3:ListMultipartUploadParts` | object |
| PutBucketPolicy, GetBucketPolicy, DeleteBucketPolicy | `s3:PutBucketPolicy`, `s3:GetBucketPolicy`, `s3:DeleteBucketPolicy` | bucket |
| GetBucketPolicyStatus | `s3:GetBucketPolicyStatus` | bucket |
| PutBucketTagging, DeleteBucketTagging; GetBucketTagging | `s3:PutBucketTagging`; `s3:GetBucketTagging` | bucket |
| PutBucketCors, DeleteBucketCors; GetBucketCors | `s3:PutBucketCORS`; `s3:GetBucketCORS` | bucket |
| PutPublicAccessBlock, DeletePublicAccessBlock; GetPublicAccessBlock | `s3:PutBucketPublicAccessBlock`; `s3:GetBucketPublicAccessBlock` | bucket |
| PutBucketOwnershipControls, DeleteBucketOwnershipControls; GetBucketOwnershipControls | `s3:PutBucketOwnershipControls`; `s3:GetBucketOwnershipControls` | bucket |
| PutBucketAcl, GetBucketAcl | `s3:PutBucketAcl`, `s3:GetBucketAcl` | bucket |
| PutObjectAcl, GetObjectAcl | `s3:PutObjectAcl`, `s3:GetObjectAcl` | object |
| PutBucketEncryption, DeleteBucketEncryption; GetBucketEncryption | `s3:PutEncryptionConfiguration`; `s3:GetEncryptionConfiguration` | bucket |

A write's headers add actions on the same resource. CreateBucket with an
`x-amz-object-ownership` header also needs `s3:PutBucketOwnershipControls`,
and with an ACL (`x-amz-acl` or `x-amz-grant-*`) other than `private`
`s3:PutBucketAcl`. PutObject, CopyObject and CreateMultipartUpload with an
ACL also need `s3:PutObjectAcl`, except for the canned `private` and
`bucket-owner-full-control`, which need only `s3:PutObject`, as a bucket
with ACLs disabled accepts them. A grant header always needs
`s3:PutObjectAcl`, even one naming the owner alone. The preflight `OPTIONS`
of [CORS](#cors) is not an operation and is never evaluated.

A request for something not implemented (`501 NotImplemented`) is refused
before it is evaluated.

The global condition keys supplied are `aws:SourceIp` (the TCP peer),
`aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`,
`aws:RequestedRegion` (always `us-east-1`), and the principal's keys as
identity reports them: `aws:PrincipalArn` (a user's ARN with its path, a
session's role's ARN with the role's path), `aws:userid`,
`aws:PrincipalType`, `aws:PrincipalAccount`, for IAM users `aws:username`,
`aws:PrincipalTag/<key>` for each tag of a user or of a session's role, and
`aws:PrincipalOrgID` and `aws:PrincipalOrgPaths`. They fill policy variables
too.

`aws:PrincipalOrgID` (the organization's ID, `o-...`) and
`aws:PrincipalOrgPaths` (one path, `o-.../r-.../ou-.../`, down to the
account's parent) are supplied as identity reports them: for a principal
whose account is an `ACTIVE` member of the organization, or its management
account, and left out otherwise. Identity keeps them for 30 seconds, so an
account moved, removed or closed keeps its old keys for up to that long.
When identity could not ask the accounts service, both are evaluated as
unknown, never as absent: a condition on them never helps an `Allow` apply
and always lets a `Deny` apply. A request whose policies do not test them
is decided as usual.

S3 keys such as `s3:prefix`,
`s3:x-amz-acl`, `s3:x-amz-grant-*`, `s3:x-amz-object-ownership`,
`s3:x-amz-server-side-encryption`, `s3:x-amz-copy-source`, `s3:if-none-match`, `s3:authType`,
`s3:signatureversion` and `s3:ResourceAccount` are supplied for the actions the reference lists
them for, when the request carries a value; the README lists them all. A
value over 4096 bytes is refused with `400 InvalidArgument`.

The gaps, as the README lists them:

- Bucket policies stored by v0.7.0 and earlier are unbound: they keep
  matching their principals by ARN, so a user or role deleted and created
  again under the same name inherits their grants, until each policy is
  saved again with PutBucketPolicy, which binds it. A standalone server
  never binds.
- A session whose role was deleted is refused.
- Service, `CanonicalUser` and federated principals are accepted in a
  bucket policy but match no caller.
- Block Public Access is bucket-level only: there are no account-level or
  access point settings. ACLs are stored and reported, never evaluated, so
  no ACL grant gives access.
- On S3 a bucket policy `Deny` also applies to the bucket owner's root user;
  here that root is never evaluated.
- PutBucketPolicy does not check that each action applies to the resources
  its statement names. Standalone, it does not check that a named user or
  role exists.
- `aws:ResourceTag/*` and `s3:BucketTag/*` are not supplied. S3 evaluates
  them only on a bucket with ABAC enabled, which is off by default, and
  PutBucketAbac is not implemented, so a bucket's tags reach no condition,
  as on S3 without it.
- `s3:signatureAge`, `s3:TlsVersion` and the other S3 keys not listed are
  not supplied.
- Object tagging and object lock headers on a write are ignored, so such a
  write needs only `s3:PutObject`.
- An object written with a customer-provided key (SSE-C) is read without
  it, where S3 refuses a read that lacks the key, so the key is no
  safeguard here; a read with SSE-C headers of an object stored without
  them is served ([Default encryption](#default-encryption)).
- Access point policies, permissions boundaries, session policies, SCPs and
  RCPs are not evaluated.

### Changes in v0.9.0

- **Breaking:** CORS is answered per bucket, as S3 answers it, from each
  bucket's CORS configuration ([CORS](#cors)). Up to v0.8.0 every origin
  was allowed on every bucket. A bucket without a configuration now refuses
  every preflight with `403 AccessForbidden`, so a browser can no longer
  upload to or read from it. A browser-based setup needs PutBucketCors on
  each bucket it uses, such as, for a page served from
  `http://localhost:3000` that reads and uploads with presigned URLs:

  ```sh
  aws s3api put-bucket-cors --endpoint-url http://localhost:9000 --bucket uploads \
    --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:3000"],
      "AllowedMethods":["GET","PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"]}]}'
  ```

  The service endpoint (`GET /`) and the health probes have no CORS
  configuration: they send no CORS headers, and a preflight to them is
  refused as one to a bucket without a configuration.
- **Breaking:** a new bucket, one made by CreateBucket or by
  `TULE_Storage_Buckets`, has all four Block Public Access settings on, as
  S3's have since April 2023 ([Block Public Access](#block-public-access)):
  PutBucketPolicy of a public policy on it is refused with `403
  AccessDenied` until DeletePublicAccessBlock or PutPublicAccessBlock turns
  `BlockPublicPolicy` off. Buckets that exist before the upgrade have no
  Block Public Access configuration and keep accepting public policies.
- **Breaking:** a new bucket has Object Ownership `BucketOwnerEnforced`,
  ACLs disabled, as S3's have since April 2023
  ([Object Ownership and ACLs](#object-ownership-and-acls)). An `x-amz-acl`
  or `x-amz-grant-*` header on a write to it, which was accepted and
  ignored, is refused with `400 AccessControlListNotSupported` unless it
  grants the bucket owner full control alone (`bucket-owner-full-control`,
  `private` or the equivalent grant); CreateBucket with such an ACL is
  refused with `400 InvalidBucketAclWithObjectOwnership`. Buckets that
  exist before the upgrade have no ownership controls, behave as
  `ObjectWriter`, and accept ACLs as before, now storing them.
- A write carrying a grant header or a canned ACL other than `private` and
  `bucket-owner-full-control` also needs `s3:PutObjectAcl`, and CreateBucket
  with an ACL other than `private` or with `x-amz-object-ownership` also
  `s3:PutBucketAcl` or `s3:PutBucketOwnershipControls`
  ([Actions and resources](#actions-and-resources)).
- PutObject, CopyObject, CreateMultipartUpload, UploadPart,
  CompleteMultipartUpload, GetObject and HeadObject answer with
  `x-amz-server-side-encryption`, `AES256` unless the request or the
  bucket's default encryption names SSE-KMS, or, for a write with a
  customer-provided key, with the SSE-C headers instead; a malformed SSE-C
  request, which was accepted, is refused
  ([Default encryption](#default-encryption)).
- The tagging, CORS, public access block, policy status, ownership
  controls, ACL and encryption subresources, which answered `501
  NotImplemented`, are served.

### Changes in v0.8.0

- **Breaking:** `TULE_Auth_IdentityEndpoint` needs identity v0.5.0 or later,
  whose signing-key endpoint reports the organization keys and which serves
  the principal-ID endpoint; an older identity fails every request it
  verifies with `500`.
- With an identity endpoint, PutBucketPolicy binds user and role ARNs to
  unique IDs and refuses one no user or role has; GetBucketPolicy shows them
  back as ARNs, or as IDs for principals that are gone; and either fails
  with `500` when identity cannot be asked
  ([Unique-ID principals](#unique-id-principals)).
- `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths` are supplied. A negated
  condition on them, which held for every principal when they were not
  supplied, now holds only outside the organization.
- **Upgrade:** policies stored by v0.7.0 and earlier stay unbound and match
  by ARN until saved again; save each one again to bind it.

### Changes in v0.7.0

- **Breaking:** `TULE_Auth_IdentityEndpoint` needs identity v0.4.0 or later;
  an older identity fails every request it verifies with `500`.
- A principal of another account is no longer refused every request: it is
  allowed what its identity policies and the bucket policy both allow.
  `aws:PrincipalArn` for a role session now carries the role's path.
- `x-amz-expected-bucket-owner` was ignored; a value other than
  `TULE_Auth_AccountID` is now refused.
- Buckets have generations ([above](#bucket-generations)).

## Bucket configuration

Each configuration is kept with its bucket, as the bucket policy is, read
and changed under the bucket's generation ([Bucket generations](#bucket-generations)),
and deleted with the bucket. The writes are evaluated before their document
is read. Each takes `x-amz-expected-bucket-owner`, and `Content-MD5` and the
checksum headers are accepted and ignored. A Put answers `200` with no body
and a Delete `204`, also when the bucket had no such configuration. A
document over 64 KB is refused with `400 MaxMessageLengthExceeded`. S3 sets
that limit for CORS; the README marks applying it to the others, and each
error code and message S3 does not document, as a choice.

### Tagging

PutBucketTagging, GetBucketTagging and DeleteBucketTagging. A tag set
replaces the bucket's whole set. S3's rules are refused with `400
InvalidTag`:

- at most 50 tags;
- a key of 1 to 128 Unicode characters, a value of 0 to 256;
- letters, numbers, spaces and `_ . : / = + - @`;
- no key starting with the reserved `aws:` prefix, in any case;
- no key twice.

A document without a `TagSet` is `400 MalformedXML`. An empty `TagSet` is
stored, and read back empty. GetBucketTagging of a bucket without tags is
`404 NoSuchTagSet`. A bucket's tags reach no condition key
([Actions and resources](#actions-and-resources)).

### CORS

PutBucketCors, GetBucketCors (`404 NoSuchCORSConfiguration`) and
DeleteBucketCors, with S3's rules: 1 to 100 rules, each with at least one
`AllowedOrigin` and one `AllowedMethod` (`400 MalformedXML` without),
methods among `GET`, `PUT`, `POST`, `DELETE` and `HEAD`, at most one `*` in
each `AllowedOrigin` and `AllowedHeader`, and an `ID` of at most 255
characters. These are refused with `400 InvalidRequest`, as are an
`ExposeHeader` holding a `*` and a negative `MaxAgeSeconds`.

A request is matched against the bucket's rules as S3 matches it: the first
rule whose `AllowedOrigin` matches `Origin`, whose `AllowedMethod` is the
method, and, for a preflight, whose `AllowedHeader` entries match every
header in `Access-Control-Request-Headers`. A `*` stands for any run of
characters. Origins and methods are compared exactly and header names
regardless of case. The bucket is the one the path or a
`<bucket>.<TULE_Server_Domain>` host names.

- **Preflight** (`OPTIONS` with `Origin` and
  `Access-Control-Request-Method`) is answered without a signature, as
  browsers send it, and only a preflight is: any other `OPTIONS` is
  verified as every request is. One a rule allows gets `200` with
  `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` (the rule's
  methods), `Access-Control-Allow-Headers` (the headers requested),
  `Access-Control-Expose-Headers`, `Access-Control-Max-Age` (when the rule
  sets `MaxAgeSeconds`), `Access-Control-Allow-Credentials: true` and
  `Vary: Origin, Access-Control-Request-Headers,
  Access-Control-Request-Method`. One no rule allows gets `403
  AccessForbidden`, "CORSResponse: This CORS request is not allowed. ...",
  and one to a bucket without a configuration, or that does not exist, `403
  AccessForbidden`, "CORSResponse: CORS is not enabled for this bucket."
- **Any other request with `Origin`** that a rule allows for its method
  gets the same headers but `Access-Control-Allow-Headers`, on its
  response whatever it is, errors included, so the page can read a
  refusal. The request is verified and authorized as usual: CORS grants no
  access and takes none away.
- The rule's first `AllowedOrigin` entry that matches the origin decides
  the answer: a bare `*` is answered with `Access-Control-Allow-Origin: *`
  and no `Access-Control-Allow-Credentials`, and any other entry with the
  request's origin, so a rule listing `https://a.example` before `*`
  answers that origin as itself.
- `Vary` is sent on every response to a request with `Origin` to a bucket
  with a configuration, whether or not a rule matched. A request without
  `Origin` reads no configuration and gets no CORS headers.

### Block Public Access

PutPublicAccessBlock, GetPublicAccessBlock (`404
NoSuchPublicAccessBlockConfiguration`) and DeletePublicAccessBlock, for the
bucket: there are no account-level settings. A setting left out of
PutPublicAccessBlock is off. A new bucket has all four on, as new buckets
on S3 have since April 2023.

A bucket policy is public by S3's rule: an `Allow` statement whose
principal is `"*"`, or names `"*"` as an `AWS` principal, is public unless
its condition fixes, with values holding no wildcard or policy variable,
under a positive operator (`StringEquals`, `StringLike`, `ArnEquals`,
`ArnLike`, `IpAddress`, plain or `ForAnyValue:`, never `...IfExists` or
`ForAllValues:`), one of `aws:PrincipalArn`, `aws:PrincipalAccount`,
`aws:PrincipalOrgID`, `aws:userid` (a role's `AROA...:*` counts as fixed),
`aws:SourceArn`, `aws:SourceVpc`, `aws:SourceVpce`, `aws:SourceOwner`,
`aws:SourceAccount`, `s3:DataAccessPointArn` (whose access point name may
be a wildcard) or `s3:DataAccessPointAccount`, or `aws:SourceIp` with no
range broader than a /8 (IPv4) or /32 (IPv6). `Deny` statements are never
public.

- **BlockPublicPolicy** refuses PutBucketPolicy of a public policy with
  `403 AccessDenied`, for every caller, the root key included. A policy
  already stored is kept.
- **RestrictPublicBuckets**, while the bucket's policy is public, takes the
  whole policy away from principals of other accounts, including its
  non-public grants to specific accounts. Such a principal is then refused
  as if the bucket had no policy (`403 AccessDenied`, "... because no
  resource-based policy allows the ... action"). Principals of
  `TULE_Auth_AccountID` are evaluated with the policy as written; AWS
  service principals match no caller here. A non-public policy is not
  restricted.
- **BlockPublicAcls**, under `ObjectWriter` or `BucketOwnerPreferred`,
  refuses a public ACL (one granting `AllUsers` or `AuthenticatedUsers`)
  on PutBucketAcl, PutObjectAcl, PutObject, CopyObject and
  CreateMultipartUpload with `403 AccessDenied`, and CreateBucket with a
  public ACL is refused with `400 InvalidBucketAclWithBlockPublicAccess`,
  since the new bucket blocks them. **IgnorePublicAcls** leaves the public
  grants out of GetBucketAcl and GetObjectAcl. Under `BucketOwnerEnforced`
  neither has anything to act on.

GetBucketPolicyStatus answers `IsPublic` by the same rule, whatever the
settings, and `404 NoSuchBucketPolicy` for a bucket without a policy.

### Object Ownership and ACLs

PutBucketOwnershipControls, GetBucketOwnershipControls (`404
OwnershipControlsNotFoundError`) and DeleteBucketOwnershipControls. A new
bucket is `BucketOwnerEnforced` unless CreateBucket's
`x-amz-object-ownership` names another setting; an unknown value is `400
InvalidArgument`. A bucket without ownership controls, one made by an
earlier version or whose controls were deleted, behaves as `ObjectWriter`.
Setting `BucketOwnerEnforced` on a bucket whose ACL grants anyone but its
owner is refused with `400 InvalidBucketAclWithObjectOwnership`.

ACLs come from `x-amz-acl` or the `x-amz-grant-*` headers, on CreateBucket,
PutObject, CopyObject, CreateMultipartUpload, PutBucketAcl and
PutObjectAcl, or from PutBucketAcl's and PutObjectAcl's
`AccessControlPolicy` document. A request with both a canned ACL and grant
headers, or with headers and a document, is `400 InvalidRequest`. Canned
ACLs grant what S3's table lists; `aws-exec-read`, which grants Amazon EC2,
is `501 NotImplemented`. ACLs name accounts by a canonical user ID, here
the hex SHA-256 of the account ID. A grantee, in a header (`id="..."`,
`uri="..."`) or a document, is a canonical user ID of 64 lowercase hex
digits or the URI of `AllUsers`, `AuthenticatedUsers` or `LogDelivery`;
anything else is `400 InvalidArgument`, "Invalid id" or "Invalid group
uri". An `emailAddress` grantee is `400 UnresolvableGrantByEmailAddress`.

- **BucketOwnerEnforced** (ACLs disabled): the bucket accepts only requests
  that specify no ACL or one granting the bucket owner full control. Any
  other ACL on a write, PutBucketAcl or PutObjectAcl is refused with `400
  AccessControlListNotSupported`, "The bucket does not allow ACLs", and
  CreateBucket with an ACL granting anyone but the owner with `400
  InvalidBucketAclWithObjectOwnership`. `bucket-owner-full-control`,
  `private` (which grants the owner, then the bucket owner, the same full
  control) and the equivalent grant or document are accepted. GetBucketAcl
  and GetObjectAcl answer the bucket owner with `FULL_CONTROL`.
- **ObjectWriter** and **BucketOwnerPreferred**: ACLs are accepted (within
  BlockPublicAcls) and stored only as far as GetBucketAcl and GetObjectAcl
  need to answer them: the bucket's ACL, and each object's with its owner,
  the writer's account, or the bucket owner under `BucketOwnerPreferred`
  with `bucket-owner-full-control`. An object written by another account
  without an ACL is stored with the private ACL, to record its owner. An
  object's ACL goes with that object: one written over gets its own
  request's ACL, or the default, and a copy never takes its source's. A
  stored ACL is kept when ACLs are disabled, and answered again when they
  are enabled. **ACLs are never evaluated**: no grant gives or refuses
  access, and every object is evaluated as the bucket owner's.

### Default encryption

PutBucketEncryption, GetBucketEncryption and DeleteBucketEncryption, with
one rule whose default is `AES256`, `aws:kms` or `aws:kms:dsse` (`400
MalformedXML` otherwise; `aws:fsx` and `aws:backup` are refused), and a
`KMSMasterKeyID` only for the KMS algorithms (`400 InvalidArgument`
otherwise). The key ID is not checked, as S3 does not check it. A bucket
never given one, or whose encryption was deleted, answers SSE-S3, `AES256`
with `BucketKeyEnabled` false, as S3's default is. `BlockedEncryptionTypes`
is stored and returned; nothing is blocked.

PutObject, CopyObject, CreateMultipartUpload, UploadPart and
CompleteMultipartUpload answer, and GetObject and HeadObject replay, the
encryption the object, or the upload's object, was stored with: the
request's `x-amz-server-side-encryption`, its KMS key ID and bucket key
setting, or for what the request leaves out the bucket's default. A copy
takes its own request's or its bucket's, never its source's.
`x-amz-server-side-encryption-aws-kms-key-id` is answered only when a key
was named, and `x-amz-server-side-encryption-bucket-key-enabled` only when
it is on for a KMS algorithm. An algorithm S3 does not take, a KMS key ID
without a KMS algorithm and a bucket key setting that is not a boolean are
refused with `400 InvalidArgument`. An object stored by an earlier version
reports `AES256`.

A write with a customer-provided key (SSE-C) is stored and answered with
`x-amz-server-side-encryption-customer-algorithm` and
`x-amz-server-side-encryption-customer-key-MD5` and no
`x-amz-server-side-encryption`; the bucket default does not apply to it.
The key MD5 is that of the key sent, which a sent MD5 must equal. The key
is required and must be the base64 of 256 bits. An algorithm other than
`AES256` is `400 InvalidEncryptionAlgorithmError`; a key or MD5 without the
algorithm, the algorithm without a key or with
`x-amz-server-side-encryption`, a key that is not the base64 of 256 bits
and an MD5 that does not match are `400 InvalidArgument`. The key is not
kept, and a read does not need it, where S3 refuses one without it.

A GetObject or HeadObject carrying `x-amz-server-side-encryption`, of an
object not stored with a customer key, is refused with `400
InvalidArgument`, as S3 refuses it with a 400. A read of an SSE-C object
with that header, and a read with SSE-C headers of an object stored
without them, are served. **Nothing is encrypted**, with KMS or otherwise:
objects are stored as sent, and SSE-KMS is accepted and reported only.

## Health checks

`GET /_health` (liveness) and `GET /_ready` (readiness) answer without a
signature. They respond `200` when every service reports healthy or ready and
`503` otherwise, with a JSON object of each service's status. Readiness fails
when the storage root cannot be read.

Startup buckets are created before the server listens, so once either probe
answers, they exist.

## Connecting a client

Use any region; buckets report `us-east-1`. Path-style addressing always
works. Virtual-hosted style works when the client can resolve
`<bucket>.<TULE_Server_Domain>` to the server.

Go (AWS SDK v2):

```go
client := s3.New(s3.Options{
	Region:       "us-east-1",
	BaseEndpoint: aws.String("http://localhost:9000"),
	UsePathStyle: true,
	Credentials:  credentials.NewStaticCredentialsProvider("test", "test", ""),
})
```

JavaScript (AWS SDK v3):

```js
const client = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

Browsers can upload to and download from presigned URLs directly once the
bucket has a CORS configuration allowing the page's origin
([CORS](#cors)); without one, a browser's cross-origin requests to the
bucket are refused, as on S3.

## Supported operations

- **Buckets:** ListBuckets, CreateBucket, HeadBucket, DeleteBucket,
  GetBucketLocation, GetBucketVersioning (always unversioned).
- **Bucket policies:** PutBucketPolicy, GetBucketPolicy, DeleteBucketPolicy,
  GetBucketPolicyStatus.
- **Bucket configuration** ([above](#bucket-configuration)):
  PutBucketTagging, GetBucketTagging, DeleteBucketTagging; PutBucketCors,
  GetBucketCors, DeleteBucketCors and CORS preflights; PutPublicAccessBlock,
  GetPublicAccessBlock, DeletePublicAccessBlock; PutBucketOwnershipControls,
  GetBucketOwnershipControls, DeleteBucketOwnershipControls; PutBucketAcl,
  GetBucketAcl, PutObjectAcl, GetObjectAcl; PutBucketEncryption,
  GetBucketEncryption, DeleteBucketEncryption.
- **Listing:** ListObjectsV2 and ListObjects (v1), with prefix, delimiter,
  paging and `encoding-type=url`.
- **Objects:** PutObject (including aws-chunked streaming uploads), GetObject
  (ranges, `partNumber`, `response-*` overrides, conditional GETs), HeadObject,
  CopyObject (`COPY` and `REPLACE` metadata directives), DeleteObject,
  DeleteObjects.
- **Multipart uploads:** CreateMultipartUpload, UploadPart,
  CompleteMultipartUpload, AbortMultipartUpload, ListParts,
  ListMultipartUploads. ETags and the 5 MiB minimum part size follow S3.
- **Conditional writes:** `If-None-Match: *` and `If-Match` on PutObject,
  CopyObject and CompleteMultipartUpload.
- **Presigned URLs** for GET and PUT.
- **Metadata:** `x-amz-meta-*` user metadata and the `Cache-Control`,
  `Content-Disposition`, `Content-Encoding`, `Content-Language` and `Expires`
  headers.

## Differences from S3

- **Keys.** Keys are opaque strings, as on S3: `a` and `a/b` coexist, and
  folder markers and `.` or `..` segments are ordinary keys. A key must be 1
  to 1024 bytes of valid UTF-8 and must not end in a `.` segment (`a/.`).
  A longer key is rejected with `400 KeyTooLongError`, as on S3; other
  invalid keys with `400 InvalidArgument`.
- **Storage layout.** Objects are stored by the gas `storage/dir` backend
  under hashed names, so the storage root is not browsable as files.
  Directories written by earlier versions are not readable by this one, and
  the server refuses to start on one. To keep their objects, serve the old
  volume with the previous image and a fresh one with this image, then copy
  each bucket through a local directory (`aws s3 sync` takes one endpoint per
  run):

  ```sh
  docker run -d --name old -p 9000:9000 -v s3data:/data \
    -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
    ghcr.io/tulehq/object-store:0.3.1
  docker run -d --name new -p 9001:9000 -v s3data-new:/data \
    -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
    ghcr.io/tulehq/object-store:0.9.0
  export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
  for b in $(aws s3 ls --endpoint-url http://localhost:9000 | awk '{print $3}'); do
    aws s3 sync "s3://$b" "copy/$b" --endpoint-url http://localhost:9000
    aws s3 mb "s3://$b" --endpoint-url http://localhost:9001
    aws s3 sync "copy/$b" "s3://$b" --endpoint-url http://localhost:9001
  done
  ```

  The copies keep their keys and contents. User metadata, system headers and
  modification times are not copied, and content types are guessed again from
  the file names.
- **Signature verification is request-level.** Header and presigned-URL
  signatures, expiry, clock skew and hex payload hashes are checked; the
  per-chunk signatures of streaming uploads are not, so a DeleteObjects or
  CompleteMultipartUpload document sent with signed chunks
  (`STREAMING-AWS4-*`) is refused with `400 InvalidRequest`. A body is
  decoded as aws-chunked only under a `STREAMING-*` `x-amz-content-sha256`;
  `Content-Encoding: aws-chunked` with any other value is refused with `400
  InvalidRequest`. As on S3, a request is refused when it carries an
  `x-amz-*` header it did not sign (`403 AccessDenied`), when its
  `SignedHeaders` are not lowercase, sorted and unique, when it is signed for
  a service other than `s3`, when its `x-amz-content-sha256` is not a hex
  SHA-256, `UNSIGNED-PAYLOAD` or `STREAMING-*` (`400 InvalidArgument`), and
  when a presigned URL is dated more than 15 minutes ahead (`403
  AccessDenied`, "Request is not yet valid"). The signature must cover
  `Host`. Unlike S3:
  - the credential's region is not checked, so clients may sign for any
    region;
  - the configured key is a long-term one, so a request carrying a session
    token on it is refused with `400 InvalidToken`. Without
    `TULE_Auth_IdentityEndpoint`, a session token on any other key ID gets
    `403 InvalidAccessKeyId`, as that key is unknown. With it, identity's
    session credentials are accepted, and a token that is not the session's
    is refused with `400 InvalidToken` and an expired one with `400
    ExpiredToken`;
  - a DeleteObjects or CompleteMultipartUpload document over 2 MiB is
    refused with `400 MaxMessageLengthExceeded`. One signed with a hex
    `x-amz-content-sha256` is verified before it is acted on; one sent as
    `UNSIGNED-PAYLOAD` or `STREAMING-UNSIGNED-PAYLOAD-TRAILER` is read as
    sent, as on S3.
- **Every key shares all the data.** The root key and every key identity
  issued in `TULE_Auth_AccountID` see and change the same buckets and
  objects, as far as their policies allow. Keys of other accounts reach them
  only through bucket policies. There is no per-account isolation
  ([Permissions](#permissions)).
- **Presigned DeleteObjects and CompleteMultipartUpload URLs sign no body**,
  as on S3. Whoever holds such a URL chooses the document it sends, so the
  URL is a bearer grant over every key in the bucket for that operation:
  any keys to delete, or any of the upload's parts to complete.
- **Not implemented** (requests return `501 NotImplemented`): enabling
  versioning, object tagging, lifecycle configuration, object lock,
  UploadPartCopy, and browser POST-policy uploads.
- **Accepted but ignored:** `x-amz-copy-source-if-*` conditions, a copy
  source's SSE-C headers (`x-amz-copy-source-server-side-encryption-customer-*`),
  the SSE-C headers of a read, and additional checksums
  (`x-amz-checksum-*`, neither verified nor returned). SSE-S3, SSE-KMS and
  SSE-C headers and bucket defaults on writes are validated, recorded and
  reported, but nothing is encrypted, and reads of an SSE-C object do not
  need its key; `x-amz-server-side-encryption` on a read of any other
  object is refused with `400 InvalidArgument`
  ([Default encryption](#default-encryption)). ACLs are stored and
  reported, never evaluated ([Object Ownership and ACLs](#object-ownership-and-acls)).
- HeadObject ignores conditional request headers.

## Release and module

This page follows the object-store README at
[v0.9.0](https://github.com/tulehq/object-store/blob/v0.9.0/README.md), released as
`ghcr.io/tulehq/object-store:0.9.0`. Its Go module is `tule.dev/object-store`, with the
source at [github.com/tulehq/object-store](https://github.com/tulehq/object-store).
