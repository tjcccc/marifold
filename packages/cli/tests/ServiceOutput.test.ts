import { describe, expect, it } from 'vitest';
import {
  formatServiceAvailability,
  serviceBindUrl,
  serviceEntryUrls,
  ServiceNetworkInterfaces,
} from '../src/service/ServiceOutput';

describe('service startup output', () => {
  it('keeps a concrete loopback bind as the entry URL', () => {
    expect(serviceEntryUrls('http://127.0.0.1:43123', '127.0.0.1', {})).toEqual([
      'http://127.0.0.1:43123',
    ]);
  });

  it('turns an IPv4 wildcard bind into permitted concrete entry URLs', () => {
    const interfaces: ServiceNetworkInterfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: '192.168.50.23', family: 'IPv4', internal: false },
        { address: '2001:db8::23', family: 'IPv6', internal: false },
      ],
      tailscale0: [{ address: '100.71.62.115', family: 4, internal: false }],
      public0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    };

    expect(serviceEntryUrls('http://0.0.0.0:32140', '0.0.0.0', interfaces)).toEqual([
      'http://127.0.0.1:32140',
      'http://192.168.50.23:32140',
      'http://100.71.62.115:32140',
    ]);
  });

  it('formats one or several entry URLs for terminal output', () => {
    expect(formatServiceAvailability(['http://127.0.0.1:32140'])).toBe(
      'Marifold service available at http://127.0.0.1:32140',
    );
    expect(formatServiceAvailability([
      'http://127.0.0.1:32140',
      'http://192.168.50.23:32140',
    ])).toBe([
      'Marifold service available at:',
      '  http://127.0.0.1:32140',
      '  http://192.168.50.23:32140',
    ].join('\n'));
  });

  it('preserves the configured wildcard in verbose bind output', () => {
    expect(serviceBindUrl('http://127.0.0.1:32140', '0.0.0.0')).toBe('http://0.0.0.0:32140');
  });
});
