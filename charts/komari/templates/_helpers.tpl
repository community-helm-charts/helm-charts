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

{{- define "komari.agent.fullname" -}}
{{- printf "%s-agent" (include "komari.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "komari.agent.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.agent.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "komari.agent.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.agent.image) "context" $) -}}
{{- end -}}

{{- define "komari.agent.serviceAccountName" -}}
{{- if .Values.agent.serviceAccount.create -}}
{{- default (include "komari.agent.fullname" .) .Values.agent.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.agent.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "komari.agent.secretName" -}}
{{- if .Values.agent.auth.existingSecret -}}
{{- tpl .Values.agent.auth.existingSecret $ -}}
{{- else -}}
{{- include "komari.agent.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "komari.agent.secretKey" -}}
{{- if .Values.agent.auth.existingSecret -}}
{{- .Values.agent.auth.existingSecretKey -}}
{{- else -}}
{{- "auto-discovery-key" -}}
{{- end -}}
{{- end -}}

{{- define "komari.agent.endpoint" -}}
{{- if .Values.agent.endpoint -}}
{{- tpl .Values.agent.endpoint . -}}
{{- else -}}
{{- printf "http://%s:%v" (include "komari.server.serviceName" .) .Values.server.service.ports.http -}}
{{- end -}}
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
{{- if .Values.agent.enabled -}}
{{- if and (not .Values.agent.auth.existingSecret) (empty .Values.agent.auth.autoDiscoveryKey) -}}
{{- fail "agent.auth.autoDiscoveryKey must not be empty when agent is enabled and agent.auth.existingSecret is empty" -}}
{{- end -}}
{{- if and (empty .Values.agent.endpoint) (not (and .Values.server.enabled .Values.server.service.enabled)) -}}
{{- fail "agent.endpoint must not be empty when agent is enabled without the in-release server Service" -}}
{{- end -}}
{{- end -}}
{{- end -}}
