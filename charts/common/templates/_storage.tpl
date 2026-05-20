{{/* vim: set filetype=mustache: */}}

{{/*
Return the proper storageClassName
{{ include "common.storage.className" ( dict "persistence" .Values.path.to.the.persistence "global" $) }}
*/}}
{{- define "common.storage.className" -}}
{{- $storageClassName := (.global).storageClassName | default .persistence.storageClassName | default (.global).defaultStorageClassName | default "" -}}
{{- if $storageClassName -}}
  {{- if (eq "-" $storageClassName) -}}
      {{- printf "storageClassName: \"\"" -}}
  {{- else -}}
      {{- printf "storageClassName: %s" $storageClassName -}}
  {{- end -}}
{{- end -}}
{{- end -}}
