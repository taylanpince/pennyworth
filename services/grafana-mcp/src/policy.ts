import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The OAuth scopes Pennyworth asks Grafana for: reading resources and running queries. Never
 * grafana:write, so Grafana itself refuses every change, whatever the tool list says.
 */
export const SCOPES = ["grafana:read", "grafana:query"];

/**
 * Grafana tools that only read: logs, metrics, traces and profiles through the stack's datasources,
 * dashboards and their queries, alert rules, incidents and annotations. Everything else is hidden and
 * refused: dashboard, alerting and incident writes, gcx, Assistant investigations, SQL datasources
 * (which may allow statements that write), and the Kubernetes and app observability handlers.
 */
export const READ_TOOLS = [
  // Loki
  "query_loki_logs",
  "query_loki_stats",
  "query_loki_patterns",
  "list_loki_label_names",
  "list_loki_label_values",
  "analyze_loki_labels",
  // Prometheus
  "query_prometheus",
  "query_prometheus_histogram",
  "list_prometheus_label_names",
  "list_prometheus_label_values",
  "list_prometheus_metric_metadata",
  "list_prometheus_metric_names",
  // Tempo
  "search_tempo_traces",
  "get_tempo_trace",
  "diff_tempo_traces",
  "list_tempo_attribute_names",
  "list_tempo_attribute_values",
  "query_tempo_metrics",
  "get_tempo_traceql_docs",
  // Pyroscope
  "query_pyroscope",
  "list_pyroscope_label_names",
  "list_pyroscope_label_values",
  "list_pyroscope_profile_types",
  // Other datasources
  "query_cloudwatch",
  "list_cloudwatch_namespaces",
  "list_cloudwatch_metrics",
  "list_cloudwatch_dimensions",
  "list_cloudwatch_dimension_values",
  "query_elasticsearch",
  "query_graphite",
  "query_graphite_density",
  "list_graphite_metrics",
  "list_graphite_tags",
  "query_influxdb",
  "query_quickwit",
  "list_datasources",
  "get_datasource",
  "check_datasources_health",
  "get_query_examples",
  // Dashboards
  "search_dashboards",
  "search_folders",
  "get_dashboard_by_uid",
  "get_dashboard_summary",
  "get_dashboard_property",
  "get_dashboard_panel_queries",
  "list_dashboard_versions",
  "run_panel_query",
  "get_panel_image",
  // Alerts, incidents, annotations
  "alerting_rules_read",
  "alerting_silences_read",
  "list_alert_groups",
  "get_alert_group",
  "list_incidents",
  "get_incident",
  "get_annotations",
  "get_annotation_tags",
  // Grafana's documentation
  "search_docs",
  "get_doc",
];

/** Tools exposed by default. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(creat|add_|update|delete|remove|manage|exec|write|edit|patch|send|post|resolve|acknowledge|silence(?!s_read)|share|upload|import|investigation|assistant|handler|gcx|sql)/i;

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
