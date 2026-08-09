## 1.1.0 (2026-07-17)

### Features

- Run ActivityPub as a Kubernetes-native sidecar in the Ghost StatefulSet.
- Expose ActivityPub through the main Ghost Service.

### Breaking Changes

- Require Kubernetes 1.29 or newer when using this chart version.
- Remove the standalone ActivityPub Deployment and Service.
- Remove `activitypub.podLabels`, `podAnnotations`, `podSecurityContext`, `affinity`, `nodeSelector`, `tolerations`, and `topologySpreadConstraints`; use their `ghost.*` equivalents.
- Remove `activitypub.service.annotations` and `activitypub.service.labels`; use `ghost.service.annotations` and `ghost.service.labels`.

## 1.0.1 (2026-06-04)

### 🚀 Features

- **nx-helm:** package local chart dependencies ([0b0418d](https://github.com/community-helm-charts/helm-charts/commit/0b0418d))

### 🧱 Updated Dependencies

- Updated common to 0.2.1
- Updated mysql to 2.0.1

### ❤️ Thank You

- Xudong Huang @xudongcc

# 1.0.0 (2026-06-04)

### 🚀 Features

- migrate helm charts to nx release ([47cd187](https://github.com/community-helm-charts/helm-charts/commit/47cd187))
- align chart class name values ([acb6a28](https://github.com/community-helm-charts/helm-charts/commit/acb6a28))
- **ghost:** deploy tinybird analytics with forward cli ([4018939](https://github.com/community-helm-charts/helm-charts/commit/4018939))
- **ghost:** add self-hosted activitypub support ([43010d2](https://github.com/community-helm-charts/helm-charts/commit/43010d2))
- migrate ghost chart to mysql subchart ([44eea1b](https://github.com/community-helm-charts/helm-charts/commit/44eea1b))
- refine ghost chart configuration ([93bfce3](https://github.com/community-helm-charts/helm-charts/commit/93bfce3))
- add ghost chart ([a67c9b2](https://github.com/community-helm-charts/helm-charts/commit/a67c9b2))

### 🩹 Fixes

- refresh ghost dependency lock ([4e3077b](https://github.com/community-helm-charts/helm-charts/commit/4e3077b))
- sync chart dependencies ([4863f20](https://github.com/community-helm-charts/helm-charts/commit/4863f20))
- **ghost:** pin ghost image tag ([515ea35](https://github.com/community-helm-charts/helm-charts/commit/515ea35))
- **ghost:** align activitypub ingress name ([844f7b2](https://github.com/community-helm-charts/helm-charts/commit/844f7b2))
- **ghost:** split ingress routes by service ([222e758](https://github.com/community-helm-charts/helm-charts/commit/222e758))
- **ghost:** strip analytics ingress prefix for traefik ([45170fb](https://github.com/community-helm-charts/helm-charts/commit/45170fb))
- align ghost persistence defaults ([bc37377](https://github.com/community-helm-charts/helm-charts/commit/bc37377))
- tune ghost mysql defaults ([76b07e2](https://github.com/community-helm-charts/helm-charts/commit/76b07e2))

### 🧱 Updated Dependencies

- Updated common to 0.2.0
- Updated mysql to 2.0.0

### ❤️ Thank You

- Xudong Huang @xudongcc
