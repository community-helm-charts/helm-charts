# Ghost ActivityPub Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ActivityPub into the Ghost StatefulSet as a native sidecar and route it through the main Ghost Service.

**Architecture:** The ActivityPub migration remains a regular init container. ActivityPub becomes a restartable init container with a startup probe, so it starts before Ghost and shares the Ghost Pod network and content volume. The main Ghost Service exposes both application ports.

**Tech Stack:** Helm templates, Kubernetes StatefulSet native sidecars, Node.js test runner, pnpm/Nx.

## Global Constraints

- Chart version is `1.1.0`.
- Kubernetes version is `>=1.29.0-0`.
- No `activitypub.mode` value is added.
- No dedicated ActivityPub Deployment or Service is rendered.
- Existing ActivityPub Ingress URLs remain unchanged.

---

### Task 1: Add Sidecar Rendering Tests

**Files:**
- Modify: `tests/ghost-chart.test.js`

**Interfaces:**
- Consumes: `makeGhostChart()` and `resourceNames()` test helpers.
- Produces: regression coverage for the new StatefulSet, Service, and Ingress manifests.

- [ ] Add a test rendering `activitypub.enabled=true` and asserting no ActivityPub Deployment or Service is present.
- [ ] Assert the Ghost StatefulSet includes `activitypub-migrate`, a restartable `activitypub` init container, `/ping` startup probe, and the shared content volume.
- [ ] Assert the Ghost Service exposes an `activitypub` port and the ActivityPub Ingress targets it.
- [ ] Run `node --test tests/ghost-chart.test.js` and confirm the new test fails against the old templates.

### Task 2: Implement The Native Sidecar

**Files:**
- Modify: `charts/ghost/templates/statefulset-ghost.yaml`
- Modify: `charts/ghost/templates/service.yaml`
- Modify: `charts/ghost/templates/ingress-activitypub.yaml`
- Modify: `charts/ghost/templates/_helpers.tpl`
- Delete: `charts/ghost/templates/deployment-activitypub.yaml`
- Delete: `charts/ghost/templates/service-activitypub.yaml`

**Interfaces:**
- Consumes: existing `activitypub.*` image, database, probe, resource, and volume values.
- Produces: one Ghost Pod and one Ghost Service containing both HTTP endpoints.

- [ ] Move the ActivityPub migration init container into the Ghost StatefulSet after database readiness.
- [ ] Replace `wait-for-activitypub` with a restartable ActivityPub init container using `startupProbe` on the named `activitypub` port.
- [ ] Preserve ActivityPub environment, probes, resources, security context, and content volume mount.
- [ ] Add an `activitypub` port to the main Ghost Service when enabled.
- [ ] Point ActivityPub Ingress backends at the main Ghost Service `activitypub` port.
- [ ] Remove the standalone ActivityPub workload and service templates.
- [ ] Run `node --test tests/ghost-chart.test.js` and confirm all Ghost tests pass.

### Task 3: Update Values And Documentation

**Files:**
- Modify: `charts/ghost/Chart.yaml`
- Modify: `charts/ghost/values.yaml`
- Modify: `charts/ghost/README.md`
- Modify: `charts/ghost/CHANGELOG.md`

**Interfaces:**
- Consumes: sidecar behavior from Task 2.
- Produces: chart metadata and documented values matching rendered behavior.

- [ ] Set chart version `1.1.0` and `kubeVersion: ">=1.29.0-0"`.
- [ ] Remove ActivityPub Pod-only and dedicated-Service-only values.
- [ ] Document native sidecar lifecycle, shared Service, and Kubernetes requirement.
- [ ] Add the `1.1.0` changelog entry.
- [ ] Run the complete `pnpm test` suite and `helm lint` with chart dependencies available.

### Task 4: Publish And Validate

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: tested chart package from Tasks 1-3.
- Produces: pushed Git branch and a live kudeploy verification.

- [ ] Review `git diff --check`, the full diff, and generated manifests.
- [ ] Commit with a conventional commit message and push `feat/ghost-activitypub-sidecar`.
- [ ] Upgrade the `blog/ghost` release using the local chart and existing Helm values.
- [ ] Verify one Ghost Pod contains Ghost and ActivityPub, the dedicated workload/service are absent, both PVCs remain `1Gi`, MySQL is healthy, and `https://huangxudong.com/` returns success.

