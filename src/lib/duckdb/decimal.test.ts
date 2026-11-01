import { expect, it } from "vitest";
import { decimalText } from "./decimal";
it("formats Arrow decimals without losing precision or negative fractional values", () => {
  const limbs = (n: bigint) => {
    const value = BigInt.asUintN(128, n);
    return Array.from({ length: 4 }, (_, index) =>
      Number((value >> BigInt(index * 32)) & 0xffffffffn),
    );
  };
  expect(decimalText(limbs(1234567890123456789012345678n), 8)).toBe(
    "12345678901234567890.12345678",
  );
  expect(decimalText(limbs(-1n), 8)).toBe("-0.00000001");
  expect(decimalText(limbs(0n), 2)).toBe("0.00");
});
