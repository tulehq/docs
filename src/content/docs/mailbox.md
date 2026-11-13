---
title: mailbox
description: "mailbox 0.3.0: a local stand-in for SES v2."
---

An Amazon SES v2-compatible mail service that never delivers mail. Every
message it accepts is stored, as a recipient would receive it, in a local
SQLite database, and a retrieval API lists, searches, reads back and deletes
what was sent. It is built to stand in for SES in local development and
end-to-end tests: point an AWS SDK, or anything that sends through SES v2, at
it, and then ask it what your code sent.

It is not a mail server. No message leaves it, and no identity is ever
verified (every identity counts as verified at once). The configured access
key can send and read every message; when it is pointed at
[identity](/identity/), the keys identity issued are accepted too, and each
is held to its IAM identity policies ([Permissions](#permissions)).

## Running it

With Docker:

```sh
docker run --rm -p 9040:9040 -v mailboxdata:/data \
  -e TULE_Auth_AccessKeyID=test -e TULE_Auth_SecretAccessKey=test \
  ghcr.io/tulehq/mailbox:0.3.0
```

The image is based on Alpine, so `docker exec -it <container> sh` gives you a
shell. It runs as the unprivileged `nonroot` user, keeps its database at
`/data/mailbox.db` on the `/data` volume, and its Docker health check polls
`/_ready`.

From source (Go 1.27.4 or later):

```sh
make build
TULE_Auth_AccessKeyID=test TULE_Auth_SecretAccessKey=test ./build/tule-mailbox
```

It listens on port 9040, so it does not collide with
[object-store](/object-store/) on 9000,
[secret-store](/secret-store/) on 9010,
[accounts](/accounts/) on 9020 or
[identity](/identity/) on 9030.

## Configuration

Settings come from environment variables prefixed with `TULE_`, and from a
`.env` file in the working directory (without the prefix).

| Variable | Default | Purpose |
|---|---|---|
| `TULE_Server_Port` | `9040` | Listen port |
| `TULE_Store_Path` | `./data/mailbox.db` (`/data/mailbox.db` in the image) | The SQLite database file; it and its directory are created if missing |
| `TULE_HSTS_MaxAge` | unset | `Strict-Transport-Security` max age; the header is only sent when set |
| `TULE_Server_ReadTimeout` | `60s` | How long the server may take to read a request, body included |
| `TULE_Server_ReadHeaderTimeout` | `30s` | How long it may take to read a request's headers; must be positive |
| `TULE_Server_WriteTimeout` | `60s` | How long it may take to write a response |
| `TULE_Server_IdleTimeout` | `2m` | How long a keep-alive connection may sit idle between requests |
| `TULE_Server_ShutdownTimeout` | `7s` | How long a graceful shutdown waits for in-flight requests |
| `TULE_Auth_AccessKeyID` | required | The access key clients sign requests with |
| `TULE_Auth_SecretAccessKey` | required | Its secret |
| `TULE_Auth_IdentityEndpoint` | unset | The identity service's base URL, such as `http://localhost:9030`: an absolute http or https URL. Set, the keys identity issued are accepted as well as the configured key, held to their identity policies ([Permissions](#permissions)), and identity is asked about them with the configured key, which must be identity's root key. Identity 0.4.0 or later is required. Unset, mailbox runs standalone on the configured key alone |
| `TULE_Mailbox_AccountID` | `000000000000` | The account mailbox's resources belong to: 12 digits. The root key acts in it and the ARNs carry it. The default is identity's default management account |
| `TULE_Mailbox_Region` | `us-east-1` | The region the ARNs carry and `aws:RequestedRegion` is, whatever region a request was signed for |
| `TULE_GasEnv` | | `development` logs console output at trace level, `production` logs at warn level, `testing` disables logging |

The read and write timeouts are sized for the largest request this service
accepts, a 64 MiB body: a message at SES's 40 MB limit, base64-encoded in
JSON. Logs go to the console only; there is no log shipping.

The server refuses to start without an access key, because every request is
verified against it and any web page the developer has open can reach a server
on localhost.

With an identity endpoint, a request signed with any key but the configured
one is verified through identity's signing-key endpoint, on every request:
a key identity deactivates or deletes is refused on the next one. A request
signed with the configured key never asks identity. When identity cannot be
asked, fails, or gives no answer within 10 seconds, a request signed with
another key fails with `500` `InternalFailure`, never as an unknown key,
and the configured key keeps working.

## Permissions

Without an identity endpoint nothing is evaluated: the configured key is the
account's root, and may call everything.

With one, mailbox authorizes requests as AWS does, within an account and
across accounts, with [tule.dev/policy](/policy/)'s `Authorize`:

- **The root principal of mailbox's account** (`TULE_Mailbox_AccountID`),
  the configured key, which is also identity's root user's key, is always
  allowed and never evaluated.
- **Every other principal**, an IAM user's key, a role session's, or the
  root user of another account, is evaluated on every request, to the SES
  API and the retrieval API alike, against the identity policies identity
  reports for it (a user's inline and attached managed policies, or a
  session's role's) and the resource-based policies of what it acts on.
  Only an identity's sending authorization policies are resource-based
  policies here, and only sends are evaluated with them
  ([Sending authorization](#sending-authorization)).
- **How they combine:** an explicit `Deny` in either kind denies. Within
  mailbox's account an `Allow` in either kind allows, but a resource-based
  `Allow` that names the caller only through its account also needs an
  identity `Allow`; one that names the IAM user, the role (by its ARN with
  the path) or the session, or `"*"`, is enough alone. A principal of
  another account needs both an identity `Allow` and a resource-based
  `Allow`; another account's root user needs only the resource-based one.
  So another account can send from an identity that grants it, and is
  denied every other operation, `tule:Inspect` included.
- **A denied request** fails with `403` `AccessDeniedException` and AWS's
  message, "User: \<arn\> is not authorized to perform: \<action\> on
  resource: \<arn\>" and the reason: "with an explicit deny in an
  identity-based policy", "with an explicit deny in a resource-based
  policy", "because no identity-based policy allows the \<action\> action"
  or "because no resource-based policy allows the \<action\> action".
  Nothing is stored for a denied request.
- **Fail closed.** A principal whose attributes disagree, or a role session
  whose role was deleted, is denied. A principal whose `Root` flag and
  `Account` type disagree is refused with `500` `InternalFailure`, and so is
  a request on a stored policy that no longer parses.

**This was a breaking change in 0.2.** A key identity issued used to be able
to call everything; one with no policy is now denied everything. Give it a
policy, such as `{"Effect": "Allow", "Action": ["ses:*", "tule:Inspect"],
"Resource": "*"}` for the access it had.

### Actions and resources

Each operation is evaluated as its action and on its resources from the
Service Authorization Reference for SES, with ARNs such as
`arn:aws:ses:<region>:<account>:identity/<name>`, `configuration-set/<name>`
and `template/<name>`, in mailbox's account and region, never the
request's.

| Operation | Action | Evaluated on |
|---|---|---|
| `SendEmail` | `ses:SendEmail` | The sender's identity, and for `Raw` content with a `From` header and `FromEmailAddress` the header's identity too; the `FeedbackForwardingEmailAddress`'s identity, when it has one; the configuration set, when the request (or a raw message's `X-SES-CONFIGURATION-SET` header) names one; the stored template, for `Template` content that names one |
| `SendBulkEmail` | `ses:SendBulkEmail` | The same, from the request; a denial refuses the whole request |
| `CreateEmailIdentity` | `ses:CreateEmailIdentity`, and `ses:TagResource` when it has `Tags` | The new identity |
| `GetEmailIdentity`, `DeleteEmailIdentity` | `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity` | The identity |
| `CreateEmailIdentityPolicy`, `GetEmailIdentityPolicies`, `UpdateEmailIdentityPolicy`, `DeleteEmailIdentityPolicy` | `ses:<Operation>` | The identity |
| `ListEmailIdentities` | `ses:ListEmailIdentities` | `*` |
| `CreateEmailTemplate` | `ses:CreateEmailTemplate`, and `ses:TagResource` when it has `Tags` | The new template |
| `GetEmailTemplate`, `UpdateEmailTemplate`, `DeleteEmailTemplate`, `TestRenderEmailTemplate` | `ses:<Operation>` | The template |
| `ListEmailTemplates`, `GetAccount` | `ses:<Operation>` | `*` |
| The retrieval API, every route | `tule:Inspect` | `arn:aws:ses:<region>:<account>:*` |

`SendEmail` with `Raw` content needs `ses:SendEmail` alone, as the reference
maps the v2 operation; `ses:SendRawEmail` is SES v1's.

**The sender's identity.** mailbox sends from any address, so a send is
evaluated on the most granular identity created that covers the address:
the email address identity, else its domain, else its nearest parent domain
created, else, with none created, the address's domain. Which identity AWS
evaluates when several cover an address is not documented; this is
mailbox's choice. The candidates skipped are still checked for an explicit
`Deny`, so a `Deny` on `identity/example.com` cannot be sidestepped through a
subdomain no identity covers. Domain identities are compared in lower case,
email address identities as written.

**`tule:Inspect`** is not an AWS action, since AWS has no API that reads back
what SES accepted. It is evaluated on the whole service in the account and
region, so it takes a grant such as `"Resource": "*"` or
`"arn:aws:ses:*:<account>:*"`.

Every request supplies the global `aws:SourceIp`, `aws:CurrentTime`,
`aws:EpochTime`, `aws:SecureTransport`, `aws:RequestedRegion`
(`TULE_Mailbox_Region`) and `aws:PrincipalTag/<key>` for each of the IAM
user's or the role's tags; and, from the attributes identity reports,
`aws:PrincipalArn` (for a role session its role's ARN with the role's
path, so `arn:aws:iam::*:role/restricted/*` matches a session of
`role/restricted/admin`), `aws:PrincipalAccount`, `aws:userid`,
`aws:PrincipalType` (`User`, `AssumedRole` or `Account`) and, for an IAM
user, `aws:username`. SES operations also
supply `ses:ApiVersion` (`2`); `SendEmail` supplies `ses:FromAddress`,
`ses:FromDisplayName`, `ses:Recipients` and `ses:FeedbackAddress`; creates
supply `aws:RequestTag/<key>` and `aws:TagKeys`; and an existing identity or
template supplies `aws:ResourceTag/<key>`.

### Sending authorization

An identity's sending authorization policies are resource-based policies
that let other principals send from it. They are served by
`CreateEmailIdentityPolicy`, `GetEmailIdentityPolicies`,
`UpdateEmailIdentityPolicy` and `DeleteEmailIdentityPolicy`;
`GetEmailIdentity` reports them, and `DeleteEmailIdentity` deletes them with
the identity. An identity holds at most 20. Each is checked before it is
stored, `BadRequestException` otherwise: a name of 1 to 64 letters, digits,
dashes and underscores, a document of at most 4 KB that parses with
tule.dev/policy's `ParseResource`, and every statement's `Resource` the
identity's ARN (or that ARN with `*` for its region); `NotResource` is
refused. Any action is accepted in a document, though only a send is
evaluated with it.

**A send** is evaluated on the identity it sends from, with every policy
that identity has. A `Deny` in any policy denies, and an `Allow` in any
counts. A delegate sender in another account is allowed when its identity
policy and one of the identity's policies both allow it. A send that uses a
stored template is also evaluated on the template, which has no
resource-based policy, so another account cannot send with mailbox's
templates; inline content works. Its configuration set is evaluated in the
caller's account. The feedback forwarding address, when a send gives one,
is evaluated the same way on its own identity, so a delegate needs a grant
there too.

**The identity ARNs a send gives** (`FromEmailAddressIdentityArn`,
`FeedbackForwardingEmailAddressIdentityArn`, and a raw message's
`X-SES-SOURCE-ARN` and `X-SES-FROM-ARN` headers) choose the identity whose
policies apply. Each may name the address's own identity or one of a domain
that covers it, so `identity/example.com` serves `sender@example.com` even
when that address has an identity of its own. The more specific identities
an ARN passes over still count for a `Deny`, though not for an `Allow`, a
choice of mailbox's own. An ARN is checked for every caller, the root
included: it must be an SES identity ARN of mailbox's account and region,
naming an existing identity that covers the address. `X-SES-RETURN-PATH-ARN`
is removed and not read.

The condition keys of a send apply in these policies as in identity
policies: `ses:FromAddress`, `ses:FromDisplayName`, `ses:Recipients`,
`ses:FeedbackAddress`, `ses:ApiVersion` and the global keys.

### Gaps

The gaps, as the README lists them:

- Principals match by ARN, where AWS converts a stored ARN to the
  principal's unique ID, so a user or role deleted and created again under
  the same name inherits its grants. A session whose role was deleted is
  denied.
- `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths` are not supplied, so a
  `Deny` with a negated operator on them denies every evaluated principal.
- Service, federated-user and `CanonicalUser` principals never match a
  caller.
- A delegate sender needs no identity ARN: every identity is mailbox's
  account's, and a send without one is evaluated on the most granular
  identity of its address.
- Permissions boundaries, session policies, SCPs and RCPs are not
  evaluated.

## Health checks

`GET /_health` (liveness) and `GET /_ready` (readiness) answer without a
signature. They respond `200` when every service reports healthy or ready and
`503` otherwise, with a JSON object of each service's status. Readiness fails
when the database cannot be reached or its schema is not applied.

## Connecting a client

The SES API is SES v2's REST-JSON protocol under `/v2/email`, which the SDKs
already speak. Sign for the `ses` service in any region.

Go (AWS SDK v2):

```go
client := sesv2.New(sesv2.Options{
	Region:       "us-east-1",
	BaseEndpoint: aws.String("http://localhost:9040"),
	Credentials:  credentials.NewStaticCredentialsProvider("test", "test", ""),
})
```

JavaScript (AWS SDK v3):

```js
const client = new SESv2Client({
  region: "us-east-1",
  endpoint: "http://localhost:9040",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

Gas's `email/ses` sender works unchanged: set its `Email.Endpoint` to
`http://localhost:9040`, its region, and the configured key.

Or with `curl`, which signs requests too:

```sh
curl -fsS --aws-sigv4 aws:amz:us-east-1:ses --user test:test \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "FromEmailAddress": "sender@example.com",
    "Destination": {"ToAddresses": ["someone@example.com"]},
    "Content": {"Simple": {
      "Subject": {"Data": "Hello"},
      "Body": {"Text": {"Data": "Hi there."}}
    }}
  }' \
  http://localhost:9040/v2/email/outbound-emails
```

## Supported operations

| Operation | Notes |
|---|---|
| `SendEmail` | Simple, Raw and Template content (a stored template by `TemplateName` or `TemplateArn`, or inline `TemplateContent`). The message is stored, never sent |
| `SendBulkEmail` | Template content; one stored message per entry, and one result per entry |
| `CreateEmailIdentity` | Email addresses and domains; verified at once. A domain gets Easy DKIM tokens, or its own selector with `DkimSigningAttributes` |
| `GetEmailIdentity` | With its policies |
| `ListEmailIdentities` | Paginated; `Filter` by `IDENTITY_NAME_CONTAINS`, `IDENTITY_TYPE` and `VERIFICATION_STATUS` |
| `DeleteEmailIdentity` | Deletes its policies too |
| `CreateEmailIdentityPolicy` / `GetEmailIdentityPolicies` / `UpdateEmailIdentityPolicy` / `DeleteEmailIdentityPolicy` | Sending authorization policies, at most 20 of 4 KB per identity; see [Sending authorization](#sending-authorization) |
| `CreateEmailTemplate` / `GetEmailTemplate` / `UpdateEmailTemplate` / `DeleteEmailTemplate` | The template must be valid Handlebars |
| `ListEmailTemplates` | Paginated |
| `TestRenderEmailTemplate` | Answers the rendered MIME message |
| `GetAccount` | Production access and sending enabled, generous quotas |

Every operation is at the path and method of the SES v2 SDK model.
`ListEmailIdentities` is served both at the SDK's `POST
/v2/email/list-identities` and at `GET /v2/email/identities`, where the
botocore model the AWS CLI reads still puts it.

Requests are checked as SES checks them, with SES's errors:

- **Addresses** must parse, a display name allowed, be 7-bit ASCII, and hold
  no control character (net/mail accepts CR and LF inside an address
  comment, which would end the header line): `BadRequestException`. A message has 1 to 50 recipients across To, Cc and
  Bcc: `BadRequestException` otherwise.
- **Message size** is at most 40 MB (read as 40 MiB) as sent, attachments
  base64-encoded: `MessageRejected` beyond.
- **Headers** that Simple and Template content add: at most 15, names and
  values by the model's patterns and lengths, and none of the headers SES
  sets itself (`BCC`, `CC`, `Content-Disposition`, `Content-Type`, `Date`,
  `From`, `Message-ID`, `MIME-Version`, `Reply-To`, `Return-Path`, `Subject`,
  `To`): `BadRequestException`.
- **Attachments** by the model's lengths and enumerations, a `ContentType`
  that is `type/subtype`, no control character in `FileName`,
  `ContentDescription` or `ContentId`, and a printable ASCII `ContentId`
  (`BadRequestException`), and none of the file extensions SES refuses
  (`.exe`, `.js`, `.bat` and the rest of SES's list): `MessageRejected`.
- **Raw messages** must have a header and a body separated by a blank line,
  well-formed MIME parts, at most 500 of them, no line over 1,000 characters,
  and none of the header fields SES allows once (Subject, From, Date and the
  rest of SES's list) more than once, and no control character in the
  header but HTAB and the line endings, a CR ending its line with an LF:
  `MessageRejected`.
- **Message tags**: names and values of ASCII letters, digits, `_` and `-`,
  up to 256 characters. **Resource tags** on identities and templates: at most
  50, keys of 1 to 128 and values of up to 256 characters by SES's tag rules,
  unique keys, no `aws:` prefix. Both `BadRequestException`.
- **Templates**: at most 500 KB (read as KiB) all parts together, and
  `TemplateData` of at most 262,144 characters: `BadRequestException`. At most
  20,000 templates and 10,000 identities: `LimitExceededException`.
- A name taken already is `AlreadyExistsException`; a template or identity
  that does not exist is `NotFoundException` (`404`).

Errors carry the code in the `X-Amzn-ErrorType` header and a JSON body
`{"code": "...", "message": "..."}`, which the SDKs decode into their typed
exceptions.

## How messages are built

The MessageId is in SES's shape: `0100`, the acceptance time in Unix
milliseconds as 12 hex digits, a random UUID, and `-000000`, for example
`010001a1d2cace87-87ef2327-0461-4e00-bb93-5cd7834b04bb-000000`. The message's
`Message-ID` header carries it, as
`<MessageId@email.amazonses.com>`, and its `Date` header is the acceptance
time in UTC, as SES sets both.

**Simple and Template content** are assembled the way SES assembles them:
`From`, `Reply-To`, `To`, `Cc` and `Subject` from the request (no `Bcc`
header: Bcc recipients get the message but no header names them), the
request's own headers, then `MIME-Version: 1.0`, `Date` and `Message-ID`. A
text and an HTML body go in `multipart/alternative`; inline attachments go
with the body in `multipart/related`; other attachments go with all of it in
`multipart/mixed`. Text in 7-bit ASCII is sent `7bit`, anything else
`quoted-printable`, in the request's `Charset` (UTF-8 when it names none).

Every header is 7-bit and folded to RFC 5322's lengths: lines of at most 78
characters wherever a value has spaces to break at, and never more than 998.
A subject or attachment description that is printable ASCII, including one
the client encoded already, is sent as it is, folded; one that is not, or
that has a word too long to fold, becomes RFC 2047 encoded words in its
character set. A display name that is not printable ASCII, in From, Reply-To,
To or Cc, becomes encoded words too. A file name that is not short printable
ASCII is written as RFC 2231 continuations (`filename*0*=utf-8''...`).

An attachment's content type, when the request gives none, comes from its file
name's extension. Its encoding is the request's `ContentTransferEncoding`;
without one, `7bit` when the content is 7-bit text with CRLF line endings,
and `base64` otherwise, so the recipient's copy is always the bytes attached.
An explicit `SEVEN_BIT` takes only content that is already 7-bit text in
CRLF-ended lines; anything else, a bare LF included, is refused with
`BadRequestException` rather than rewritten, since rewriting would change
the bytes the recipient gets.

**Raw content** is kept byte for byte, with what SES changes applied: its
`Message-ID` and `Date` headers are replaced by SES's own, its `Bcc` header
is removed, and the `X-SES-CONFIGURATION-SET`, `X-SES-MESSAGE-TAGS`,
`X-SES-SOURCE-ARN`, `X-SES-FROM-ARN` and `X-SES-RETURN-PATH-ARN` headers are
read and removed. The request's `FromEmailAddress`, `Destination`,
`ConfigurationSetName` and `EmailTags` take precedence over the message's
`From`, `To`/`Cc`/`Bcc` and X-SES headers; without them, the headers are used.

## Templates

Templates are Handlebars, rendered by
[raymond](https://github.com/mailgun/raymond) (`github.com/mailgun/raymond/v2`),
with what SES's renderer, Handlebars.js, does on top:

- HTML is not escaped, as SES documents.
- JSON objects keep their key order: `{{#each object}}` visits the keys in
  the order `TemplateData` gives them, so a template and its data always
  render the same.
- Numbers print as JavaScript prints them: `1.5e+21`, `1e-7`, `0` for `-0`.
- A rendering fails when it renders an attribute the data does not have, or
  has as `null` (`Attribute 'name' is not present in the rendering data.`,
  SES's text), or calls a helper that does not exist (`Missing helper:
  "eq"`, Handlebars.js's text; SES documents none).
- A rendering is bounded: it fails past 40 MiB of output, all parts
  together, or past 1,000,000 template steps, each `#each` iteration
  counting its block's steps again, so no template and data can hold the
  service.

Variables, nested paths (`{{contact.firstName}}`), `#each` (with `@index`,
`@key`, `@first`, `@last`, `this` and `../`), `#if` / `else`, `#unless`,
`#with`, a block over an attribute (`{{#list}}...{{/list}}`, as Handlebars.js
renders one), comments, `lookup` and `log` work.

**What of SES's syntax is not covered:** inline partials (`{{#* inline
"name"}}`) and partial calls (`{{> name}}`), which SES documents, and any
other decorator or partial block, are not supported by raymond: a template
using them is refused as invalid Handlebars when it is created. The second
block parameter of `#each` (`index` in `{{#each list as |item index|}}`) is
not bound and renders empty; the first is. raymond's own `equal` helper is
not Handlebars.js's, so calling it is a missing helper, as it would be on SES.

When a rendering fails, `SendEmail` and `SendBulkEmail` answer as SES does:
the message is accepted, its MessageId answered, and then it is dropped. SES
reports a Rendering Failure event, which this service has nowhere to send;
instead it records the failure, which `GET /_mailbox/rendering-failures`
lists. `TestRenderEmailTemplate` answers `BadRequestException` with the
failure's text. Template data that is not a JSON object is
`BadRequestException` everywhere.

`SendBulkEmail` renders the default template once per entry: an entry's
`ReplacementTemplateData` replaces the default data (`{}` counts as none, as
the SES developer guide describes it), its `ReplacementTags` replace the
`DefaultEmailTags` when it has any, and its `ReplacementHeaders` merge into
the template's headers, an entry header replacing a template header of the
same name, as the SDK model describes them. A template that does not exist,
or any other fault of the request itself, fails the whole call; a fault of one
entry (an invalid address, too many recipients, invalid data) fails that
entry alone with `INVALID_PARAMETER` or `MESSAGE_REJECTED`, and the other
entries are sent.

## Retrieval API

Not an AWS API. Every route is under `/_mailbox/`, signed with SigV4 for the
`ses` service exactly like the SES API (the configured key, or a key identity
issued whose policies allow `tule:Inspect`; see
[Permissions](#permissions)), and answers JSON. Errors have the SES API's shape, with
`BadRequestException` (`400`) for invalid parameters and `NotFoundException`
(`404`) for an unknown message or attachment.

```sh
alias mb='curl -fsS --aws-sigv4 aws:amz:us-east-1:ses --user test:test'
```

`GET /_mailbox/messages` lists messages, newest first, filtered by any of:

| Parameter | Matches |
|---|---|
| `from` | The From address, without regard to case |
| `to` | Any To, Cc or Bcc address, without regard to case |
| `subject` | A substring of the subject, without regard to ASCII case |
| `q` | Full text over the subject and the text body (SQLite FTS5): every word must appear; words are plain words, not FTS5 syntax |
| `since` / `until` | The time, RFC 3339, both inclusive |
| `configurationSet` | The configuration set name |
| `tag` | `name:value`, repeatable; every one must be on the message |
| `messageId` | The MessageId |

It is paginated by `limit` (1 to 100, default 20) and `cursor`, the opaque
`nextCursor` of the previous page, which is absent on the last page. A
parameter that holds a NUL character is `BadRequestException`.

```sh
mb 'http://localhost:9040/_mailbox/messages?to=someone@example.com&tag=kind:welcome&limit=10'
```

```json
{
  "items": [
    {
      "id": "010001a1d2cace87-87ef2327-0461-4e00-bb93-5cd7834b04bb-000000",
      "time": "2026-11-13T10:00:00.123Z",
      "from": "Sender <sender@example.com>",
      "to": ["someone@example.com"],
      "cc": [],
      "bcc": [],
      "subject": "Hello",
      "tags": [{"name": "kind", "value": "welcome"}],
      "configurationSet": "",
      "size": 924,
      "attachmentCount": 1
    }
  ],
  "nextCursor": "..."
}
```

`time` is RFC 3339 in UTC, to the millisecond. `from`, `to`, `cc` and `bcc`
are the addresses as sent, display names included; `to`, `cc` and `bcc` are
always arrays. `tags` is an array of `{"name", "value"}` in sent order, since
SES does not require tag names to be unique. `configurationSet` is `""` when
the message has none. `size` is the length of the stored MIME in bytes.

`GET /_mailbox/messages/{id}` returns one message: the summary fields plus
`headers`, an array of `{"name", "value"}` in message order with values decoded
from RFC 2047, `text` and `html` (`""` when the part is absent), and
`attachments`, an array of `{"name", "contentType", "size"}`, `size` being
the decoded length.

```sh
mb http://localhost:9040/_mailbox/messages/$ID
```

`GET /_mailbox/messages/{id}/raw` returns the MIME as `message/rfc822`.

```sh
mb http://localhost:9040/_mailbox/messages/$ID/raw > message.eml
```

`GET /_mailbox/messages/{id}/attachments/{index}` returns one attachment's
decoded bytes with its content type. The index is 0-based, in the order of
`attachments`, which is the order of the parts in the message: inline
attachments, which sit with the body, come before the others.

```sh
mb -o report.pdf http://localhost:9040/_mailbox/messages/$ID/attachments/0
```

`DELETE /_mailbox/messages/{id}` deletes one message, and
`DELETE /_mailbox/messages` deletes every message and every rendering
failure (identities and templates stay; they are configuration). Both answer
`204`.

```sh
mb -X DELETE http://localhost:9040/_mailbox/messages
```

`GET /_mailbox/rendering-failures` lists the templated messages that were
accepted and then dropped because their template did not render, newest
first. It filters by `messageId`, `template` (the stored template's name)
and `since` / `until`, and pages by `limit` and `cursor` as messages do. A
failed message is not a message: `GET /_mailbox/messages/{id}` answers `404`
for its MessageId.

```sh
mb 'http://localhost:9040/_mailbox/rendering-failures?template=Welcome'
```

```json
{
  "items": [
    {
      "messageId": "010001a1d2e2d903-ca230ac4-9e58-4569-a25b-1fe927ec7e4f-000000",
      "time": "2026-11-13T10:00:00.123Z",
      "source": "SendEmail",
      "template": "Welcome",
      "from": "sender@example.com",
      "to": ["someone@example.com"],
      "cc": [],
      "bcc": [],
      "tags": [],
      "configurationSet": "",
      "error": "Attribute 'name' is not present in the rendering data."
    }
  ]
}
```

`source` is `SendEmail` or `SendBulkEmail`, and `template` is `""` for inline
`TemplateContent`.

**Signing paths with curl.** curl's `--aws-sigv4` signs the path as it is
written, without the second URI encoding SigV4 gives the path of every
service but S3. A path with any character but letters, digits, `-`, `.`,
`_`, `~` and `/` therefore does not verify (`InvalidSignatureException`),
escaped or not: an email identity, whose `@` the path carries, or a template
name with a space. The retrieval API's paths are all such safe characters,
MessageIds included, and queries are not affected. For an email identity or
such a template, use an SDK or the AWS CLI, which encode the path as SigV4
requires; a domain identity (`/v2/email/identities/example.com`) works with
curl.


## Differences from AWS

- **Nothing is delivered.** Messages are stored and nothing else: no bounces,
  complaints, deliveries, opens or clicks, and no event is published anywhere:
  a templated message whose rendering fails is accepted and dropped, and the
  retrieval API's rendering failures stand in for SES's Rendering Failure
  event. The mailbox simulator addresses are ordinary addresses here.
- **Every identity is verified at once, and none is needed.** Any From address
  is accepted, whether or not an identity covers it, and there is no sandbox.
  The identity APIs work, for code that manages identities, but nothing checks
  DNS: a domain's DKIM tokens are random, its status is `SUCCESS` at once, and
  a Bring Your Own DKIM private key is required but not used. An email-address
  identity reports DKIM signing as not started.
- **Configuration sets are not modeled.** Any `ConfigurationSetName` is
  accepted and recorded with the message; none needs to exist, none has event
  destinations, and an identity's default configuration set, which is
  recorded, is not applied to messages sent without one.
- **Some request members are accepted and ignored:** `EndpointId`,
  `TenantName`, `ListManagementOptions` and `ConfigurationOverrides`.
  `FeedbackForwardingEmailAddress` is checked and recorded but receives
  nothing. The sending authorization ARNs are checked
  ([Sending authorization](#sending-authorization)).
- **The quotas are reported, not enforced.** `GetAccount` reports production
  access, sending enabled, a quota of 1,000,000 messages a day at 1,000 a
  second, and `SentLast24Hours` counting the recipients of the messages stored
  in the last 24 hours. There is no throttling, so `TooManyRequestsException`,
  `SendingPausedException` and `AccountSuspendedException` are never returned.
- **Operations outside the scope are unknown.** Configuration sets, event
  destinations, contact lists and topics, suppression lists, dedicated IPs,
  deliverability, import and export jobs, multi-region endpoints, tenants,
  tagging operations, custom verification emails and the SES v1 API answer
  `404` `UnknownOperationException`.
- **The message is mailbox's assembly, in SES's shape.** Headers SES adds in
  transit (`Return-Path`, `Received`, `Feedback-ID`, `X-SES-Outgoing`,
  `DKIM-Signature`) are not added, and the boundaries and header order are
  this service's own. The `Message-ID` header's domain is always
  `email.amazonses.com`, SES's in us-east-1, whatever region the request was
  signed for.
- **Attachment encoding.** SES documents `SEVEN_BIT` as the default
  `ContentTransferEncoding`. Without one, this service sends `7bit` only when
  the content survives it unchanged (7-bit text with CRLF line endings) and
  `base64` otherwise, so a recipient always gets the bytes attached. An
  explicit `SEVEN_BIT` on content that is not 7-bit text in CRLF-ended lines
  is refused with `BadRequestException`.
- **Text bodies are sent with CRLF line endings,** as MIME requires, so a text
  body sent with LF comes back with CRLF.
- **Text in a character set this service does not know** (in a raw message;
  Simple content with an unknown `Charset` is `BadRequestException`) is kept
  as sent in the retrieval API's `text` and `html`.
- **Error bodies** carry a `code` member beside SES's `message`, repeating the
  `X-Amzn-ErrorType` header. Error messages are modeled on SES's, which AWS
  does not document; clients are expected to match on the code.
- **Choices where AWS documents none.** Identities and templates are listed in
  creation order; a list request without `PageSize` gets pages of 10 (the
  `ListEmailTemplates` reference speaks of the "next 10"). Identity names are
  compared exactly, case included. `NextToken`s and cursors do not expire, and
  are only accepted back by the listing that issued them
  (`BadRequestException` otherwise). Templates are checked to be valid
  Handlebars when they are created or updated. An absent `TemplateData` is an
  empty object. 40 MB and 500 KB are read as MiB and KiB.
- **Signature verification is request-level,** by
  [tule.dev/sigv4](/sigv4/). The method, path, query,
  signed headers and the body's hash are checked, along with the credential's
  access key, its service (`ses`) and a 15-minute clock skew. A request body
  larger than 64 MiB is refused with `413` `RequestEntityTooLargeException`.
  A signature must cover `host` and `x-amz-date`, and every `x-amz-*` header
  the request carries. It must carry a real SHA-256 of the body:
  `UNSIGNED-PAYLOAD` is rejected. Failures answer with the codes of the SES v2
  Common Errors page (`IncompleteSignature`, `InvalidSignatureException`,
  `UnrecognizedClientException`, `ExpiredTokenException`, all `403`), and
  `MissingAuthenticationTokenException` (`403`) for a request with no
  signature.
- **The credential's region is not checked.** It is signed, but any region
  verifies: local clients are set up for whatever region they work in.
- **Session tokens need identity.** The configured key is long-term, so a
  request signed with it and carrying `X-Amz-Security-Token` fails with
  `UnrecognizedClientException`. With identity, a role session's key verifies
  with its token; a token that is not the session's fails with
  `UnrecognizedClientException`, and an expired one with
  `ExpiredTokenException`.
- **Identity policies and sending authorization policies are enforced**, and
  only with identity; see [Permissions](#permissions) for the keys supplied
  and the gaps.
- **One process per database.** The store is one SQLite file reached through
  one connection, which serializes the server's own transactions; nothing
  coordinates two servers pointed at the same file.
- **Logs record the connection's peer address.** `X-Forwarded-For` is not
  trusted, since nothing is expected in front of this service and the header
  is unsigned.

## Upgrading from 0.2

- **Cross-account requests are evaluated.** 0.2 refused every principal of
  another account. Now one is allowed when its identity policies and a
  sending authorization policy both allow a send; everything else is still
  denied to it.
- **Sending authorization policies are enforced, within the account too.** A
  policy that names a user or a role session lets it send from the identity
  without an identity policy, and a `Deny` in one refuses a send its
  identity policies allow.
- **`aws:PrincipalArn` of a role session has the role's path,** so a
  condition written for 0.2's path-less value no longer matches a session of
  a role with a path. `aws:userid` and `aws:PrincipalTag/<key>` are now
  supplied.
- **identity v0.4.0 or later** is required; the keys of an older identity
  are refused.
- **The sending authorization ARNs are honored** rather than ignored, and a
  send with `FeedbackForwardingEmailAddress` now also needs `ses:SendEmail`
  allowed on that address's identity.
- A migration adds the policy table on the first start; it can be rolled
  back.

## Upgrading from 0.1

- **Permissions.** With an identity endpoint, keys identity issued are now
  held to their identity policies, and those of other accounts are refused;
  see [Permissions](#permissions).
- **Domain identity names are lower-cased.** On its first start, 0.2 runs a
  migration that lower-cases the names of the domain identities in the
  store. When two differ only by case, such as `Example.com` and
  `example.com`, the migration fails, names them and changes nothing, and
  mailbox does not start. Delete all but one of them from the database file,
  then the migration's dirty mark, and start it again:

  ```sh
  sqlite3 data/mailbox.db "DELETE FROM identities WHERE name = 'Example.com';
    DELETE FROM __gas_migrations WHERE version = '0003' AND dirty;"
  ```

## Release and module

This page follows the mailbox README at
[v0.3.0](https://github.com/tulehq/mailbox/blob/v0.3.0/README.md), released as
`ghcr.io/tulehq/mailbox:0.3.0`. Its Go module is `tule.dev/mailbox`, with the
source at [github.com/tulehq/mailbox](https://github.com/tulehq/mailbox).
