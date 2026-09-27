import * as Schema from "effect/Schema";

export class ForkCompatibilityError extends Schema.TaggedError<ForkCompatibilityError>()(
  "ForkCompatibilityError",
  { message: Schema.String },
) {}

export const forkCompatibilityError = (message: string) => new ForkCompatibilityError({ message });
