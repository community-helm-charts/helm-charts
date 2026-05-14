{{- define "mysql.fullname" -}}
{{- include "common.names.fullname" . -}}
{{- end -}}

{{- define "mysql.image" -}}
{{- include "common.images.image" (dict "imageRoot" .Values.image "global" .Values.global) -}}
{{- end -}}

{{- define "mysql.imagePullSecrets" -}}
{{- include "common.images.renderPullSecrets" (dict "images" (list .Values.image) "context" $) -}}
{{- end -}}

{{- define "mysql.username" -}}
{{- if .Values.auth.username -}}
{{- tpl .Values.auth.username $ -}}
{{- end -}}
{{- end -}}

{{- define "mysql.database" -}}
{{- if .Values.auth.database -}}
{{- tpl .Values.auth.database $ -}}
{{- end -}}
{{- end -}}

{{- define "mysql.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- tpl .Values.auth.existingSecret $ -}}
{{- else -}}
{{- include "mysql.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "mysql.rootPasswordKey" -}}
{{- default "root-password" .Values.auth.secretKeys.rootPasswordKey -}}
{{- end -}}

{{- define "mysql.passwordKey" -}}
{{- default "password" .Values.auth.secretKeys.passwordKey -}}
{{- end -}}

{{- define "mysql.createSecret" -}}
{{- if not .Values.auth.existingSecret -}}
true
{{- end -}}
{{- end -}}

{{- define "mysql.service.port" -}}
{{- .Values.service.ports.mysql -}}
{{- end -}}

{{- define "mysql.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "mysql.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "mysql.initdbScriptsConfigMapName" -}}
{{- if .Values.initdb.scriptsConfigMap -}}
{{- tpl .Values.initdb.scriptsConfigMap $ -}}
{{- else -}}
{{- printf "%s-initdb" (include "mysql.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "mysql.hasInitdbScripts" -}}
{{- if or .Values.initdb.scripts .Values.initdb.scriptsConfigMap .Values.initdb.scriptsSecret -}}
true
{{- end -}}
{{- end -}}

{{- define "mysql.probeCommand" -}}
- /bin/sh
- -ec
- |
  password=""
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    password="$MYSQL_ROOT_PASSWORD"
  fi
  if [ -n "$password" ]; then
    export MYSQL_PWD="$password"
  fi
  exec mysqladmin ping -h 127.0.0.1 -P {{ .Values.containerPorts.mysql }} -uroot --silent
{{- end -}}
