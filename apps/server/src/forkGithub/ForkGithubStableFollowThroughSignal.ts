import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

export interface ForkGithubStableFollowThroughSignalShape {
  /** Coalesced wake only; the consumer always scans the durable intent table. */
  readonly notifyCompleted: (requestId: string) => Effect.Effect<void>;
  readonly take: () => Effect.Effect<void>;
}
export class ForkGithubStableFollowThroughSignal extends Context.Service<
  ForkGithubStableFollowThroughSignal,
  ForkGithubStableFollowThroughSignalShape
>()("t3/forkGithub/ForkGithubStableFollowThroughSignal") {}

export const ForkGithubStableFollowThroughSignalLive = Layer.effect(
  ForkGithubStableFollowThroughSignal,
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<void>(1);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return {
      notifyCompleted: (_requestId) => Queue.offer(queue, undefined).pipe(Effect.asVoid),
      take: () => Queue.take(queue),
    } satisfies ForkGithubStableFollowThroughSignalShape;
  }),
);
