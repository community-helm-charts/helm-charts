# Ghost ActivityPub Sidecar Design

## Goal

Run Ghost and its self-hosted ActivityPub service in one Pod so they can safely share the `ReadWriteOnce` content volume without relying on same-node scheduling between separate workloads.

## Architecture

When `activitypub.enabled=true`, the Ghost StatefulSet contains the ActivityPub process as a Kubernetes-native sidecar in `initContainers` with `restartPolicy: Always`. The existing database wait and ActivityPub migration init containers run first. The ActivityPub sidecar then starts with a `/ping` startup probe; Kubernetes starts the Ghost application container only after that probe succeeds.

The dedicated ActivityPub Deployment and Service are removed. The main Ghost Service exposes both the Ghost HTTP port and an `activitypub` port targeting the sidecar. The ActivityPub Ingress keeps its existing public paths but routes them to the `activitypub` port on the main Ghost Service.

## Values And Compatibility

- Set the chart version to `1.1.0`.
- Set `kubeVersion` to `>=1.29.0-0`, where native sidecars are enabled by default.
- Keep `activitypub.enabled`; do not add an `activitypub.mode` compatibility option.
- Keep ActivityPub image, migration, database, environment, probe, resource, and container security values.
- Remove ActivityPub Pod-only values: `podLabels`, `podAnnotations`, `podSecurityContext`, `affinity`, `nodeSelector`, `tolerations`, and `topologySpreadConstraints`.
- Remove dedicated ActivityPub Service annotations and labels. Keep `activitypub.service.ports.http` as the port exposed by the main Ghost Service.
- Merge ActivityPub image pull secrets into the Ghost Pod image pull secrets.

## Lifecycle

The init order is database wait, ActivityPub migration, ActivityPub native sidecar, and user-supplied Ghost init containers. The sidecar startup probe gates Ghost startup. Its readiness and liveness probes contribute to Pod health, and it remains running until the Ghost container terminates.

## Tests

Helm rendering tests must prove that enabling ActivityPub creates no dedicated Deployment or Service, adds the native sidecar and migration init container to the Ghost StatefulSet, exposes the ActivityPub port from the Ghost Service, and routes ActivityPub Ingress paths to that port. Existing behavior with ActivityPub disabled must remain unchanged.
