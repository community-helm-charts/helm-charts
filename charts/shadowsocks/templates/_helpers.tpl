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
{{- printf "%s-auth" (include "shadowsocks.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shadowsocks.serverPort" -}}
{{- .Values.config.server_port -}}
{{- end -}}

{{- define "shadowsocks.renderConfig" -}}
{{- $config := dict
  "server" .Values.config.server
  "server_port" .Values.config.server_port
  "method" .Values.config.method
  "fast_open" .Values.config.fast_open
  "mode" .Values.config.mode
  "password" "${SHADOWSOCKS_PASSWORD}"
-}}
{{- $config | toPrettyJson -}}
{{- end -}}
