{{- define "shadowsocks.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "shadowsocks.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "shadowsocks.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "shadowsocks.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "shadowsocks.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "shadowsocks.configMapName" -}}
{{- printf "%s-config" (include "shadowsocks.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shadowsocks.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- printf "%s-auth" (include "shadowsocks.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "shadowsocks.secretPasswordKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecretPasswordKey -}}
{{- else -}}
{{- "password" -}}
{{- end -}}
{{- end -}}

{{- define "shadowsocks.serverPort" -}}
{{- .Values.config.server_port -}}
{{- end -}}

{{- define "shadowsocks.validateValues" -}}
{{- if hasKey .Values.config "password" -}}
{{- fail "config.password is reserved; configure auth.password or auth.existingSecret" -}}
{{- end -}}
{{- if not (hasKey .Values.config "server_port") -}}
{{- fail "config.server_port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- $portString := printf "%v" .Values.config.server_port -}}
{{- if not (regexMatch "^[0-9]+$" $portString) -}}
{{- fail "config.server_port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- $port := int $portString -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail "config.server_port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- if .Values.auth.existingSecret -}}
{{- if empty .Values.auth.existingSecretPasswordKey -}}
{{- fail "auth.existingSecretPasswordKey must not be empty when auth.existingSecret is set" -}}
{{- end -}}
{{- else if empty .Values.auth.password -}}
{{- fail "auth.password must not be empty when auth.existingSecret is empty" -}}
{{- end -}}
{{- end -}}

{{- define "shadowsocks.renderConfig" -}}
{{- include "shadowsocks.validateValues" . -}}
{{- $config := deepCopy .Values.config -}}
{{- $_ := set $config "password" "${SHADOWSOCKS_PASSWORD}" -}}
{{- $config | toPrettyJson -}}
{{- end -}}
