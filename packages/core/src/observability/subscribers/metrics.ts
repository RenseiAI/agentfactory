/**
 * Metrics subscriber — Prometheus-style counter/histogram/gauge emission.
 *
 * Architecture reference: donmai-architecture/002-provider-base-contract.md §Lifecycle hooks
 *
 * Design:
 * - Backend is pluggable: implement MetricsBackend and pass it in.
 * - Ships a no-op default backend (NoopMetricsBackend) — zero overhead when metrics not configured.
 * - Ships a PrometheusTextBackend that maintains in-process state and exposes a
 *   /metrics-compatible text payload via getPrometheusText().
 * - Subscriber is opt-in: call registerMetricsSubscriber(bus, backend) to attach.
 */

import type { ProviderHookEvent } from '../../providers/base.js'
import type { HookBus, SubscriberFilter } from '../hooks.js'

// ---------------------------------------------------------------------------
// MetricsBackend interface
// ---------------------------------------------------------------------------

export interface MetricLabels {
  [key: string]: string
}

/** A pluggable metrics backend. Implement this to ship metrics to any system. */
export interface MetricsBackend {
  /** Increment a counter by the given amount (default 1). */
  counter(name: string, labels: MetricLabels, value?: number): void
  /** Observe a value into a histogram (e.g., duration in ms). */
  histogram(name: string, labels: MetricLabels, value: number): void
  /** Set a gauge to an absolute value. */
  gauge(name: string, labels: MetricLabels, value: number): void
}

// ---------------------------------------------------------------------------
// No-op backend (default)
// ---------------------------------------------------------------------------

/** No-op backend: all metric calls are silently discarded. Zero overhead. */
export class NoopMetricsBackend implements MetricsBackend {
  counter(_name: string, _labels: MetricLabels, _value?: number): void {}
  histogram(_name: string, _labels: MetricLabels, _value: number): void {}
  gauge(_name: string, _labels: MetricLabels, _value: number): void {}
}

// ---------------------------------------------------------------------------
// Prometheus text-format backend
// ---------------------------------------------------------------------------

interface CounterState {
  kind: 'counter'
  value: number
}

interface HistogramState {
  kind: 'histogram'
  /** Sum of all observed values */
  sum: number
  /** Count of observations */
  count: number
  /** Configured buckets (upper bounds), including +Inf */
  buckets: number[]
  /** Bucket counts (parallel to buckets) */
  bucketCounts: number[]
}

interface GaugeState {
  kind: 'gauge'
  value: number
}

type MetricState = CounterState | HistogramState | GaugeState

/**
 * In-process Prometheus-text-format backend.
 *
 * Maintains counters, histograms, and gauges in memory. Call getPrometheusText()
 * to get the /metrics-compatible output.
 *
 * For actual Prometheus ingestion, expose getPrometheusText() via an HTTP endpoint
 * or push to a Pushgateway.
 */
export class PrometheusTextBackend implements MetricsBackend {
  /**
   * Default histogram buckets (milliseconds): useful for provider operation durations.
   */
  static readonly DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity]

  private readonly _metrics = new Map<string, Map<string, MetricState>>()
  private readonly _histogramBuckets: number[]

  constructor(histogramBuckets = PrometheusTextBackend.DEFAULT_BUCKETS) {
    this._histogramBuckets = histogramBuckets.includes(Infinity)
      ? histogramBuckets
      : [...histogramBuckets, Infinity]
  }

  private _labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',')
  }

  counter(name: string, labels: MetricLabels, value = 1): void {
    if (!this._metrics.has(name)) this._metrics.set(name, new Map())
    const series = this._metrics.get(name)!
    const key = this._labelKey(labels)
    const existing = series.get(key)
    if (!existing) {
      series.set(key, { kind: 'counter', value })
    } else if (existing.kind === 'counter') {
      existing.value += value
    }
  }

  histogram(name: string, labels: MetricLabels, value: number): void {
    if (!this._metrics.has(name)) this._metrics.set(name, new Map())
    const series = this._metrics.get(name)!
    const key = this._labelKey(labels)
    const existing = series.get(key)
    if (!existing) {
      const buckets = this._histogramBuckets.slice()
      const bucketCounts = new Array<number>(buckets.length).fill(0)
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]) bucketCounts[i]++
      }
      series.set(key, { kind: 'histogram', sum: value, count: 1, buckets, bucketCounts })
    } else if (existing.kind === 'histogram') {
      existing.sum += value
      existing.count++
      for (let i = 0; i < existing.buckets.length; i++) {
        if (value <= existing.buckets[i]) existing.bucketCounts[i]++
      }
    }
  }

  gauge(name: string, labels: MetricLabels, value: number): void {
    if (!this._metrics.has(name)) this._metrics.set(name, new Map())
    const series = this._metrics.get(name)!
    const key = this._labelKey(labels)
    series.set(key, { kind: 'gauge', value })
  }

  /**
   * Return the Prometheus text exposition format string.
   * Suitable for use as the response body of a GET /metrics endpoint.
   */
  getPrometheusText(): string {
    const lines: string[] = []

    for (const [name, series] of this._metrics.entries()) {
      for (const [labelKey, state] of series.entries()) {
        const labelStr = labelKey ? `{${labelKey}}` : ''

        switch (state.kind) {
          case 'counter':
            lines.push(`# TYPE ${name} counter`)
            lines.push(`${name}_total${labelStr} ${state.value}`)
            break

          case 'gauge':
            lines.push(`# TYPE ${name} gauge`)
            lines.push(`${name}${labelStr} ${state.value}`)
            break

          case 'histogram': {
            lines.push(`# TYPE ${name} histogram`)
            // bucketCounts[i] is already the count of values <= buckets[i]
            // (cumulative), so we emit directly.
            for (let i = 0; i < state.buckets.length; i++) {
              const le = state.buckets[i] === Infinity ? '+Inf' : String(state.buckets[i])
              const bucketLabels = labelKey
                ? `{${labelKey},le="${le}"}`
                : `{le="${le}"}`
              lines.push(`${name}_bucket${bucketLabels} ${state.bucketCounts[i]}`)
            }
            lines.push(`${name}_sum${labelStr} ${state.sum}`)
            lines.push(`${name}_count${labelStr} ${state.count}`)
            break
          }
        }
      }
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '')
  }

  /** Reset all metrics (useful in tests). */
  reset(): void {
    this._metrics.clear()
  }
}

// ---------------------------------------------------------------------------
// Event → metrics emission
// ---------------------------------------------------------------------------

/** Default metrics name prefix. Override via metricsPrefix. */
const DEFAULT_PREFIX = 'rensei_provider'

function emitEventMetrics(
  event: ProviderHookEvent,
  backend: MetricsBackend,
  prefix: string,
): void {
  switch (event.kind) {
    case 'pre-activate': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
      }
      backend.counter(`${prefix}_activations_started`, labels)
      break
    }

    case 'post-activate': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
      }
      backend.counter(`${prefix}_activations_completed`, labels)
      backend.histogram(`${prefix}_activation_duration_ms`, labels, event.durationMs)
      break
    }

    case 'pre-deactivate': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        reason: event.reason,
      }
      backend.counter(`${prefix}_deactivations_started`, labels)
      break
    }

    case 'post-deactivate': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
      }
      backend.counter(`${prefix}_deactivations_completed`, labels)
      break
    }

    case 'pre-verb': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        verb: event.verb,
      }
      backend.counter(`${prefix}_verb_invocations_started`, labels)
      break
    }

    case 'post-verb': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        verb: event.verb,
      }
      backend.counter(`${prefix}_verb_invocations_completed`, labels)
      backend.histogram(`${prefix}_verb_duration_ms`, labels, event.durationMs)
      break
    }

    case 'verb-error': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        verb: event.verb,
        error_type: event.error.constructor.name,
      }
      backend.counter(`${prefix}_verb_errors`, labels)
      break
    }

    case 'pre-tool-use': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        tool_name: event.toolName,
        tool_category: event.toolCategory ?? 'unspecified',
      }
      backend.counter(`${prefix}_tool_uses_started`, labels)
      break
    }

    case 'post-tool-use': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        tool_name: event.toolName,
        is_error: String(event.isError),
      }
      backend.counter(`${prefix}_tool_uses_completed`, labels)
      backend.histogram(`${prefix}_tool_use_duration_ms`, labels, event.durationMs)
      break
    }

    case 'tool-use-error': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
        tool_name: event.toolName,
      }
      backend.counter(`${prefix}_tool_use_errors`, labels)
      break
    }

    case 'capability-mismatch': {
      const labels: MetricLabels = {
        provider_id: event.provider.id,
        family: event.provider.family,
      }
      backend.counter(`${prefix}_capability_mismatches`, labels)
      break
    }

    case 'scope-resolved': {
      backend.gauge(`${prefix}_scope_chosen_count`, {}, event.chosen.length)
      backend.gauge(`${prefix}_scope_rejected_count`, {}, event.rejected.length)
      break
    }

    default: {
      const _exhaustive: never = event
      void _exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// Subscriber registration
// ---------------------------------------------------------------------------

export interface MetricsSubscriberOptions {
  /**
   * The metrics backend to emit to.
   * Defaults to NoopMetricsBackend (no-op).
   */
  backend?: MetricsBackend

  /**
   * Metrics name prefix.
   * Defaults to 'rensei_provider'.
   */
  prefix?: string

  /**
   * Event filter.
   */
  filter?: SubscriberFilter
}

/**
 * Register the metrics subscriber on the given bus.
 * Returns an unsubscribe function.
 *
 * @example
 * import { globalHookBus } from '../hooks.js'
 * import { registerMetricsSubscriber, PrometheusTextBackend } from './metrics.js'
 *
 * const promBackend = new PrometheusTextBackend()
 * const unsubscribe = registerMetricsSubscriber(globalHookBus, { backend: promBackend })
 *
 * // In your metrics endpoint:
 * app.get('/metrics', (req, res) => res.send(promBackend.getPrometheusText()))
 */
export function registerMetricsSubscriber(
  bus: HookBus,
  options: MetricsSubscriberOptions = {},
): () => void {
  const backend = options.backend ?? new NoopMetricsBackend()
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const filter = options.filter ?? {}

  return bus.subscribe(filter, (event) => {
    emitEventMetrics(event, backend, prefix)
  })
}
