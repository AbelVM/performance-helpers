import { describe, it, expect } from 'vitest';
import { MetricsCollector } from '../src/helpers/metrics.js';

describe('MetricsCollector.toOTLP', () => {
  it('returns an OTLP-shaped export', () => {
    const collector = new MetricsCollector();
    collector.register('test', () => ({ a: 1, b: true, c: 'x', d: null }));
    const out = collector.toOTLP({ serviceName: 'svc', timestampMs: 1234 });
    expect(out.resourceMetrics).toHaveLength(1);
    const rm = out.resourceMetrics[0];
    expect(rm.resource.attributes[0].value.stringValue).toBe('svc');
    const metrics = rm.scopeMetrics[0].metrics;
    const names = metrics.map((m) => m.name);
    expect(names).toContain('test.a');
    const a = metrics.find((m) => m.name === 'test.a');
    expect(a.gauge.dataPoints[0].asDouble).toBe(1);
    const b = metrics.find((m) => m.name === 'test.b');
    expect(b.gauge.dataPoints[0].asBool).toBe(true);
    const c = metrics.find((m) => m.name === 'test.c');
    expect(c.gauge.dataPoints[0].asString).toBe('x');
  });

  it('defaults serviceName and timestamp', () => {
    const collector = new MetricsCollector();
    collector.register('x', () => ({ n: 5 }));
    const out = collector.toOTLP();
    expect(out.resourceMetrics[0].resource.attributes[0].value.stringValue).toBe(
      'performance-helpers'
    );
    const ts = out.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].timeUnixNano;
    expect(typeof ts).toBe('number');
  });

  it('rejects unknown options', () => {
    const collector = new MetricsCollector();
    expect(() => collector.toOTLP({ foo: 1 })).toThrow();
  });
});
