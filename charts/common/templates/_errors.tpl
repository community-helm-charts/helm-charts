{{/* vim: set filetype=mustache: */}}
{{/*
Throw error when upgrading using empty passwords values that must not be empty.

Usage:
{{- $validationError00 := include "common.validations.values.single.empty" (dict "valueKey" "path.to.password00" "secret" "secretName" "field" "password-00") -}}
{{- $validationError01 := include "common.validations.values.single.empty" (dict "valueKey" "path.to.password01" "secret" "secretName" "field" "password-01") -}}
{{ include "common.errors.upgrade.passwords.empty" (dict "validationErrors" (list $validationError00 $validationError01) "context" $) }}

Required password params:
  - validationErrors - String - Required. List of validation strings to be return, if it is empty it won't throw error.
  - context - Context - Required. Parent context.
*/}}
{{- define "common.errors.upgrade.passwords.empty" -}}
  {{- $validationErrors := join "" .validationErrors -}}
  {{- if and $validationErrors .context.Release.IsUpgrade -}}
    {{- $errorString := "\nPASSWORDS ERROR: You must provide your current passwords when upgrading the release." -}}
    {{- $errorString = print $errorString "\n                 Note that even after reinstallation, old credentials may be needed as they may be kept in persistent volume claims." -}}
    {{- $errorString = print $errorString "\n%s" -}}
    {{- printf $errorString $validationErrors | fail -}}
  {{- end -}}
{{- end -}}

{{/*
Throw error when chart default container images are replaced.
The error can be bypassed by setting "global.security.allowInsecureImages" to true. In this case,
a warning message will be shown instead.

Usage:
{{ include "common.errors.insecureImages" (dict "images" (list .Values.path.to.the.imageRoot) "context" $) }}
*/}}
{{- define "common.errors.insecureImages" -}}
{{- $changedImages := list -}}
{{- $retaggedImages := list -}}
{{- $globalValues := default (dict) .context.Values.global -}}
{{- $globalRegistry := get $globalValues "imageRegistry" -}}
{{- $securityValues := default (dict) (get $globalValues "security") -}}
{{- $allowImageOverrides := default false (get $securityValues "allowInsecureImages") -}}
{{- $annotations := default (dict) .context.Chart.Annotations -}}
{{- $originalImages := default "" (get $annotations "images") -}}
{{- if $originalImages -}}
{{- range .images -}}
  {{- $tag := .tag | toString -}}
  {{- $registryName := default .registry $globalRegistry -}}
  {{- $fullImageNameNoTag := printf "%s/%s" $registryName .repository -}}
  {{- $fullImageName := printf "%s:%s" $fullImageNameNoTag $tag -}}
  {{- if not (contains $fullImageNameNoTag $originalImages) -}}
    {{- $changedImages = append $changedImages $fullImageName -}}
  {{- else if not (contains (printf "%s:%s" .repository $tag) $originalImages) -}}
    {{- $retaggedImages = append $retaggedImages $fullImageName -}}
  {{- end -}}
{{- end -}}

{{- if gt (len $changedImages) 0 -}}
  {{- $message := "Container images have been overridden from the chart defaults. Verify that each replacement image is compatible with this chart before using it in production." -}}
  {{- $message = print $message "\n\nOverridden images:" -}}
  {{- range $changedImages -}}
    {{- $message = print $message "\n  - " . -}}
  {{- end -}}
  {{- if $allowImageOverrides -}}
    {{- print "\n\nSECURITY WARNING: " $message "\n" -}}
  {{- else -}}
    {{- $message = print "\n\nERROR: " $message -}}
    {{- $message = print $message "\n\nSet global.security.allowInsecureImages=true only after reviewing the replacement images." -}}
    {{- print $message | fail -}}
  {{- end -}}
{{- else if gt (len $retaggedImages) 0 -}}
  {{- $warnString := "\n\nWARNING: Container image tags differ from the chart defaults. Review the tag changes before using them in production." -}}
  {{- $warnString = print $warnString "\n\nRetagged images:" -}}
  {{- range $retaggedImages -}}
    {{- $warnString = print $warnString "\n  - " . -}}
  {{- end -}}
  {{- print $warnString -}}
{{- end -}}
{{- end -}}
{{- end -}}
