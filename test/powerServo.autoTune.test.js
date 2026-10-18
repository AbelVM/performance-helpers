import { describe, it, expect } from 'vitest';
import { PowerServo } from '../src/helpers/powerServo.js';

describe('PowerServo.autoTune', () => {
  it('applies Ziegler-Nichols classic gains', () => {
    const servo = new PowerServo({ setpoint: 0, kp: 1, ki: 1, kd: 1 });
    servo.autoTune(2, 4);
    // ku=2, pu=4
    expect(servo._kp).toBeCloseTo(0.6 * 2, 10);
    expect(servo._ki).toBeCloseTo((1.2 * 2) / 4, 10);
    expect(servo._kd).toBeCloseTo(0.075 * 2 * 4, 10);
  });

  it('accepts an object form with method aliases', () => {
    const servo = new PowerServo({ setpoint: 0 });
    servo.autoTune({ ku: 5, pu: 1.5, method: 'tyreus' });
    expect(servo._kp).toBeCloseTo(0.45 * 5, 10);
    expect(servo._ki).toBeCloseTo((0.45 * 5) / (2.2 * 1.5), 10);
    expect(servo._kd).toBeCloseTo((0.45 * 5 * 1.5) / 6.3, 10);
  });

  it('supports ultimateGain/ultimatePeriod/Ku/Pu aliases', () => {
    const servo = new PowerServo({ setpoint: 0 });
    servo.autoTune({ ultimateGain: 3, ultimatePeriod: 2, rule: 'tl' });
    expect(servo._kp).toBeCloseTo(0.45 * 3, 10);
  });

  it('tune() and autoTuneZN() are aliases', () => {
    const a = new PowerServo({ setpoint: 0 });
    const b = new PowerServo({ setpoint: 0 });
    a.tune(4, 3);
    b.autoTuneZN(4, 3);
    expect(a.kp).toBe(b.kp);
    expect(a.ki).toBe(b.ki);
    expect(a.kd).toBe(b.kd);
  });

  it('returns this for chaining', () => {
    const servo = new PowerServo({ setpoint: 0 });
    expect(servo.autoTune(1, 1)).toBe(servo);
  });

  it('throws TypeError on bad ku', () => {
    const servo = new PowerServo({ setpoint: 0 });
    expect(() => servo.autoTune(0, 1)).toThrow(TypeError);
    expect(() => servo.autoTune(NaN, 1)).toThrow(TypeError);
    expect(() => servo.autoTune(Infinity, 1)).toThrow(TypeError);
  });

  it('throws TypeError on bad pu', () => {
    const servo = new PowerServo({ setpoint: 0 });
    expect(() => servo.autoTune(1, 0)).toThrow(TypeError);
    expect(() => servo.autoTune(1, -1)).toThrow(TypeError);
  });

  it('applies autoTune constructor option', () => {
    const servo = new PowerServo({ setpoint: 0, autoTune: { ku: 2, pu: 4 } });
    expect(servo._kp).toBeCloseTo(0.6 * 2, 10);
  });
});
