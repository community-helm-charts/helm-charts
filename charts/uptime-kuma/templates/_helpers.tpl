{{- define "uptime-kuma.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "uptime-kuma.headlessServiceName" -}}
{{- printf "%s-headless" ((include "uptime-kuma.fullname" .) | trunc 54 | trimSuffix "-") -}}
{{- end -}}

{{- define "uptime-kuma.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "uptime-kuma.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "uptime-kuma.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "uptime-kuma.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "uptime-kuma.serviceName" -}}
{{- include "uptime-kuma.fullname" . -}}
{{- end -}}

{{- define "uptime-kuma.validatePort" -}}
{{- $value := printf "%v" .value -}}
{{- if not (regexMatch "^[0-9]+$" $value) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- if or (lt (int $value) 1) (gt (int $value) 65535) -}}
{{- fail (printf "%s must be an integer from 1 through 65535" .name) -}}
{{- end -}}
{{- end -}}

{{- define "uptime-kuma.validateValues" -}}
{{- include "uptime-kuma.validatePort" (dict "name" "containerPorts.http" "value" .Values.containerPorts.http) -}}
{{- if .Values.service.enabled -}}
{{- include "uptime-kuma.validatePort" (dict "name" "service.ports.http" "value" .Values.service.ports.http) -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.service.enabled) -}}
{{- fail "service.enabled must be true when ingress.enabled is true" -}}
{{- end -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls (empty .Values.ingress.hostname) -}}
{{- fail "ingress.hostname must not be empty when ingress.tls is true; use ingress.extraTls for additional TLS entries" -}}
{{- end -}}
{{- if not (hasPrefix "/" .Values.persistence.mountPath) -}}
{{- fail "persistence.mountPath must be an absolute path" -}}
{{- end -}}
{{- range .Values.extraEnvVars -}}
{{- if has .name (list "UPTIME_KUMA_PORT" "DATA_DIR") -}}
{{- fail (printf "extraEnvVars must not override %s; use containerPorts.http or persistence.mountPath" .name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
