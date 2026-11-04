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
  if [ -n "${VALKEY_PASSWORD:-}" ]; then
    export REDISCLI_AUTH="$VALKEY_PASSWORD"
  fi
  response="$(valkey-cli -e -h 127.0.0.1 -p {{ .Values.containerPorts.valkey }} ping)"
  [ "$response" = "PONG" ]
{{- end -}}

{{- define "valkey.validateValues" -}}
{{- $port := printf "%v" .Values.containerPorts.valkey -}}
{{- if not (regexMatch "^[0-9]+$" $port) -}}
{{- fail "containerPorts.valkey must be an integer from 1 through 65535" -}}
{{- end -}}
{{- if or (lt (int $port) 1) (gt (int $port) 65535) -}}
{{- fail "containerPorts.valkey must be an integer from 1 through 65535" -}}
{{- end -}}
{{- end -}}
