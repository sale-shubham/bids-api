// Safety net only: explicit toPaise() conversion is the rule; this stops JSON.stringify crashing on a stray bigint.
declare global {
  interface BigInt {
    toJSON(): number | string;
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): number | string {
      const n = Number(this);
      return Number.isSafeInteger(n) ? n : this.toString();
    },
    configurable: true,
    writable: true,
  });
}

export {};
