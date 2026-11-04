{{- define "umami.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "umami.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "umami.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "umami.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "umami.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "umami.serviceName" -}}
{{- include "umami.fullname" . -}}
{{- end -}}

{{- define "umami.validatePort" -}}
{{- $value := printf "%v" .value -}}
{{- if not (regexMatch "^[0-9]+$" $value) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- if or (lt (int $value) 1) (gt (int $value) 65535) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- end -}}

{{- define "umami.validateValues" -}}
{{- include "umami.validatePort" (dict "name" "containerPorts.http" "value" .Values.containerPorts.http) -}}
{{- if .Values.service.enabled -}}
{{- include "umami.validatePort" (dict "name" "service.ports.http" "value" .Values.service.ports.http) -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.service.enabled) -}}
{{- fail "service.enabled must be true when ingress.enabled is true" -}}
{{- end -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls (empty .Values.ingress.hostname) -}}
{{- fail "ingress.hostname must not be empty when ingress.tls is true; use ingress.extraTls for additional TLS entries" -}}
{{- end -}}
{{- if .Values.postgresql.enabled -}}
{{- if or .Values.database.url .Values.database.existingSecret -}}
{{- fail "database.url and database.existingSecret require postgresql.enabled=false" -}}
{{- end -}}
{{- $postgresql := .Subcharts.postgresql -}}
{{- if not $postgresql.Values.service.enabled -}}
{{- fail "postgresql.service.enabled must be true for the bundled database" -}}
{{- end -}}
{{- if $postgresql.Values.auth.trustAuthentication -}}
{{- fail "postgresql.auth.trustAuthentication is not supported; configure a database password" -}}
{{- end -}}
{{- if empty (include "postgresql.database" $postgresql) -}}
{{- fail "postgresql.auth.database must not be empty" -}}
{{- end -}}
{{- if ne (include "common.names.namespace" $postgresql) (include "common.names.namespace" .) -}}
{{- fail "postgresql.namespaceOverride must match the Umami namespace so the password Secret can be shared" -}}
{{- end -}}
{{- else -}}
{{- if not (or .Values.database.url .Values.database.existingSecret) -}}
{{- fail "database.url or database.existingSecret is required when postgresql.enabled=false" -}}
{{- end -}}
{{- if and .Values.database.url .Values.database.existingSecret -}}
{{- fail "set only one of database.url and database.existingSecret" -}}
{{- end -}}
{{- if and .Values.database.url (not (regexMatch "^postgres(ql)?://" .Values.database.url)) -}}
{{- fail "database.url must be a PostgreSQL connection URL" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.appSecret.value .Values.appSecret.existingSecret -}}
{{- fail "set only one of appSecret.value and appSecret.existingSecret" -}}
{{- end -}}
{{- if or (empty .Values.appSecret.key) (empty .Values.database.secretKey) -}}
{{- fail "appSecret.key and database.secretKey must not be empty" -}}
{{- end -}}
{{- range .Values.extraEnvVars -}}
{{- if or (has .name (list "PORT" "HOSTNAME" "DATABASE_URL" "APP_SECRET")) (hasPrefix "UMAMI_DB_" .name) -}}
{{- fail (printf "extraEnvVars must not override chart-managed variable %s" .name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "umami.appSecretName" -}}
{{- default (printf "%s-app" (include "umami.fullname" . | trunc 59 | trimSuffix "-")) .Values.appSecret.existingSecret -}}
{{- end -}}

{{- define "umami.databaseSecretName" -}}
{{- default (printf "%s-database" (include "umami.fullname" . | trunc 54 | trimSuffix "-")) .Values.database.existingSecret -}}
{{- end -}}
