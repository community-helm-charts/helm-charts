{{- define "redis.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "redis.headlessServiceName" -}}
{{- printf "%s-hl" (include "redis.fullname" .) | trunc 63 | trimSuffix "-" -}}
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
{{- default "password" .Values.auth.secretKeys.passwordKey -}}
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
  password=""
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    password="$REDIS_PASSWORD"
  fi
  if [ -n "$password" ]; then
    exec redis-cli -h 127.0.0.1 -p {{ .Values.containerPorts.redis }} -a "$password" ping
  fi
  exec redis-cli -h 127.0.0.1 -p {{ .Values.containerPorts.redis }} ping
{{- end -}}
