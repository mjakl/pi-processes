import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";

describe("resolveConfig", () => {
  it("accepts positive integer output limits", () => {
    expect(
      resolveConfig({
        output: { defaultTailLines: 40, maxOutputLines: 80 },
      }),
    ).toMatchObject({
      output: { defaultTailLines: 40, maxOutputLines: 80 },
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("uses defaults for invalid output limit %s", (invalid) => {
    expect(
      resolveConfig({
        output: {
          defaultTailLines: invalid,
          maxOutputLines: invalid,
        },
      }).output,
    ).toEqual({ defaultTailLines: 100, maxOutputLines: 200 });
  });

  it("caps limits and never reads more lines than it can return", () => {
    expect(
      resolveConfig({
        output: { defaultTailLines: 5000, maxOutputLines: 50 },
      }).output,
    ).toEqual({ defaultTailLines: 50, maxOutputLines: 50 });
    expect(resolveConfig({ output: { maxOutputLines: 5000 } }).output).toEqual({
      defaultTailLines: 100,
      maxOutputLines: 2000,
    });
  });
});
