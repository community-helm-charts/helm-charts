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

{{- define "shadowsocks.serverPort" -}}
{{- .Values.config.server_port -}}
{{- end -}}

{{- define "shadowsocks.renderConfig" -}}
{{- $config := deepCopy .Values.config -}}
{{- $_ := set $config "password" "${SHADOWSOCKS_PASSWORD}" -}}
{{- $config | toPrettyJson -}}
{{- end -}}
