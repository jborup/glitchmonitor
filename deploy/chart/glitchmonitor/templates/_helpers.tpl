{{- /* SPDX-License-Identifier: AGPL-3.0-or-later */ -}}

{{- define "glitchmonitor.selectorLabels" -}}
app.kubernetes.io/name: glitchmonitor
{{- end -}}

{{- define "glitchmonitor.labels" -}}
{{ include "glitchmonitor.selectorLabels" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "glitchmonitor.routeHost" -}}
{{- .Values.route.host | default (printf "glitchmonitor.apps.%s" .Values.clusterDomain) -}}
{{- end -}}

{{- define "glitchmonitor.httprouteHost" -}}
{{- .Values.httproute.host | default (printf "glitchmonitor.gtw.%s" .Values.clusterDomain) -}}
{{- end -}}

{{- /* The app's config.yaml: the enabled ways in become probe targets and CORS origins. */ -}}
{{- define "glitchmonitor.config" -}}
{{- $external := list -}}
{{- $origins := list -}}
{{- if .Values.route.enabled -}}
{{- $url := printf "https://%s" (include "glitchmonitor.routeHost" .) -}}
{{- $external = append $external (dict "name" "route" "url" $url "enabled" true) -}}
{{- $origins = append $origins $url -}}
{{- end -}}
{{- if .Values.httproute.enabled -}}
{{- $url := printf "https://%s" (include "glitchmonitor.httprouteHost" .) -}}
{{- $external = append $external (dict "name" "gateway" "url" $url "enabled" true) -}}
{{- $origins = append $origins $url -}}
{{- end -}}
{{- $origins = concat $origins .Values.extraCorsAllowedOrigins -}}
{{- toYaml (dict "external" $external "corsAllowedOrigins" $origins "browser" .Values.config.browser "internal" .Values.config.internal "server" .Values.config.server) -}}
{{- end -}}
