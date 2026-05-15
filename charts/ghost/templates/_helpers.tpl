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
{{- include "common.images.image" (dict "imageRoot" .Values.mysql.image "global" .Values.global) -}}
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
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.mysql.image) "context" $) -}}
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
{{- required "url is required" .Values.url | trimSuffix "/" -}}
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
  {{- if .Values.mysql.auth.existingSecret -}}
    {{- tpl .Values.mysql.auth.existingSecret $ -}}
  {{- else -}}
    {{- printf "%s-auth" (include "ghost.mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
  {{- end -}}
{{- else if .Values.externalDatabase.existingSecret -}}
{{- tpl .Values.externalDatabase.existingSecret $ -}}
{{- else -}}
{{- printf "%s-externaldb" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.createDatabaseSecret" -}}
{{- if or (and .Values.mysql.enabled (not .Values.mysql.auth.existingSecret)) (and (not .Values.mysql.enabled) (not .Values.externalDatabase.existingSecret)) -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.databaseRootPasswordKey" -}}
{{- if .Values.mysql.auth.existingSecret -}}
{{- default "mysql-root-password" .Values.mysql.auth.existingSecretRootPasswordKey -}}
{{- else -}}
mysql-root-password
{{- end -}}
{{- end -}}

{{- define "ghost.databasePasswordKey" -}}
{{- if .Values.mysql.enabled -}}
{{- if .Values.mysql.auth.existingSecret -}}
{{- default "mysql-password" .Values.mysql.auth.existingSecretPasswordKey -}}
{{- else -}}
mysql-password
{{- end -}}
{{- else -}}
{{- if .Values.externalDatabase.existingSecret -}}
{{- default "mysql-password" .Values.externalDatabase.existingSecretPasswordKey -}}
{{- else -}}
mysql-password
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databaseHost" -}}
{{- if .Values.mysql.enabled -}}
{{- include "ghost.mysql.fullname" . -}}
{{- else -}}
{{- required "externalDatabase.host is required when mysql.enabled=false" .Values.externalDatabase.host -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databasePort" -}}
{{- if .Values.mysql.enabled -}}
{{- .Values.mysql.service.port -}}
{{- else -}}
{{- .Values.externalDatabase.port -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databaseUser" -}}
{{- if .Values.mysql.enabled -}}
{{- default "ghost" .Values.mysql.auth.username -}}
{{- else -}}
{{- default "ghost" .Values.externalDatabase.user -}}
{{- end -}}
{{- end -}}

{{- define "ghost.databaseName" -}}
{{- if .Values.mysql.enabled -}}
{{- default "ghost" .Values.mysql.auth.database -}}
{{- else -}}
{{- default "ghost" .Values.externalDatabase.database -}}
{{- end -}}
{{- end -}}

{{- define "ghost.mysql.hasInitdb" -}}
{{- if .Values.activitypub.enabled -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.mysql.initdbConfigMapName" -}}
{{- printf "%s-initdb" (include "ghost.mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
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

{{- define "ghost.smtp.secretName" -}}
{{- if .Values.smtp.existingSecret -}}
{{- tpl .Values.smtp.existingSecret $ -}}
{{- else -}}
{{- printf "%s-smtp" (include "ghost.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ghost.smtp.createSecret" -}}
{{- if and .Values.smtp.enabled (not .Values.smtp.existingSecret) .Values.smtp.password -}}
true
{{- end -}}
{{- end -}}

{{- define "ghost.smtp.passwordKey" -}}
{{- if .Values.smtp.existingSecret -}}
{{- default "smtp-password" .Values.smtp.existingSecretPasswordKey -}}
{{- else -}}
smtp-password
{{- end -}}
{{- end -}}

{{- define "ghost.activitypubStorageUrl" -}}
{{- printf "%s/content/images/activitypub" (include "ghost.publicUrl" .) -}}
{{- end -}}
