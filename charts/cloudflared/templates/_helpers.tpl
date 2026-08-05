{{- define "cloudflared.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "cloudflared.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "cloudflared.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "cloudflared.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cloudflared.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "cloudflared.secretName" -}}
{{- include "cloudflared.fullname" . -}}
{{- end -}}

{{- define "cloudflared.secretKey" -}}
token
{{- end -}}

{{- define "cloudflared.args" -}}
- tunnel
- --no-autoupdate
- --loglevel
- {{ .Values.tunnel.logLevel }}
- --metrics
- 0.0.0.0:{{ .Values.metrics.port }}
{{- range .Values.tunnel.extraArgs }}
- {{ tpl . $ | quote }}
{{- end }}
- run
{{- end -}}
