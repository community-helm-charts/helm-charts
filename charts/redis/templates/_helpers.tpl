{{- define "redis.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "redis.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global) -}}
{{- end -}}

{{- define "redis.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "redis.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- include "redis.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "redis.passwordKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- default "redis-password" .Values.auth.existingSecretPasswordKey -}}
{{- else -}}
redis-password
{{- end -}}
{{- end -}}

{{- define "redis.createSecret" -}}
{{- if and .Values.auth.enabled (not .Values.auth.existingSecret) -}}
true
{{- end -}}
{{- end -}}

{{- define "redis.service.port" -}}
{{- .Values.service.ports.redis -}}
{{- end -}}

{{- define "redis.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "redis.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "redis.configmapName" -}}
{{- if .Values.existingConfigmap -}}
{{- tpl .Values.existingConfigmap $ -}}
{{- else -}}
{{- printf "%s-configuration" (include "redis.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "redis.hasConfiguration" -}}
{{- if or .Values.configuration .Values.existingConfigmap -}}
true
{{- end -}}
{{- end -}}

{{- define "redis.probeCommand" -}}
- /bin/sh
- -ec
- |
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    export REDISCLI_AUTH="$REDIS_PASSWORD"
  fi
  response="$(redis-cli -e -h 127.0.0.1 -p {{ .Values.containerPorts.redis }} ping)"
  [ "$response" = "PONG" ]
{{- end -}}

{{- define "redis.validateValues" -}}
{{- $port := printf "%v" .Values.containerPorts.redis -}}
{{- if not (regexMatch "^[0-9]+$" $port) -}}
{{- fail "containerPorts.redis must be an integer from 1 through 65535" -}}
{{- end -}}
{{- if or (lt (int $port) 1) (gt (int $port) 65535) -}}
{{- fail "containerPorts.redis must be an integer from 1 through 65535" -}}
{{- end -}}
{{- end -}}
