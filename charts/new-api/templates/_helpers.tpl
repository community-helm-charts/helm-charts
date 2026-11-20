{{- define "new-api.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "new-api.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "new-api.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "new-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "new-api.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "new-api.serviceName" -}}
{{- include "new-api.fullname" . -}}
{{- end -}}

{{- define "new-api.master.fullname" -}}
{{- printf "%s-master" (include "new-api.fullname" . | trunc 56 | trimSuffix "-") -}}
{{- end -}}

{{- define "new-api.slave.fullname" -}}
{{- printf "%s-slave" (include "new-api.fullname" . | trunc 57 | trimSuffix "-") -}}
{{- end -}}

{{- define "new-api.headlessServiceName" -}}
{{- $suffix := printf "-%s-headless" .role -}}
{{- printf "%s%s" (include "new-api.fullname" .context | trunc (int (sub 63 (len $suffix))) | trimSuffix "-") $suffix -}}
{{- end -}}

{{/* Slave-only variables override shared variables with the same name. */}}
{{- define "new-api.extraEnvVars" -}}
{{- $vars := .context.Values.extraEnvVars -}}
{{- if eq .role "slave" -}}
{{- $slaveNames := list -}}
{{- range .context.Values.slave.extraEnvVars -}}
{{- $slaveNames = append $slaveNames .name -}}
{{- end -}}
{{- $vars = list -}}
{{- range .context.Values.extraEnvVars -}}
{{- if not (has .name $slaveNames) -}}
{{- $vars = append $vars . -}}
{{- end -}}
{{- end -}}
{{- $vars = concat $vars .context.Values.slave.extraEnvVars -}}
{{- end -}}
{{- include "common.tplvalues.render" (dict "value" $vars "context" .context) -}}
{{- end -}}

{{- define "new-api.config.secretName" -}}
{{- default (include "new-api.fullname" .) .Values.config.existingSecret -}}
{{- end -}}

{{- define "new-api.postgresql.secretName" -}}
{{- if .Values.postgresql.enabled -}}
{{- include "postgresql.secretName" .Subcharts.postgresql -}}
{{- else -}}
{{- default (printf "%s-external-postgresql" (include "new-api.fullname" . | trunc 43 | trimSuffix "-")) .Values.externalPostgresql.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* Bundled service keys contain raw passwords; external service keys contain full URLs. */}}
{{- define "new-api.postgresql.secretKey" -}}
{{- if .Values.postgresql.enabled -}}
{{- include "postgresql.passwordKey" .Subcharts.postgresql -}}
{{- else -}}
{{- .Values.externalPostgresql.secretKey -}}
{{- end -}}
{{- end -}}

{{- define "new-api.valkey.secretName" -}}
{{- if .Values.valkey.enabled -}}
{{- include "valkey.secretName" .Subcharts.valkey -}}
{{- else -}}
{{- default (printf "%s-external-valkey" (include "new-api.fullname" . | trunc 47 | trimSuffix "-")) .Values.externalValkey.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "new-api.valkey.secretKey" -}}
{{- if .Values.valkey.enabled -}}
{{- include "valkey.passwordKey" .Subcharts.valkey -}}
{{- else -}}
{{- .Values.externalValkey.secretKey -}}
{{- end -}}
{{- end -}}

{{- define "new-api.validatePort" -}}
{{- $value := printf "%v" .value -}}
{{- if not (regexMatch "^[0-9]+$" $value) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- if or (lt (int $value) 1) (gt (int $value) 65535) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- end -}}

{{- define "new-api.validateValues" -}}
{{- if not (has .Values.podManagementPolicy (list "OrderedReady" "Parallel")) -}}
{{- fail "podManagementPolicy must be OrderedReady or Parallel" -}}
{{- end -}}
{{- range $name, $value := dict "syncFrequency" .Values.config.syncFrequency "batchUpdateInterval" .Values.config.batchUpdateInterval -}}
{{- $number := printf "%v" $value -}}
{{- if not (regexMatch "^[0-9]+$" $number) -}}
{{- fail (printf "config.%s must be a positive integer" $name) -}}
{{- end -}}
{{- if lt (int $number) 1 -}}
{{- fail (printf "config.%s must be a positive integer" $name) -}}
{{- end -}}
{{- end -}}
{{- range $name, $value := dict "batchUpdateEnabled" .Values.config.batchUpdateEnabled "errorLogEnabled" .Values.config.errorLogEnabled "memoryCacheEnabled" .Values.config.memoryCacheEnabled -}}
{{- if not (kindIs "bool" $value) -}}
{{- fail (printf "config.%s must be a boolean" $name) -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "string" .Values.config.timezone) -}}
{{- fail "config.timezone must be a non-empty string" -}}
{{- end -}}
{{- if empty (trim .Values.config.timezone) -}}
{{- fail "config.timezone must be a non-empty string" -}}
{{- end -}}
{{- if .Values.slave.enabled -}}
{{- if not (regexMatch "^[0-9]+$" (printf "%v" .Values.slave.replicaCount)) -}}
{{- fail "slave.replicaCount must be a non-negative integer" -}}
{{- end -}}
{{- end -}}
{{- range $role := list "master" "slave" -}}
{{- $strategy := deepCopy $.Values.updateStrategy -}}
{{- if eq $role "slave" -}}
{{- $strategy = mergeOverwrite $strategy $.Values.slave.updateStrategy -}}
{{- end -}}
{{- if not (has $strategy.type (list "RollingUpdate" "OnDelete")) -}}
{{- fail (printf "%s updateStrategy.type must be RollingUpdate or OnDelete" $role) -}}
{{- end -}}
{{- if and (eq $strategy.type "OnDelete") $strategy.rollingUpdate -}}
{{- fail (printf "%s updateStrategy.rollingUpdate requires type=RollingUpdate" $role) -}}
{{- end -}}
{{- end -}}
{{- include "new-api.validatePort" (dict "name" "containerPorts.http" "value" .Values.containerPorts.http) -}}
{{- if .Values.service.enabled -}}
{{- include "new-api.validatePort" (dict "name" "service.ports.http" "value" .Values.service.ports.http) -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.service.enabled) -}}
{{- fail "service.enabled must be true when ingress.enabled is true" -}}
{{- end -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls (empty .Values.ingress.hostname) -}}
{{- fail "ingress.hostname must not be empty when ingress.tls is true" -}}
{{- end -}}
{{- if and .Values.config.existingSecret (or .Values.config.sessionSecret .Values.config.cryptoSecret) -}}
{{- fail "config.existingSecret cannot be combined with config.sessionSecret or config.cryptoSecret" -}}
{{- end -}}
{{- if or (empty .Values.config.sessionSecretKey) (empty .Values.config.cryptoSecretKey) (eq .Values.config.sessionSecretKey .Values.config.cryptoSecretKey) -}}
{{- fail "config.sessionSecretKey and config.cryptoSecretKey must be non-empty and different" -}}
{{- end -}}
{{- if eq .Values.config.sessionSecret "random_string" -}}
{{- fail "config.sessionSecret must not be the upstream placeholder random_string" -}}
{{- end -}}
{{- range $name, $config := dict "postgresql" .Values.externalPostgresql "valkey" .Values.externalValkey -}}
{{- $externalName := ternary "externalPostgresql" "externalValkey" (eq $name "postgresql") -}}
{{- if (index $.Values $name).enabled -}}
{{- if or $config.url $config.existingSecret -}}
{{- fail (printf "%s.url and %s.existingSecret require %s.enabled=false" $externalName $externalName $name) -}}
{{- end -}}
{{- $subchart := index $.Subcharts $name -}}
{{- if not $subchart.Values.service.enabled -}}
{{- fail (printf "%s.service.enabled must be true for the bundled service" $name) -}}
{{- end -}}
{{- if ne (include "common.names.namespace" $subchart) (include "common.names.namespace" $) -}}
{{- fail (printf "%s.namespaceOverride must match the New API namespace so password Secrets can be shared" $name) -}}
{{- end -}}
{{- else -}}
{{- if not (or $config.url $config.existingSecret) -}}
{{- fail (printf "%s.url or %s.existingSecret is required when %s.enabled=false" $externalName $externalName $name) -}}
{{- end -}}
{{- if and $config.url $config.existingSecret -}}
{{- fail (printf "set only one of %s.url and %s.existingSecret" $externalName $externalName) -}}
{{- end -}}
{{- if and (eq $name "postgresql") $config.url (not (regexMatch "^postgres(ql)?://" $config.url)) -}}
{{- fail "externalPostgresql.url must be a PostgreSQL connection URL" -}}
{{- end -}}
{{- if and (eq $name "valkey") $config.url (not (regexMatch "^rediss?://" $config.url)) -}}
{{- fail "externalValkey.url must be a redis:// or rediss:// connection URL" -}}
{{- end -}}
{{- end -}}
{{- if empty $config.secretKey -}}
{{- fail (printf "%s.secretKey must not be empty" $externalName) -}}
{{- end -}}
{{- end -}}
{{- if .Values.postgresql.enabled -}}
{{- if .Subcharts.postgresql.Values.auth.trustAuthentication -}}
{{- fail "postgresql.auth.trustAuthentication is not supported; configure a database password" -}}
{{- end -}}
{{- if empty (include "postgresql.database" .Subcharts.postgresql) -}}
{{- fail "postgresql.auth.database must not be empty" -}}
{{- end -}}
{{- end -}}
{{- range (concat .Values.extraEnvVars .Values.slave.extraEnvVars) -}}
{{- if or (has .name (list "SQL_DSN" "REDIS_CONN_STRING" "SESSION_SECRET" "CRYPTO_SECRET" "NODE_NAME" "NODE_TYPE" "SYNC_FREQUENCY" "BATCH_UPDATE_ENABLED" "BATCH_UPDATE_INTERVAL" "ERROR_LOG_ENABLED" "MEMORY_CACHE_ENABLED" "TZ" "FRONTEND_BASE_URL")) (hasPrefix "NEW_API_" .name) -}}
{{- fail (printf "extraEnvVars and slave.extraEnvVars must not override chart-managed variable %s" .name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Percent-encode raw credentials using tools provided by the Debian image. */}}
{{- define "new-api.startupScript" -}}
{{- if or .Values.postgresql.enabled .Values.valkey.enabled }}
urlencode() {
  printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n' | sed 's/../%&/g'
}
{{- end }}
{{- if .Values.postgresql.enabled }}
SQL_DSN="postgresql://$(urlencode "$NEW_API_DB_USER"):$(urlencode "$NEW_API_DB_PASSWORD")@${NEW_API_DB_HOST}:${NEW_API_DB_PORT}/$(urlencode "$NEW_API_DB_NAME")?sslmode=disable"
export SQL_DSN
{{- end }}
{{- if .Values.valkey.enabled }}
{{- if .Subcharts.valkey.Values.auth.enabled }}
REDIS_CONN_STRING="redis://:$(urlencode "$NEW_API_VALKEY_PASSWORD")@${NEW_API_VALKEY_HOST}:${NEW_API_VALKEY_PORT}/0"
{{- else }}
REDIS_CONN_STRING="redis://${NEW_API_VALKEY_HOST}:${NEW_API_VALKEY_PORT}/0"
{{- end }}
export REDIS_CONN_STRING
{{- end }}
exec "$@"
{{- end -}}
