---
title: object-store
description: "object-store 0.7.0: a local stand-in for S3."
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
  ghcr.io/tulehq/object-store:0.7.0
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
| `TULE_Auth_IdentityEndpoint` | unset | The [identity](/identity/) service's base URL, such as `http://localhost:9030`, to also accept the keys it issues and enforce their IAM policies and bucket policies ([below](#permissions)). Must be an absolute `http` or `https` URL; needs identity v0.4.0 or later |
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
set and read, but no request is evaluated against them.

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
MethodNotAllowed`, as S3 does. Objects belong to the bucket owner whoever
writes them, as under S3's default `BucketOwnerEnforced` setting, so a
bucket policy applies to every object in its bucket.

### Bucket policies

PutBucketPolicy (`PUT /<bucket>?policy`), GetBucketPolicy and
DeleteBucketPolicy take S3's request and response shapes, and each takes
`x-amz-expected-bucket-owner`.

- **PutBucketPolicy** takes the document as the body and answers `204 No
  Content`. It is evaluated before the body is read, and the policy is
  validated before the bucket is looked up. It refuses with `400
  MalformedPolicy` a policy over 20 KB, one that is not a valid
  resource-based policy (with tule.dev/policy's message, such as `Invalid
  principal in policy`), a `Resource` that is not the bucket or an object in
  it ("Policy has invalid resource"), and an `Action` that is not `"*"` or an
  `s3:` action ("Policy has invalid action"); an empty body is `400
  MissingRequestBodyError`.
- **GetBucketPolicy** answers `200` with the document exactly as stored, or
  `404 NoSuchBucketPolicy`.
- **DeleteBucketPolicy** answers `204 No Content`, also when the bucket had
  no policy.

They are evaluated as `s3:PutBucketPolicy`, `s3:GetBucketPolicy` and
`s3:DeleteBucketPolicy` on the bucket. The configured root key is never
evaluated, so it can always change a policy that denies everyone else.
Deleting a bucket deletes its policy, and a new bucket has none.

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

A request for something not implemented (`501 NotImplemented`) is refused
before it is evaluated.

The global condition keys supplied are `aws:SourceIp` (the TCP peer),
`aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`,
`aws:RequestedRegion` (always `us-east-1`), and the principal's keys as
identity reports them: `aws:PrincipalArn` (a user's ARN with its path, a
session's role's ARN with the role's path), `aws:userid`,
`aws:PrincipalType`, `aws:PrincipalAccount`, for IAM users `aws:username`,
and `aws:PrincipalTag/<key>` for each tag of a user or of a session's role.
They fill policy variables too. S3 keys such as `s3:prefix`,
`s3:x-amz-acl`, `s3:x-amz-copy-source`, `s3:if-none-match`, `s3:authType`,
`s3:signatureversion` and `s3:ResourceAccount` are supplied for the actions the reference lists
them for, when the request carries a value; the README lists them all. A
value over 4096 bytes is refused with `400 InvalidArgument`.

The gaps, as the README lists them:

- Bucket policies match principals by ARN, where AWS converts a stored ARN
  to the principal's unique ID, so a user or role deleted and created again
  under the same name inherits its grants. A session whose role was deleted
  is refused.
- `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths` are not supplied, so a
  `Deny` with a negated operator on them, such as one refusing principals
  outside the organization, denies every evaluated principal.
- Service, `CanonicalUser` and federated principals are accepted in a
  bucket policy but match no caller.
- There is no Block Public Access and no GetBucketPolicyStatus, and ACLs
  are not supported.
- On S3 a bucket policy `Deny` also applies to the bucket owner's root user;
  here that root is never evaluated.
- PutBucketPolicy does not check that a named user or role exists.
- `aws:ResourceTag/*`, `s3:signatureAge`, `s3:TlsVersion` and the other S3
  keys not listed are not supplied.
- ACL, tagging and object lock headers on a write are ignored, so such a
  write needs only `s3:PutObject`.
- Access point policies, permissions boundaries, session policies, SCPs and
  RCPs are not evaluated.

### Changes in v0.7.0

- **Breaking:** `TULE_Auth_IdentityEndpoint` needs identity v0.4.0 or later;
  an older identity fails every request it verifies with `500`.
- A principal of another account is no longer refused every request: it is
  allowed what its identity policies and the bucket policy both allow.
  `aws:PrincipalArn` for a role session now carries the role's path.
- `x-amz-expected-bucket-owner` was ignored; a value other than
  `TULE_Auth_AccountID` is now refused.
- Buckets have generations ([above](#bucket-generations)).

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

Browsers can upload to and download from presigned URLs directly: CORS allows
any origin, and response headers such as `ETag` are exposed.

## Supported operations

- **Buckets:** ListBuckets, CreateBucket, HeadBucket, DeleteBucket,
  GetBucketLocation, GetBucketVersioning (always unversioned).
- **Bucket policies:** PutBucketPolicy, GetBucketPolicy, DeleteBucketPolicy.
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
    ghcr.io/tulehq/object-store:0.7.0
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
  versioning, tagging, ACLs, bucket policy status, public access blocks,
  CORS and lifecycle configuration, object lock, UploadPartCopy, and browser POST-policy uploads.
- **Accepted but ignored:** server-side encryption headers,
  `x-amz-copy-source-if-*` conditions, and additional checksums
  (`x-amz-checksum-*`, neither verified nor returned).
- HeadObject ignores conditional request headers.

## Release and module

This page follows the object-store README at
[v0.7.0](https://github.com/tulehq/object-store/blob/v0.7.0/README.md), released as
`ghcr.io/tulehq/object-store:0.7.0`. Its Go module is `tule.dev/object-store`, with the
source at [github.com/tulehq/object-store](https://github.com/tulehq/object-store).
