{{- define "ghost.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "ghost.componentName" -}}
{{- printf "%s-%s" (include "ghost.fullname" .) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.ghost.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.mysql.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.mysql.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.trafficAnalytics.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.activitypub.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.activitypub.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.activitypubMigration.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.activitypub.migration.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.tinybirdDeploy.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.trafficAnalytics.tinybird.deploy.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.imagePullSecrets" -}}
{{- $images := list .Values.ghost.image .Values.mysql.image -}}
{{- if .Values.activitypub.enabled -}}
{{- $images = append $images .Values.activitypub.image -}}
{{- end -}}
{{- include "common.images.renderPullSecrets" (dict "images" $images "context" $) -}}
{{- end -}}

{{- define "ghost.mysql.imagePullPolicy" -}}
{{- default "IfNotPresent" .Values.mysql.image.pullPolicy -}}
{{- end -}}

{{- define "ghost.mysql.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.mysql.image) "context" $) -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.trafficAnalytics.image) "context" $) -}}
{{- end -}}

{{- define "ghost.activitypub.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.activitypub.image .Values.activitypub.migration.image) "context" $) -}}
{{- end -}}

{{- define "ghost.tinybirdDeploy.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.ghost.image .Values.trafficAnalytics.tinybird.deploy.image) "context" $) -}}
{{- end -}}

{{- define "ghost.publicUrl" -}}
{{- required "ghost.config.url is required" .Values.ghost.config.url | trimSuffix "/" -}}
{{- end -}}

{{- define "ghost.serviceName" -}}
{{- include "ghost.fullname" . -}}
{{- end -}}

{{- define "ghost.mysql.fullname" -}}
{{- include "common.names.dependency.fullname" (dict "chartName" "mysql" "chartValues" .Values.mysql "context" $) -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.fullname" -}}
{{- include "ghost.componentName" (dict "component" "traffic-analytics" "Chart" .Chart "Values" .Values "Release" .Release "Capabilities" .Capabilities "Template" .Template) -}}
{{- end -}}

{{- define "ghost.trafficAnalyticsIngress.fullname" -}}
{{- include "ghost.trafficAnalytics.fullname" . -}}
{{- end -}}

{{- define "ghost.activitypubIngress.fullname" -}}
{{- include "ghost.activitypub.fullname" . -}}
{{- end -}}

{{- define "ghost.trafficAnalyticsStripPrefixMiddlewareName" -}}
{{- printf "%s-strip-prefix" (include "ghost.trafficAnalyticsIngress.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.trafficAnalyticsStripPrefixMiddlewareRef" -}}
{{- printf "%s-%s@kubernetescrd" (include "common.names.namespace" .) (include "ghost.trafficAnalyticsStripPrefixMiddlewareName" .) -}}
{{- end -}}

{{- define "ghost.ingress.controllerMode" -}}
{{- $className := lower (default "" .Values.ingress.className) -}}
{{- if not $className -}}
both
{{- else if contains "traefik" $className -}}
traefik
{{- else if contains "nginx" $className -}}
nginx
{{- else -}}
generic
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.useTraefikAnnotations" -}}
{{- $mode := include "ghost.ingress.controllerMode" . -}}
{{- if or (eq $mode "traefik") (eq $mode "both") -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.useNginxAnnotations" -}}
{{- $mode := include "ghost.ingress.controllerMode" . -}}
{{- if or (eq $mode "nginx") (eq $mode "both") -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.path" -}}
/.ghost/analytics/api/v1/page_hit
{{- end -}}

{{- define "ghost.trafficAnalytics.pathType" -}}
Exact
{{- end -}}

{{- define "ghost.trafficAnalytics.renderTraefikMiddleware" -}}
{{- if and (include "ghost.trafficAnalytics.useTraefikAnnotations" .) (.Capabilities.APIVersions.Has "traefik.io/v1alpha1/Middleware") -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.activitypub.fullname" -}}
{{- include "ghost.componentName" (dict "component" "activitypub" "Chart" .Chart "Values" .Values "Release" .Release "Capabilities" .Capabilities "Template" .Template) -}}
{{- end -}}

{{- define "ghost.contentPvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- tpl .Values.persistence.existingClaim $ -}}
{{- else -}}
{{- printf "%s-content" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databaseSecretName" -}}
{{- if .Values.mysql.enabled -}}
  {{- $auth := default dict .Values.mysql.auth -}}
  {{- if $auth.existingSecret -}}
    {{- tpl $auth.existingSecret $ -}}
  {{- else -}}
    {{- include "ghost.mysql.fullname" . -}}
  {{- end -}}
{{- else -}}
{{- include "ghost.config.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databaseRootPasswordKey" -}}
{{- $auth := default dict .Values.mysql.auth -}}
{{- if $auth.existingSecret -}}
{{- default "mysql-root-password" $auth.existingSecretRootPasswordKey -}}
{{- else -}}
mysql-root-password
{{- end -}}
{{- end -}}

{{- define "ghost.databasePasswordKey" -}}
{{- if .Values.mysql.enabled -}}
{{- $auth := default dict .Values.mysql.auth -}}
{{- if $auth.existingSecret -}}
{{- default "mysql-password" $auth.existingSecretPasswordKey -}}
{{- else -}}
mysql-password
{{- end -}}
{{- else -}}
database__connection__password
{{- end -}}
{{- end -}}

{{- define "ghost.databaseHost" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- $host := dig "database" "connection" "host" "" $config -}}
{{- if $host -}}
{{- $host -}}
{{- else if .Values.mysql.enabled -}}
{{- include "ghost.mysql.fullname" . -}}
{{- else -}}
{{- required "ghost.config.database.connection.host is required when mysql.enabled=false" $host -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databasePort" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- default 3306 (dig "database" "connection" "port" "" $config) -}}
{{- end -}}

{{- define "ghost.databaseUser" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- $auth := default dict .Values.mysql.auth -}}
{{- default (default "ghost" $auth.username) (dig "database" "connection" "user" "" $config) -}}
{{- end -}}

{{- define "ghost.databaseName" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- $auth := default dict .Values.mysql.auth -}}
{{- default (default "ghost" $auth.database) (dig "database" "connection" "database" "" $config) -}}
{{- end -}}

{{- define "ghost.mysql.initdbConfigMapName" -}}
{{- $initdb := default dict .Values.mysql.initdb -}}
{{- if $initdb.scriptsConfigMap -}}
{{- tpl $initdb.scriptsConfigMap $ -}}
{{- else -}}
{{- printf "%s-initdb" (include "ghost.mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.config.secretName" -}}
{{- printf "%s-config" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.config.databasePassword" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- dig "database" "connection" "password" "" $config -}}
{{- end -}}

{{- define "ghost.config.tinybirdAdminToken" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- dig "tinybird" "adminToken" "" $config -}}
{{- end -}}

{{- define "ghost.config.tinybirdWorkspaceId" -}}
{{- $config := default dict .Values.ghost.config -}}
{{- dig "tinybird" "workspaceId" "" $config -}}
{{- end -}}

{{- define "ghost.config.flatten" -}}
{{- $prefix := .prefix -}}
{{- $value := .value -}}
{{- $context := .context -}}
{{- if kindIs "map" $value -}}
{{- range $key, $item := $value }}
{{- $name := $key -}}
{{- if $prefix -}}
{{- $name = printf "%s__%s" $prefix $key -}}
{{- end -}}
{{- include "ghost.config.flatten" (dict "prefix" $name "value" $item "context" $context) -}}
{{- end -}}
{{- else if and (kindIs "string" $value) (eq $value "") -}}
{{- else if not (empty $prefix) -}}
{{- if kindIs "slice" $value -}}
{{- printf "%s: %s\n" $prefix (toJson $value | quote) -}}
{{- else -}}
{{- printf "%s: %s\n" $prefix (include "common.tplvalues.render" (dict "value" (toString $value) "context" $context) | quote) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ghost.mysql.probeCommand" -}}
- /bin/sh
- -ec
- |
  password=""
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    password="$MYSQL_ROOT_PASSWORD"
  fi
  if [ -n "$password" ]; then
    export MYSQL_PWD="$password"
  fi
  exec mysqladmin ping -h 127.0.0.1 -P 3306 -uroot --silent
{{- end -}}

{{- define "ghost.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ghost.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.secretName" -}}
{{- if .Values.trafficAnalytics.tinybird.existingSecret -}}
{{- tpl .Values.trafficAnalytics.tinybird.existingSecret $ -}}
{{- else -}}
{{- printf "%s-tinybird" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.createSecret" -}}
{{- if and .Values.trafficAnalytics.enabled (not .Values.trafficAnalytics.tinybird.existingSecret) -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.trackerTokenKey" -}}
{{- default "tinybird-tracker-token" .Values.trafficAnalytics.tinybird.secretKeys.trackerTokenKey -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.adminTokenKey" -}}
{{- default "tinybird-admin-token" .Values.trafficAnalytics.tinybird.secretKeys.adminTokenKey -}}
{{- end -}}

{{- define "ghost.trafficAnalytics.workspaceIdKey" -}}
{{- default "tinybird-workspace-id" .Values.trafficAnalytics.tinybird.secretKeys.workspaceIdKey -}}
{{- end -}}

{{- define "ghost.activitypubStorageUrl" -}}
{{- printf "%s/content/images/activitypub" (include "ghost.publicUrl" .) -}}
{{- end -}}
