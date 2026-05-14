{{- define "postgresql.chart.fullname" -}}
{{- default (include "common.names.fullname" .) .Values.global.postgresql.fullnameOverride -}}
{{- end -}}

{{- define "postgresql.fullname" -}}
{{- include "postgresql.chart.fullname" . -}}
{{- end -}}

{{- define "postgresql.headlessServiceName" -}}
{{- printf "%s-hl" (include "postgresql.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "postgresql.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global) -}}
{{- end -}}

{{- define "postgresql.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "postgresql.username" -}}
{{- coalesce .Values.global.postgresql.auth.username .Values.auth.username "postgres" -}}
{{- end -}}

{{- define "postgresql.database" -}}
{{- $database := coalesce .Values.global.postgresql.auth.database .Values.auth.database | default "" -}}
{{- if $database -}}
{{- tpl $database $ -}}
{{- end -}}
{{- end -}}

{{- define "postgresql.secretName" -}}
{{- $secret := coalesce .Values.global.postgresql.auth.existingSecret .Values.auth.existingSecret -}}
{{- if $secret -}}
{{- tpl $secret $ -}}
{{- else -}}
{{- include "postgresql.chart.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "postgresql.passwordKey" -}}
{{- coalesce .Values.global.postgresql.auth.secretKeys.passwordKey .Values.auth.secretKeys.passwordKey "password" -}}
{{- end -}}

{{- define "postgresql.createSecret" -}}
{{- if and (not .Values.auth.trustAuthentication) (not (or .Values.global.postgresql.auth.existingSecret .Values.auth.existingSecret)) -}}
true
{{- end -}}
{{- end -}}

{{- define "postgresql.service.port" -}}
{{- coalesce .Values.global.postgresql.service.ports.postgresql .Values.service.ports.postgresql -}}
{{- end -}}

{{- define "postgresql.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "postgresql.chart.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "postgresql.initdbScriptsConfigMapName" -}}
{{- if .Values.initdb.scriptsConfigMap -}}
{{- tpl .Values.initdb.scriptsConfigMap $ -}}
{{- else -}}
{{- printf "%s-initdb" (include "postgresql.chart.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "postgresql.hasInitdbScripts" -}}
{{- if or .Values.initdb.scripts .Values.initdb.scriptsConfigMap .Values.initdb.scriptsSecret -}}
true
{{- end -}}
{{- end -}}

{{- define "postgresql.probeUser" -}}
{{- default "postgres" (include "postgresql.username" . | trim) -}}
{{- end -}}

{{- define "postgresql.probeCommand" -}}
- /bin/sh
- -ec
- exec pg_isready -U {{ include "postgresql.probeUser" . | quote }} -h 127.0.0.1 -p {{ .Values.containerPorts.postgresql }}
{{- end -}}
