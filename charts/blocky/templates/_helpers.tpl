{{- define "blocky.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "blocky.serviceName" -}}
{{- include "blocky.fullname" . -}}
{{- end -}}

{{- define "blocky.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: "dns-proxy"
{{- end -}}

{{- define "blocky.podLabels" -}}
{{- $customLabels := include "common.tplvalues.merge" (dict "values" (list .Values.podLabels .Values.commonLabels) "context" .) -}}
{{- $labels := include "common.labels.standard" (dict "customLabels" $customLabels "context" $) | fromYaml -}}
{{- $_ := set $labels "app.kubernetes.io/name" .Chart.Name -}}
{{- $_ := set $labels "app.kubernetes.io/instance" .Release.Name -}}
{{- $_ := set $labels "app.kubernetes.io/component" "dns-proxy" -}}
{{- $labels | toYaml -}}
{{- end -}}

{{- define "blocky.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "blocky.discoveryImage" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.podDnsUpstream.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "blocky.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image .Values.podDnsUpstream.image) "context" $) -}}
{{- end -}}

{{- define "blocky.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "blocky.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "blocky.tlsSecretName" -}}
{{- if .Values.ingress.tlsSecretName -}}
{{- tpl .Values.ingress.tlsSecretName . -}}
{{- else -}}
{{- printf "%s-tls" ((tpl .Values.ingress.hostname .) | replace "*." "" | replace "." "-") | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "blocky.validateValues" -}}
{{- if not (kindIs "map" .Values.blocky) -}}
{{- fail "blocky must be a map" -}}
{{- end -}}
{{- range $field := list "httpPort" "dnsPort" -}}
{{- $message := printf "blocky.%s must be an integer from 1 through 65535" $field -}}
{{- if not (hasKey $.Values.blocky $field) -}}
{{- fail $message -}}
{{- end -}}
{{- $portString := printf "%v" (get $.Values.blocky $field) -}}
{{- if not (regexMatch "^[0-9]+$" $portString) -}}
{{- fail $message -}}
{{- end -}}
{{- $port := int $portString -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail $message -}}
{{- end -}}
{{- end -}}
{{- if eq (int (printf "%v" .Values.blocky.httpPort)) (int (printf "%v" .Values.blocky.dnsPort)) -}}
{{- fail "blocky.httpPort and blocky.dnsPort must be unique" -}}
{{- end -}}
{{- if or (not (kindIs "string" .Values.blocky.dohPath)) (not (regexMatch "^/[^?]*$" .Values.blocky.dohPath)) -}}
{{- fail "blocky.dohPath must be an absolute path without a query string" -}}
{{- end -}}
{{- if not (kindIs "slice" .Values.blocky.upstreams) -}}
{{- fail "blocky.upstreams must be a list" -}}
{{- end -}}
{{- range $upstream := .Values.blocky.upstreams -}}
{{- if or (not (kindIs "string" $upstream)) (empty $upstream) -}}
{{- fail "each blocky.upstreams entry must be a non-empty string" -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "map" .Values.blocky.config) -}}
{{- fail "blocky.config must be a map" -}}
{{- end -}}
{{- range $field := list "ports" "upstreams" -}}
{{- if hasKey $.Values.blocky.config $field -}}
{{- fail (printf "blocky.config.%s is chart-managed and must not be set" $field) -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "map" .Values.podDnsUpstream) -}}
{{- fail "podDnsUpstream must be a map" -}}
{{- end -}}
{{- if not (kindIs "bool" .Values.podDnsUpstream.enabled) -}}
{{- fail "podDnsUpstream.enabled must be a boolean" -}}
{{- end -}}
{{- if and (empty .Values.blocky.upstreams) (not .Values.podDnsUpstream.enabled) -}}
{{- fail "blocky.upstreams must not be empty when podDnsUpstream.enabled is false" -}}
{{- end -}}
{{- $replicas := printf "%v" .Values.replicaCount -}}
{{- if or (not (regexMatch "^[0-9]+$" $replicas)) (lt (int $replicas) 1) -}}
{{- fail "replicaCount must be an integer greater than or equal to 1" -}}
{{- end -}}
{{- $servicePort := printf "%v" .Values.service.port -}}
{{- if or (not (regexMatch "^[0-9]+$" $servicePort)) (lt (int $servicePort) 1) (gt (int $servicePort) 65535) -}}
{{- fail "service.port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- range $probe := list "livenessProbe" "readinessProbe" "startupProbe" "customLivenessProbe" "customReadinessProbe" "customStartupProbe" -}}
{{- if not (kindIs "map" (get $.Values $probe)) -}}
{{- fail (printf "%s must be a map" $probe) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "blocky.renderBaseConfig" -}}
{{- include "blocky.validateValues" . -}}
{{- $config := mustDeepCopy .Values.blocky.config -}}
{{- $_ := set $config "ports" (dict "dns" (int (printf "%v" .Values.blocky.dnsPort)) "http" (int (printf "%v" .Values.blocky.httpPort)) "dohPath" .Values.blocky.dohPath) -}}
{{- $config | toYaml -}}
{{- end -}}

{{- define "blocky.renderUpstreamsConfig" -}}
upstreams:
  groups:
    default:
{{- range .Values.blocky.upstreams }}
      - {{ tpl . $ | quote }}
{{- end -}}
{{- end -}}
