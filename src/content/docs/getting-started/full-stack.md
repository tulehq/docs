---
title: The full stack
description: Run every Tule service and the console together with the tule CLI, or with Docker Compose.
---

The [`tule` CLI](/cli/) runs every service and the console, wired together:
one root key everywhere, every service pointed at identity so the keys
identity issues work on all of them, each held to its IAM policies and to
the resource policies of what it acts on, and the console pointed at each.
For an app that picks its services in its own compose file, the compose
file [below](#the-file) runs the stack with Docker Compose alone. It is
the console's
[`compose.yaml`](https://github.com/tulehq/console/blob/v0.3.13/compose.yaml)
at v0.3.13, with every service pinned to its current release, object-store
pointed at queues and functions to deliver bucket event notifications, and
secret-store pointed at functions for rotation.

## Start it with tule

[Install `tule`](/cli/#install), then start the stack and point the shell at
it:

```sh
tule up
eval "$(tule env)"
tule status
```

`tule up` starts the default set, every service but functions, and waits
until its services are healthy. functions mounts the Docker socket, which is
root-equivalent on the host, so it runs only when named; `up` finds the
group that owns the socket on the Docker daemon itself:

```sh
tule up functions
```

`tule status` shows each service's host address; open the console's and
[sign in](/getting-started/console/) with the root key ([below](#what-runs)).
`tule down` removes the stack and keeps its data in its volumes;
`tule down --volumes` also deletes the data. See [the CLI](/cli/) for
`tule.yaml`, `tule env` in fish and PowerShell, and the other commands.

## Start it with Docker Compose

Save [the file](#the-file) as `compose.yaml` and start the stack:

```sh
docker compose up -d
```

functions is behind the `functions` profile, since it runs function containers
through the Docker daemon and needs the daemon's socket and the socket's
group. To start it too:

```sh
# Linux
DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose --profile functions up -d
# macOS
DOCKER_GID=$(stat -f %g /var/run/docker.sock) docker compose --profile functions up -d
```

Without it, the console's Functions section shows the service as unreachable,
and secret-store's `RotateSecret` still accepts a rotation but every step of
it fails, since its invocations cannot be made: after three attempts the
rotation fails and its version keeps `AWSPENDING`, which refuses a later
`RotateSecret` with another token. Start the `functions` profile before
rotating secrets. Without it too, object-store cannot reach a function a
bucket notification names: validating the configuration fails, and its
events are retried and then dropped
([Delivery](/object-store/#delivery)).
Pointed at identity, functions runs each function with its execution role,
which must be a role identity has that trusts `lambda.amazonaws.com`; see
[functions](/functions/#execution-roles).
The functions README marks its Docker Desktop (macOS, Windows) setup as
unverified; see [functions](/functions/#running-it).

Then open `http://localhost:9070` and [sign in](/getting-started/console/) with
the root key. The root key may do everything; a key identity issues may do
only what its policies allow, and nothing until it has one (see
[Identity and keys](/guides/identity/#policies)). A role session of a member
account reaches the management account's buckets, secrets, queues,
functions and mail identities where their resource policies grant it, as
on AWS; see [Cross-account access](/guides/identity/#cross-account-access).

## What runs

| Service | Image | Port on the host |
|---|---|---|
| identity | `ghcr.io/tulehq/identity:0.5.2` | 9030 |
| accounts | `ghcr.io/tulehq/accounts:0.5.1` | 9020 |
| object-store | `ghcr.io/tulehq/object-store:0.13.1` | 9000 |
| secret-store | `ghcr.io/tulehq/secret-store:0.6.1` | 9010 |
| mailbox | `ghcr.io/tulehq/mailbox:0.4.1` | 9040 |
| queues | `ghcr.io/tulehq/queues:0.7.0` | 9050 |
| functions (profile `functions`) | `ghcr.io/tulehq/functions:0.7.0` | 9060 |
| console | `ghcr.io/tulehq/console:0.3.13` | 9070 |

The table is the compose file's; `tule services` lists each service's image,
tested version and default ports as `tule` runs them.

Each service keeps its data on a named volume. The console holds no data.

The root key, shared by every service, is the AWS documentation's example key:

| | |
|---|---|
| Access key ID | `AKIAIOSFODNN7EXAMPLE` |
| Secret access key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |

Use your own outside a local machine. identity looks up access key IDs of at
least 16 characters, so a short key such as `test` does not suit a stack with
identity.

## The file

```yaml
x-root-key: &root-key
  # The AWS documentation's example key; identity holds access key IDs to at
  # least 16 characters. Use your own outside a local machine.
  TULE_Auth_AccessKeyID: AKIAIOSFODNN7EXAMPLE
  TULE_Auth_SecretAccessKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

x-identity: &identity-endpoint
  TULE_Auth_IdentityEndpoint: http://identity:9030

services:
  identity:
    image: ghcr.io/tulehq/identity:0.5.2
    environment:
      <<: *root-key
      TULE_Identity_AccountsEndpoint: http://accounts:9020
    ports: ["9030:9030"]
    volumes: [identitydata:/data]

  accounts:
    image: ghcr.io/tulehq/accounts:0.5.1
    environment:
      <<: [*root-key, *identity-endpoint]
    ports: ["9020:9020"]
    volumes: [accountsdata:/data]

  object-store:
    image: ghcr.io/tulehq/object-store:0.13.1
    environment:
      <<: [*root-key, *identity-endpoint]
      # Bucket notifications are delivered to queues and functions.
      TULE_Storage_QueuesEndpoint: http://queues:9050
      TULE_Storage_FunctionsEndpoint: http://functions:9060
    ports: ["9000:9000"]
    volumes: [objectdata:/data]

  secret-store:
    image: ghcr.io/tulehq/secret-store:0.6.1
    environment:
      <<: [*root-key, *identity-endpoint]
      # Rotation invokes rotation functions there.
      TULE_Store_FunctionsEndpoint: http://functions:9060
    ports: ["9010:9010"]
    volumes: [secretdata:/data]

  mailbox:
    image: ghcr.io/tulehq/mailbox:0.4.1
    environment:
      <<: [*root-key, *identity-endpoint]
    ports: ["9040:9040"]
    volumes: [maildata:/data]

  queues:
    image: ghcr.io/tulehq/queues:0.7.0
    environment:
      <<: [*root-key, *identity-endpoint]
      # Queue URLs name the host clients on this machine reach queues at.
      TULE_Queues_BaseURL: http://localhost:9050
    ports: ["9050:9050"]
    volumes: [queuesdata:/data]

  functions:
    image: ghcr.io/tulehq/functions:0.7.0
    profiles: [functions]
    depends_on:
      queues: {condition: service_healthy}
    environment:
      <<: [*root-key, *identity-endpoint]
      TULE_Functions_QueuesEndpoint: http://queues:9050
      # Function containers join this project's default network, so they
      # reach the Runtime API and the other services by service name, and
      # the Runtime API port stays off the host.
      TULE_Functions_ContainerNetwork: ${COMPOSE_PROJECT_NAME}_default
      TULE_Functions_RuntimeAPIHost: functions
      TULE_Functions_RuntimeAPIBind: 0.0.0.0
    ports: ["9060:9060"]
    volumes:
      - functionsdata:/data
      - /var/run/docker.sock:/var/run/docker.sock
    # The group that owns the socket on the Docker host, from DOCKER_GID as
    # above. Unset, it is 0, the root group.
    group_add: ["${DOCKER_GID:-0}"]
    # On an SELinux host (Fedora, RHEL) the socket's label keeps containers
    # from opening it; this turns labeling off for functions alone. Hosts
    # without SELinux ignore it.
    security_opt: ["label=disable"]

  console:
    image: ghcr.io/tulehq/console:0.3.13
    depends_on:
      identity: {condition: service_healthy}
      accounts: {condition: service_healthy}
      object-store: {condition: service_healthy}
      secret-store: {condition: service_healthy}
      mailbox: {condition: service_healthy}
      queues: {condition: service_healthy}
    environment:
      TULE_Console_IdentityEndpoint: http://identity:9030
      TULE_Console_AccountsEndpoint: http://accounts:9020
      TULE_Console_ObjectStoreEndpoint: http://object-store:9000
      TULE_Console_SecretStoreEndpoint: http://secret-store:9010
      TULE_Console_MailboxEndpoint: http://mailbox:9040
      TULE_Console_QueuesEndpoint: http://queues:9050
      TULE_Console_FunctionsEndpoint: http://functions:9060
    ports: ["9070:9070"]

volumes:
  identitydata:
  accountsdata:
  objectdata:
  secretdata:
  maildata:
  queuesdata:
  functionsdata:
```

## Health checks

Every service answers `GET /_health` (liveness) and `GET /_ready` (readiness)
without a signature, with `200` when ready and `503` otherwise:

```sh
curl -fsS http://localhost:9000/_ready
```

## Next

- [Point your code at the stack](/guides/aws-clients/).
- [Create users, keys, policies and role sessions](/guides/identity/).
