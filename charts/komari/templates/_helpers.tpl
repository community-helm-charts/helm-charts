{{- define "komari.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "komari.server.fullname" -}}
{{- printf "%s-server" (include "komari.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "komari.server.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.server.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "komari.server.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.server.image) "context" $) -}}
{{- end -}}

{{- define "komari.server.serviceAccountName" -}}
{{- if .Values.server.serviceAccount.create -}}
{{- default (include "komari.server.fullname" .) .Values.server.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.server.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "komari.server.serviceName" -}}
{{- include "komari.server.fullname" . -}}
{{- end -}}

{{- define "komari.validatePort" -}}
{{- $name := .name -}}
{{- $value := printf "%v" .value -}}
{{- if not (regexMatch "^[0-9]+$" $value) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" $name) -}}
{{- end -}}
{{- $port := int $value -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" $name) -}}
{{- end -}}
{{- end -}}

{{- define "komari.validateValues" -}}
{{- include "komari.validatePort" (dict "name" "server.containerPorts.http" "value" .Values.server.containerPorts.http) -}}
{{- include "komari.validatePort" (dict "name" "server.service.ports.http" "value" .Values.server.service.ports.http) -}}
{{- end -}}
