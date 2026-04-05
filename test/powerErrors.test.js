import { expect } from 'chai';
import { describe, it } from 'vitest';
import { normalizeError, formatErrorObj } from '../src/utils/errors.js';

describe('powerErrors util', () => {
  it('normalizeError handles null/primitive inputs', () => {
    const n = normalizeError(null);
    expect(n).to.be.an('object');
    expect(n.error).to.equal(true);
    expect(n.code).to.equal('ERR_ITEM');
    expect(n.message).to.equal(undefined);
  });

  it('preserves message and custom defaultCode', () => {
    const n = normalizeError('oops', 'CUSTOM');
    expect(n.code).to.equal('CUSTOM');
    expect(n.message).to.equal('oops');
  });

  it('extracts message from Error objects', () => {
    const err = new Error('boom');
    const n = normalizeError(err);
    expect(n.code).to.equal('ERR_ITEM');
    expect(n.message).to.equal('boom');
    expect(n.stack).to.be.a('string');
  });

  it('formatErrorObj produces readable strings', () => {
    expect(formatErrorObj({ error: true, code: 'E1', message: 'm' })).to.equal('E1: m');
    expect(formatErrorObj(null)).to.equal('null');
  });
});
