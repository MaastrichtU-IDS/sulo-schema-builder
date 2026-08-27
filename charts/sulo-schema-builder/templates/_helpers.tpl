{{/*
Expand the name of the chart.
*/}}
{{- define "sulo-schema-builder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sulo-schema-builder.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "sulo-schema-builder.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "sulo-schema-builder.labels" -}}
helm.sh/chart: {{ include "sulo-schema-builder.chart" . }}
{{ include "sulo-schema-builder.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "sulo-schema-builder.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sulo-schema-builder.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "sulo-schema-builder.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "sulo-schema-builder.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolved image ref, shared by the api Deployment and the migrate Job (which
defaults to the same image/tag unless overridden).
*/}}
{{- define "sulo-schema-builder.image" -}}
{{- $repository := .Values.image.repository -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end }}

{{- define "sulo-schema-builder.migrateImage" -}}
{{- $repository := .Values.migrate.image.repository | default .Values.image.repository -}}
{{- $tag := .Values.migrate.image.tag | default .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end }}

{{/*
DATABASE_URL envFrom secretKeyRef, shared by the api Deployment and the
migrate Job.
*/}}
{{- define "sulo-schema-builder.databaseSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- include "sulo-schema-builder.fullname" . -}}
{{- end -}}
{{- end }}

{{- define "sulo-schema-builder.databaseSecretKey" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecretKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end }}

{{/*
The app-config env vars shared by the api Deployment and the migrate Job
(migrate only actually needs DATABASE_URL, but SCHEMA_STORAGE is harmless and
keeps both pod specs' env blocks generated from one place).
*/}}
{{- define "sulo-schema-builder.commonEnv" -}}
- name: NODE_ENV
  value: "production"
- name: HOST
  value: "0.0.0.0"
- name: SCHEMA_STORAGE
  value: {{ .Values.config.schemaStorage | quote }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "sulo-schema-builder.databaseSecretName" . }}
      key: {{ include "sulo-schema-builder.databaseSecretKey" . }}
{{- end }}
