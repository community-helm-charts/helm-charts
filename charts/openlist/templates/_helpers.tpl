{{- define "openlist.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "openlist.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "openlist.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "openlist.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openlist.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "openlist.serviceName" -}}
{{- include "openlist.fullname" . -}}
{{- end -}}

{{- define "openlist.service.port" -}}
{{- .Values.service.ports.http -}}
{{- end -}}
