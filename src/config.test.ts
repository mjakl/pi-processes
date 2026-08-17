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

  it("accepts a bash timeout and treats 0 as disabled", () => {
    expect(
      resolveConfig({ interception: { bashTimeoutSeconds: 120 } }).interception,
    ).toEqual({ blockBackgroundCommands: true, bashTimeoutSeconds: 120 });
    expect(
      resolveConfig({ interception: { bashTimeoutSeconds: 0 } }).interception
        .bashTimeoutSeconds,
    ).toBe(0);
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    "300",
  ])("uses the default bash timeout for invalid value %s", (invalid) => {
    expect(
      resolveConfig({
        interception: { bashTimeoutSeconds: invalid as number },
      }).interception.bashTimeoutSeconds,
    ).toBe(300);
  });

  it("caps the bash timeout at an hour", () => {
    expect(
      resolveConfig({ interception: { bashTimeoutSeconds: 100_000 } })
        .interception.bashTimeoutSeconds,
    ).toBe(3600);
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
