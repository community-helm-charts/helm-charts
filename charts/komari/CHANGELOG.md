## 1.1.2 (2026-07-31)

### 🩹 Fixes

- **komari:** avoid duplicate agent disk statistics ([68eb701](https://github.com/community-helm-charts/helm-charts/commit/68eb701))

### ❤️ Thank You

- Xudong Huang @xudongcc

## 1.1.1 (2026-07-31)

### 🩹 Fixes

- **komari:** collect agent host network traffic ([24497c0](https://github.com/community-helm-charts/helm-charts/commit/24497c0))

### ❤️ Thank You

- Xudong Huang @xudongcc

## 1.1.0 (2026-07-30)

### 🚀 Features

- validate komari agent configuration ([287431e](https://github.com/community-helm-charts/helm-charts/commit/287431e))
- add komari agent daemonset ([7aa268c](https://github.com/community-helm-charts/helm-charts/commit/7aa268c))
- add komari server ingress ([9dd2f2b](https://github.com/community-helm-charts/helm-charts/commit/9dd2f2b))
- add komari server statefulset ([e29a948](https://github.com/community-helm-charts/helm-charts/commit/e29a948))
- scaffold komari chart ([91d1459](https://github.com/community-helm-charts/helm-charts/commit/91d1459))

### 🩹 Fixes

- harden komari template rendering ([b5bcb15](https://github.com/community-helm-charts/helm-charts/commit/b5bcb15))

### ❤️ Thank You

- Xudong Huang @xudongcc

# Changelog

## 1.0.0

- Add the stateful Komari server with persistent `/app/data` storage.
- Add the optional Komari Agent DaemonSet with Secret-backed auto-discovery.
- Persist per-node Agent identity and tolerate all node taints by default.
