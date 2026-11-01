// Arrow decimals are little-endian signed 32-bit limbs, not JS numbers.
export function decimalText(words: ArrayLike<number>, scale: number): string {
  let value = 0n;
  for (let i = words.length - 1; i >= 0; i--)
    value = (value << 32n) | BigInt(words[i] >>> 0);
  if (words.length && words[words.length - 1] >>> 31)
    value -= 1n << BigInt(words.length * 32);
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString();
  if (scale <= 0) return sign + digits + "0".repeat(-scale);
  const padded = digits.padStart(scale + 1, "0");
  return sign + padded.slice(0, -scale) + "." + padded.slice(-scale);
}
