{{- define "openviking.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "openviking.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "openviking.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "openviking.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openviking.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "openviking.serviceName" -}}
{{- include "openviking.fullname" . -}}
{{- end -}}

{{- define "openviking.service.port" -}}
{{- .Values.service.ports.http -}}
{{- end -}}

{{- define "openviking.configSecretName" -}}
{{- if .Values.config.existingSecret -}}
{{- tpl .Values.config.existingSecret $ -}}
{{- else -}}
{{- printf "%s-config" (include "openviking.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "openviking.configSecretKey" -}}
{{- default "ov.conf" .Values.config.existingSecretKey -}}
{{- end -}}

{{- define "openviking.createConfigSecret" -}}
{{- if not .Values.config.existingSecret -}}
true
{{- end -}}
{{- end -}}

{{- define "openviking.renderConfig" -}}
{{- $config := omit .Values.config "existingSecret" "existingSecretKey" -}}
{{- include "common.tplvalues.render" (dict "value" $config "context" $) | fromYaml | toPrettyJson -}}
{{- end -}}
