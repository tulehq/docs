---
title: cli
description: "tule 0.1.0: the command-line tool that runs a local Tule stack."
---

`tule` is a command-line tool that runs a local Tule stack: the drop-in
replacements for AWS services (object-store for S3, queues for SQS, and the
rest) that Tule publishes as images. It renders a compose file for the
services you pick and runs it with `docker compose`.

## Install

```sh
go install tule.dev/cli/cmd/tule@latest
```

Or download a binary from the
[release page](https://github.com/tulehq/cli/releases). Then `tule version`
prints the version you installed.

`tule` runs a stack with `docker compose`, so it needs the Docker Compose v2
plugin, which Docker Desktop includes and Linux installs as the
`docker-compose-plugin` package.

## Commands

| Command | Does |
|---|---|
| `tule up [service...] [--allow-downgrade] [--docker-gid <gid>] [--skip-port-check]` | Starts the stack and waits until its services are healthy. A new stack runs the services named, or the configured ones, or the default set; on a running stack, the services named are added. Lists the services recreated because their wiring or version changes before acting, and refuses to take a running service down a version without `--allow-downgrade` |
| `tule down [service...] [--volumes] [--skip-port-check]` | With services named, removes them from the stack, and recreates the services wired to them without their endpoints. With none, removes the whole stack. `--volumes` also deletes the data |
| `tule status [--json]` | Shows each service's state, health, version, host address and volume. Exits non-zero when a service is not running and healthy |
| `tule logs [service...] [-f] [--since <time>]` | Prints the logs of the services named, or of the whole stack. `-f` keeps printing; `--since` takes a timestamp or a duration such as `10m` |
| `tule restart [service...]` | Restarts the containers of the services named, or of the whole stack, keeping their data, and waits until they are healthy again |
| `tule reset <service...> [--yes]` | Deletes the data of the services named: removes their containers and volumes and starts them again with empty ones. Asks first |
| `tule services` | Lists the catalog: each service, the AWS service it stands in for, its image and tested version, its default ports |
| `tule compose [service...] [-o file]` | Writes the compose file for the services named, or the configured ones, or the default set: every service but functions |
| `tule env [--shell sh\|fish\|powershell]` | Prints the credentials, region and endpoint variables that point AWS SDKs and the AWS CLI at the running stack, or at the configured services when none runs |
| `tule version` | Prints the version |

Every command takes `--stack <name>` (default `tule`), the compose project
name that namespaces containers, network and volumes, and `--config <file>`,
the configuration to read instead of `tule.yaml`.

### up, down and status

```sh
tule up object-store queues # only these
eval "$(tule env)"
tule status
tule up identity            # adds identity, and rewires the others to it
tule up functions           # adds functions; see "Functions" below
tule down queues            # removes queues, and its endpoint from the others
tule down                   # removes the stack; its data stays in its volumes
tule up                     # on a new stack: the default set, every service but functions
tule down --volumes         # removes the stack and deletes its data
```

`up` runs the same compose file `tule compose` writes, as
`docker compose -p <stack> -f - up -d --wait`. Before it acts, it lists the
version changes, the running services it recreates because their wiring or
host ports change (by variable name; values are not printed), and the
services it starts or removes. It also checks every host port it publishes
is free, and names the service and the `ports:` or `portOffset:` key to
change when one is not. The check listens on this machine, so it cannot see
ports on a remote Docker host; there, pass `--skip-port-check` to `up`, and
to `down` with services named, which checks the ports of the services it
recreates.

Compose does not read a `.env` file in the directory `tule` runs from:
`tule` gives it an empty env file instead, so the stack is the rendered file
and nothing else.

On a running stack, a bare `up` keeps the stack's services and warns when
`services:` in `tule.yaml` names others: add services with
`tule up <service...>`, and remove them with `tule down <service...>`.

`tule down` also removes the function containers functions left on the
stack's network (`dev.tule.functions.instance`), as does
`tule down functions`. Removing the whole stack, it removes functions first,
so no invocation starts a function container while the network is taken
down. `down --volumes` deletes the volumes of the catalog services only, not
other volumes in the compose project.

### logs, restart and reset

```sh
tule logs                  # every service of the stack
tule logs queues -f        # follows queues' logs
tule logs --since 10m      # the last ten minutes
tule restart               # restarts every container, and waits until healthy
tule restart object-store
tule reset queues          # deletes queues' data, after asking
tule reset queues --yes    # without asking
```

`restart` restarts the containers as they are: it does not recreate them, so
a changed `tule.yaml` is not applied (that is `up`), and their data stays.
It then waits up to three minutes for each to be running and, when its image
has a health check, healthy, and fails when one stops or turns unhealthy.
Ctrl-C ends `logs -f` with a zero exit status.

`reset` removes the containers of the services named and their volumes, and
starts them again with empty volumes; the other services keep running and
keep their data. It asks on the terminal first, and without one (in a
script, or with standard input redirected) it refuses unless `--yes` is
given. A service without data, the console, cannot be reset. Resetting
functions also removes its function containers, since the functions they
ran are deleted with its data.

Two stacks run side by side under different `--stack` names, the second with
a `portOffset` in its `tule.yaml`:

```sh
echo 'portOffset: 100' > other/tule.yaml
(cd other && tule --stack other up object-store)  # object-store on 9100
```

### compose

```sh
tule compose                          # the default set, to standard output
tule compose object-store queues -o compose.yaml
docker compose -f compose.yaml up -d
```

Services are wired only to the services selected with them: object-store
gets queues' endpoint only when queues is selected, and every service
accepts the keys identity issues only when identity is selected. The
console needs at least one other service.

`tule compose` writes functions only when it is named, and needs the group
ID that owns the Docker socket on the Docker host with `--docker-gid` (see
[Functions](#functions) for finding it):

```sh
tule compose functions queues --docker-gid "$(stat -c %g /var/run/docker.sock)"
```

The file names its project (`name: <stack>`), and functions attaches its
function containers to the project's network by its Docker name,
`<stack>_default`; run it under another project name, with
`docker compose -p`, and functions refuses to start, since that network does
not exist.

## State from labels

Nothing is kept on disk. The stack's services are the catalog services that
have containers in its compose project, running or stopped, and each
container carries the absolute path of the `tule.yaml` it was started from
as the label `dev.tule.config` (empty for none). So `status`, `logs`,
`restart`, `env`, and `down` of the whole stack, work from any directory.
`up`, `reset`, and `down` with services named, re-render the stack from its
configuration, and refuse when the running stack was started from another
`tule.yaml`, naming both.

Volumes carry no tule labels, so a volume compose created from the console's
[compose file](/getting-started/full-stack/#the-file), under the same project
name, is used as it is.

`up` lists each version change before it recreates a service, and refuses to
take a running service down a version, since a service may not read back
right the data a newer version wrote (object-store documents that a
downgrade serves stale data); `--allow-downgrade` goes ahead. A version that
is not a release version, such as `latest`, counts as a downgrade. The check
compares with the running containers' image tags. `down` with services named
refuses a downgrade of the services it recreates in the same way; apply it
with `tule up --allow-downgrade` first.

## tule.yaml

`tule` reads `tule.yaml` from the working directory or the nearest parent,
or the file `--config` names. Every key is optional:

```yaml
services: [object-store, queues, identity]  # default: every service but functions
ports: {object-store: 9000}       # a service's API host port
portOffset: 0                     # added to every default host port, for a second stack
versions: {object-store: 0.13.1}  # default: the tested version; another one warns
rootKey: {id: AKIAIOSFODNN7EXAMPLE, secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY}
bind: 127.0.0.1                   # the address host ports are published on
publicHost: localhost             # the host clients use: queue URLs and tule env
env: {object-store: {TULE_Server_Domain: localhost}}  # extra variables, set over the wiring
```

- Services named on the command line replace `services`.
- `ports` sets a service's API port; each service publishes that one port.
- `versions` takes release versions: `0.13.1`, or with a prerelease,
  `0.14.0-rc.1`.
- `rootKey` defaults to the AWS documentation's example key above. Its id
  and secret may hold only letters, digits and `+ / = . _ -`. The root key
  is set only here: `env` refuses `TULE_Auth_AccessKeyID` and
  `TULE_Auth_SecretAccessKey`.
- A `bind` other than a loopback address needs a `rootKey` whose id and
  secret are both your own.
- Unknown keys and service names are errors.

## tule env

```sh
# sh, bash, zsh
eval "$(tule env)"
# fish
tule env --shell fish | source
# PowerShell
tule env --shell powershell | Out-String | Invoke-Expression
```

In PowerShell, keep `Out-String`: without it, `Invoke-Expression` gets the
output a line at a time. `tule env` refuses to print a value that holds a
newline or another control character, in every shell.

With the stack running, `tule env` reads it back from its containers: the
services that have containers, the host ports they publish, and the root key
they were started with, so it works from any directory. The endpoint host is
`publicHost` when it runs where the stack's `tule.yaml` is found; elsewhere,
it is `localhost` for a stack published on a loopback address or on every
address, and the address it is published on otherwise. A stopped container
publishes no port, and its service is left out with a warning. With no stack
running, the variables are those of the configured services. Standard error
says which. Either way, `tule env` asks the Docker daemon whether the stack
runs.

It sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and
`AWS_DEFAULT_REGION`, unsets `AWS_SESSION_TOKEN`, and sets an
`AWS_ENDPOINT_URL_<SERVICE>` variable for each configured service:

| Service | Variables |
|---|---|
| identity | `AWS_ENDPOINT_URL_IAM`, `AWS_ENDPOINT_URL_STS` |
| accounts | `AWS_ENDPOINT_URL_ORGANIZATIONS` |
| object-store | `AWS_ENDPOINT_URL_S3` |
| secret-store | `AWS_ENDPOINT_URL_SECRETS_MANAGER` |
| mailbox | `AWS_ENDPOINT_URL_SES`, `AWS_ENDPOINT_URL_SESV2` (mailbox serves SES v2 only; an SES v1 client fails locally rather than reaching AWS) |
| queues | `AWS_ENDPOINT_URL_SQS` |
| functions | `AWS_ENDPOINT_URL_LAMBDA` |

Endpoints use `publicHost`. SDKs address buckets path style at an IP address
and virtual-hosted style (`<bucket>.<host>`) at a host name, so the S3
endpoint uses `127.0.0.1` when `publicHost` is `localhost`, and `publicHost`
itself otherwise. With a `publicHost` that is a host name other than
`localhost`, S3 clients need path-style addressing (`UsePathStyle` in the Go
SDK, `s3.addressing_style = path` in the AWS CLI and boto3 configuration)
unless wildcard DNS resolves `<bucket>.<host>` to the stack.

The SDK for Go 1.x (V1), the SDK for Java 1.x and the SDK for JavaScript 2.x
do not read these variables, per the support table in the AWS SDKs and Tools
Reference Guide's
[Service-specific endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html#ss-endpoints-sdk-compat);
configure their endpoints in code. See also
[AWS SDKs and the CLI](/guides/aws-clients/).

## Functions

[functions](/functions/) is never in the default set: it mounts the Docker
socket, which is root-equivalent on the host. Name it to add it:

```sh
tule up functions
```

It runs each function in a container of its own, through the Docker daemon,
and attaches those containers to the stack's network (`<stack>_default`,
with `TULE_Functions_ContainerNetwork`). There they reach functions' Runtime
API at `functions:9061`, so that port is not published on the host, and the
other services by their names, such as `http://queues:9050`: set those in a
function's `Environment` (for example
`AWS_ENDPOINT_URL_SQS=http://queues:9050`) for its SDK to call the stack.
Only the Lambda API, 9060, is published.

functions reaches the socket through the group that owns it, which `up`
finds on the Docker daemon itself, with a throwaway container from the
functions image (pulled for the stack anyway), without a network:

```sh
docker run --rm --network none --entrypoint stat -v /var/run/docker.sock:/s ghcr.io/tulehq/functions:0.7.0 -c %g /s
```

It runs only once the plan is printed and `up` has checked for downgrades
and busy host ports, so a refused `up` runs no container.

The mount is made by the daemon, so the group is the socket's on the
daemon's host: the Linux host, the VM inside Docker Desktop (whose group is
not the one `stat` reports on a Mac), or a remote host. Once functions runs,
later `up`, `down` and `reset` keep the group its container has.
`--docker-gid` on `up` sets the group instead. functions' README marks the
Docker Desktop setup as untried, and says to run the image as root when the
socket there is owned by root with no group access, which `tule` does not
do.

## Signals

On Ctrl-C, a termination (`SIGTERM`) or a hangup (`SIGHUP`), `tule` passes
the interrupt to compose and gives it a minute to exit before it is killed,
then removes its temporary files. A second signal kills compose at once, and
`tule` with it. On Linux and macOS, compose runs in a process group of its
own, which gets the interrupt whether or not the output is a terminal, and
is woken if the terminal stopped it. On Windows, Ctrl-C in the console
reaches compose directly, but a stop sent to `tule` alone does not: compose
is killed once the minute has passed, or at a second signal, and the compose
plugin docker runs may be left running.

## Limits

- **Windows signal handling is not tested.** See [Signals](#signals) for
  what is expected there.
- **The port check is local.** It listens on this machine, so it cannot see
  ports on a remote Docker host; pass `--skip-port-check` there.
- **A downgrade after a `down` without `--volumes` is not guarded.** The
  downgrade check compares with the running containers' image tags, so
  after a `down` that keeps the volumes, the next `up` does not know which
  version wrote the kept data.

## Release and module

This page follows the cli README at
[v0.1.0](https://github.com/tulehq/cli/blob/v0.1.0/README.md), released on
the [release page](https://github.com/tulehq/cli/releases). Its Go module is
`tule.dev/cli`, with the command at `tule.dev/cli/cmd/tule` and the source
at [github.com/tulehq/cli](https://github.com/tulehq/cli).
