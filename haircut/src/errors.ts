/**
 * Typed errors for @vanta/haircut. Stable `code`, frozen `detail`,
 * fixed `name` — pattern shared with @vanta/events and @vanta/mark.
 */

export type HaircutErrorCode = "input_out_of_range" | "params_invalid" | "sigma_non_finite";

export class HaircutError extends Error {
  public override readonly name = "HaircutError" as const;
  public readonly code: HaircutErrorCode;
  public readonly detail: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: HaircutErrorCode,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.detail = detail === undefined ? undefined : Object.freeze({ ...detail });
  }
}
