{{- define "frps.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "frps.serviceName" -}}
{{- include "frps.fullname" . -}}
{{- end -}}

{{- define "frps.vhostServiceName" -}}
{{- printf "%s-vhost" (include "frps.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "frps.subdomainHost" -}}
{{- get .Values.config "subDomainHost" -}}
{{- end -}}

{{- define "frps.subdomainWildcard" -}}
{{- printf "*.%s" (include "frps.subdomainHost" .) -}}
{{- end -}}

{{- define "frps.subdomainIngressName" -}}
{{- printf "%s-subdomain" ((include "frps.fullname" .) | trunc 53 | trimSuffix "-") -}}
{{- end -}}

{{- define "frps.subdomainTlsSecretName" -}}
{{- default (printf "%s-subdomain-tls" ((include "frps.fullname" .) | trunc 49 | trimSuffix "-")) .Values.subdomainIngress.secretName -}}
{{- end -}}

{{- define "frps.bindPort" -}}
{{- int (printf "%v" .Values.config.bindPort) -}}
{{- end -}}

{{- define "frps.vhostHTTPPort" -}}
{{- int (printf "%v" .Values.config.vhostHTTPPort) -}}
{{- end -}}

{{- define "frps.vhostHTTPSPort" -}}
{{- int (printf "%v" .Values.config.vhostHTTPSPort) -}}
{{- end -}}

{{- define "frps.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: "frps"
{{- end -}}

{{- define "frps.podLabels" -}}
{{- $customLabels := include "common.tplvalues.merge" (dict "values" (list .Values.podLabels .Values.commonLabels) "context" .) -}}
{{- $labels := include "common.labels.standard" (dict "customLabels" $customLabels "context" $) | fromYaml -}}
{{- $_ := set $labels "app.kubernetes.io/name" .Chart.Name -}}
{{- $_ := set $labels "app.kubernetes.io/instance" .Release.Name -}}
{{- $_ := set $labels "app.kubernetes.io/component" "frps" -}}
{{- $labels | toYaml -}}
{{- end -}}

{{- define "frps.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global "chart" .Chart) -}}
{{- end -}}

{{- define "frps.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "frps.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "frps.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "frps.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- printf "%s-auth" (include "frps.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "frps.secretKey" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecretKey -}}
{{- else -}}token{{- end -}}
{{- end -}}

{{- define "frps.validateValues" -}}
{{- if not (kindIs "map" .Values.auth) -}}
{{- fail "auth must be a map" -}}
{{- end -}}
{{- range $field := list "token" "existingSecret" "existingSecretKey" -}}
{{- if and (hasKey $.Values.auth $field) (not (kindIs "string" (get $.Values.auth $field))) -}}
{{- fail (printf "auth.%s must be a string" $field) -}}
{{- end -}}
{{- end -}}
{{- if .Values.auth.existingSecret -}}
{{- if empty .Values.auth.existingSecretKey -}}
{{- fail "auth.existingSecretKey must not be empty when auth.existingSecret is set" -}}
{{- end -}}
{{- else if empty .Values.auth.token -}}
{{- fail "auth.token must not be empty when auth.existingSecret is empty" -}}
{{- end -}}
{{- if not (kindIs "map" .Values.config) -}}
{{- fail "config must be a map" -}}
{{- end -}}
{{- if not (kindIs "map" .Values.subdomainIngress) -}}
{{- fail "subdomainIngress must be a map" -}}
{{- end -}}
{{- range $field := list "enabled" "tls" -}}
{{- if not (kindIs "bool" (get $.Values.subdomainIngress $field)) -}}
{{- fail (printf "subdomainIngress.%s must be a boolean" $field) -}}
{{- end -}}
{{- end -}}
{{- range $field := list "apiVersion" "ingressClassName" "pathType" "secretName" -}}
{{- if not (kindIs "string" (get $.Values.subdomainIngress $field)) -}}
{{- fail (printf "subdomainIngress.%s must be a string" $field) -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "map" .Values.subdomainIngress.annotations) -}}
{{- fail "subdomainIngress.annotations must be a map" -}}
{{- end -}}
{{- if .Values.subdomainIngress.enabled -}}
{{- $domainMessage := "config.subDomainHost must be a lower-case DNS name with at least two labels" -}}
{{- if not (hasKey .Values.config "subDomainHost") -}}
{{- fail $domainMessage -}}
{{- end -}}
{{- $subDomainHost := get .Values.config "subDomainHost" -}}
{{- if not (kindIs "string" $subDomainHost) -}}
{{- fail $domainMessage -}}
{{- end -}}
{{- if or (gt (len $subDomainHost) 251) (not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$" $subDomainHost)) -}}
{{- fail $domainMessage -}}
{{- end -}}
{{- end -}}
{{- $ports := dict -}}
{{- range $field := list "bindPort" "vhostHTTPPort" "vhostHTTPSPort" -}}
{{- $message := printf "config.%s must be an integer from 1 through 65535" $field -}}
{{- if not (hasKey $.Values.config $field) -}}
{{- fail $message -}}
{{- end -}}
{{- $portString := printf "%v" (get $.Values.config $field) -}}
{{- if not (regexMatch "^[0-9]+$" $portString) -}}
{{- fail $message -}}
{{- end -}}
{{- $port := int $portString -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail $message -}}
{{- end -}}
{{- $portKey := printf "%d" $port -}}
{{- if hasKey $ports $portKey -}}
{{- fail "config.bindPort, config.vhostHTTPPort, and config.vhostHTTPSPort must be unique" -}}
{{- end -}}
{{- $_ := set $ports $portKey true -}}
{{- end -}}
{{- if hasKey .Values.config "auth" -}}
{{- $auth := get .Values.config "auth" -}}
{{- if not (kindIs "map" $auth) -}}
{{- fail "config.auth must be a map" -}}
{{- end -}}
{{- if hasKey $auth "token" -}}
{{- fail "config.auth.token is managed by the chart and must not be set" -}}
{{- end -}}
{{- if hasKey $auth "tokenSource" -}}
{{- fail "config.auth.tokenSource is managed by the chart and must not be set" -}}
{{- end -}}
{{- if and (hasKey $auth "method") (ne (printf "%v" (get $auth "method")) "token") -}}
{{- fail "config.auth.method must be token when set" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "frps.renderConfig" -}}
{{- include "frps.validateValues" . -}}
{{- $config := mustDeepCopy .Values.config -}}
{{- range $field := list "bindPort" "vhostHTTPPort" "vhostHTTPSPort" -}}
{{- $_ := set $config $field (int (printf "%v" (get $config $field))) -}}
{{- end -}}
{{- if and (hasKey $config "subDomainHost") (empty (get $config "subDomainHost")) -}}
{{- $_ := unset $config "subDomainHost" -}}
{{- end -}}
{{- $auth := default (dict) (get $config "auth") -}}
{{- $_ := set $auth "method" "token" -}}
{{- $_ := set $auth "tokenSource" (dict "type" "file" "file" (dict "path" "/etc/frp/token")) -}}
{{- $_ := set $config "auth" $auth -}}
{{- $config | toToml -}}
{{- end -}}
