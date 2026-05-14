{{- define "valkey.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "valkey.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global) -}}
{{- end -}}

{{- define "valkey.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "valkey.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- include "valkey.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "valkey.passwordKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- default "valkey-password" .Values.auth.existingSecretPasswordKey -}}
{{- else -}}
valkey-password
{{- end -}}
{{- end -}}

{{- define "valkey.createSecret" -}}
{{- if and .Values.auth.enabled (not .Values.auth.existingSecret) -}}
true
{{- end -}}
{{- end -}}

{{- define "valkey.service.port" -}}
{{- .Values.service.ports.valkey -}}
{{- end -}}

{{- define "valkey.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "valkey.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "valkey.configmapName" -}}
{{- if .Values.existingConfigmap -}}
{{- tpl .Values.existingConfigmap $ -}}
{{- else -}}
{{- printf "%s-configuration" (include "valkey.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "valkey.hasConfiguration" -}}
{{- if or .Values.configuration .Values.existingConfigmap -}}
true
{{- end -}}
{{- end -}}

{{- define "valkey.probeCommand" -}}
- /bin/sh
- -ec
- |
  password=""
  if [ -n "${VALKEY_PASSWORD:-}" ]; then
    password="$VALKEY_PASSWORD"
  fi
  if [ -n "$password" ]; then
    exec valkey-cli -h 127.0.0.1 -p {{ .Values.containerPorts.valkey }} -a "$password" ping
  fi
  exec valkey-cli -h 127.0.0.1 -p {{ .Values.containerPorts.valkey }} ping
{{- end -}}
