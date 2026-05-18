{{- define "ghost.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "ghost.componentName" -}}
{{- printf "%s-%s" (include "ghost.fullname" .) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.mysql.image" -}}
{{- $image := default dict .Values.mysql.image -}}
{{- $imageRoot := dict "registry" (default "docker.io" $image.registry) "repository" (default "library/mysql" $image.repository) "tag" (default "8.0.44" $image.tag) "digest" (default "" $image.digest) -}}
{{- include "common.images.image" (dict "imageRoot" $imageRoot "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.analytics.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.analytics.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.activitypub.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.activitypub.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.activitypubMigration.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.activitypub.migration.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.tinybirdDeploy.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.analytics.tinybird.deploy.image "global" .Values.global) -}}
{{- end -}}

{{- define "ghost.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "ghost.mysql.imagePullSecrets" -}}
{{- $image := default dict .Values.mysql.image -}}
{{- $imageRoot := dict "pullSecrets" (default (list) $image.pullSecrets) -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list $imageRoot) "context" $) -}}
{{- end -}}

{{- define "ghost.mysql.imagePullPolicy" -}}
{{- $image := default dict .Values.mysql.image -}}
{{- default "IfNotPresent" $image.pullPolicy -}}
{{- end -}}

{{- define "ghost.analytics.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.analytics.image) "context" $) -}}
{{- end -}}

{{- define "ghost.activitypub.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.activitypub.image .Values.activitypub.migration.image) "context" $) -}}
{{- end -}}

{{- define "ghost.tinybirdDeploy.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image .Values.analytics.tinybird.deploy.image) "context" $) -}}
{{- end -}}

{{- define "ghost.publicUrl" -}}
{{- required "config.url is required" .Values.config.url | trimSuffix "/" -}}
{{- end -}}

{{- define "ghost.serviceName" -}}
{{- include "ghost.fullname" . -}}
{{- end -}}

{{- define "ghost.mysql.fullname" -}}
{{- include "ghost.componentName" (dict "component" "mysql" "Chart" .Chart "Values" .Values "Release" .Release "Capabilities" .Capabilities "Template" .Template) -}}
{{- end -}}

{{- define "ghost.analytics.fullname" -}}
{{- include "ghost.componentName" (dict "component" "traffic-analytics" "Chart" .Chart "Values" .Values "Release" .Release "Capabilities" .Capabilities "Template" .Template) -}}
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
    {{- printf "%s-auth" (include "ghost.mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
  {{- end -}}
{{- else -}}
{{- include "ghost.config.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "ghost.createDatabaseSecret" -}}
{{- $auth := default dict .Values.mysql.auth -}}
{{- if and .Values.mysql.enabled (not $auth.existingSecret) -}}
true
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
{{- $config := default dict .Values.config -}}
{{- $host := dig "database" "connection" "host" "" $config -}}
{{- if $host -}}
{{- $host -}}
{{- else if .Values.mysql.enabled -}}
{{- include "ghost.mysql.fullname" . -}}
{{- else -}}
{{- required "config.database.connection.host is required when mysql.enabled=false" $host -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databasePort" -}}
{{- $config := default dict .Values.config -}}
{{- default 3306 (dig "database" "connection" "port" "" $config) -}}
{{- end -}}

{{- define "ghost.databaseUser" -}}
{{- $config := default dict .Values.config -}}
{{- default "ghost" (dig "database" "connection" "user" "" $config) -}}
{{- end -}}

{{- define "ghost.databaseName" -}}
{{- $config := default dict .Values.config -}}
{{- default "ghost" (dig "database" "connection" "database" "" $config) -}}
{{- end -}}

{{- define "ghost.mysql.hasInitdb" -}}
{{- if .Values.activitypub.enabled -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.mysql.initdbConfigMapName" -}}
{{- printf "%s-initdb" (include "ghost.mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.mysql.persistenceEnabled" -}}
{{- $persistence := default dict .Values.mysql.persistence -}}
{{- if hasKey $persistence "enabled" -}}
{{- $persistence.enabled -}}
{{- else -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.mysql.persistenceExistingClaim" -}}
{{- $persistence := default dict .Values.mysql.persistence -}}
{{- default "" $persistence.existingClaim -}}
{{- end -}}

{{- define "ghost.mysql.persistenceSize" -}}
{{- $persistence := default dict .Values.mysql.persistence -}}
{{- default "8Gi" $persistence.size -}}
{{- end -}}

{{- define "ghost.config.secretName" -}}
{{- printf "%s-config" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ghost.config.databasePassword" -}}
{{- $config := default dict .Values.config -}}
{{- dig "database" "connection" "password" "" $config -}}
{{- end -}}

{{- define "ghost.config.tinybirdAdminToken" -}}
{{- $config := default dict .Values.config -}}
{{- dig "tinybird" "adminToken" "" $config -}}
{{- end -}}

{{- define "ghost.config.tinybirdWorkspaceId" -}}
{{- $config := default dict .Values.config -}}
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

{{- define "ghost.analytics.secretName" -}}
{{- if .Values.analytics.tinybird.existingSecret -}}
{{- tpl .Values.analytics.tinybird.existingSecret $ -}}
{{- else -}}
{{- printf "%s-tinybird" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.analytics.createSecret" -}}
{{- if and .Values.analytics.enabled (not .Values.analytics.tinybird.existingSecret) -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.analytics.trackerTokenKey" -}}
{{- default "tinybird-tracker-token" .Values.analytics.tinybird.secretKeys.trackerTokenKey -}}
{{- end -}}

{{- define "ghost.analytics.adminTokenKey" -}}
{{- default "tinybird-admin-token" .Values.analytics.tinybird.secretKeys.adminTokenKey -}}
{{- end -}}

{{- define "ghost.analytics.workspaceIdKey" -}}
{{- default "tinybird-workspace-id" .Values.analytics.tinybird.secretKeys.workspaceIdKey -}}
{{- end -}}

{{- define "ghost.activitypubStorageUrl" -}}
{{- printf "%s/content/images/activitypub" (include "ghost.publicUrl" .) -}}
{{- end -}}
