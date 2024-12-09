import {
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  wrap,
  CircuitState,
} from 'cockatiel';
import type { IPolicy } from 'cockatiel';

/**
 * The maximum number of times that a failing action should be re-run before
 * giving up.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * The maximum number of times that the action is allowed to fail before pausing
 * further retries.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = (1 + DEFAULT_MAX_RETRIES) * 3;

/**
 * The default length of time (in milliseconds) to temporarily pause retries of
 * the action after enough consecutive failures.
 */
export const DEFAULT_CIRCUIT_BREAK_DURATION = 30 * 60 * 1000;

/**
 * The default length of time (in milliseconds) that governs when an action is
 * regarded as degraded (affecting when `onDegraded` is called).
 */
export const DEFAULT_DEGRADED_THRESHOLD = 5_000;

/**
 * Constructs a policy that will retry an action using ever increasing delays
 * until it succeeds, pausing for a while if too many consecutive failures are
 * detected.
 *
 * @param options - The options to this function.
 * @param options.maxRetries - The maximum number of times that a failing action
 * should be re-run before giving up. Defaults to 3.
 * @param options.maxConsecutiveFailures - The maximum number of times that
 * the action is allowed to fail before pausing further retries. Defaults to 12.
 * @param options.circuitBreakDuration - The length of time (in milliseconds) to
 * pause retries of the action after the number of failures reaches
 * `maxConsecutiveFailures`.
 * @param options.degradedThreshold - The length of time (in milliseconds) that
 * governs when an action is regarded as degraded (affecting when `onDegraded`
 * is called). Defaults to 5 seconds.
 * @param options.onBreak - A function which is called when the action fails too
 * many times in a row. (Note that this will never be called with the default
 * values of `maxRetries` and `maxConsecutiveFailures`.)
 * @param options.onDegraded - A function which is called when the action
 * succeeds before `maxConsecutiveFailures` is reached, but takes more time
 * than the `degradedThreshold` to run.
 * @returns A Cockatiel policy object that can be used to run an arbitrary
 * action (a function).
 * @example
 * ``` ts
 * const policy = createServicePolicy({
 *   maxRetries: 3,
 *   maxConsecutiveFailures: 3,
 *   circuitBreakDuration: 5000,
 *   degradedThreshold: 2000,
 *   onBreak: () => {
 *     console.log('Circuit broke');
 *   },
 *   onDegraded: () => {
 *     console.log('Service is degraded');
 *   }
 * });
 *
 * policy.execute(async () => {
 *   await fetch('https://some/url');
 * });
 * ```
 */
export function createServicePolicy({
  maxRetries = DEFAULT_MAX_RETRIES,
  maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  circuitBreakDuration = DEFAULT_CIRCUIT_BREAK_DURATION,
  degradedThreshold = DEFAULT_DEGRADED_THRESHOLD,
  onBreak = () => {
    // do nothing
  },
  onDegraded = () => {
    // do nothing
  },
}: {
  maxRetries?: number;
  maxConsecutiveFailures?: number;
  degradedThreshold?: number;
  circuitBreakDuration?: number;
  onBreak?: () => void;
  onDegraded?: () => void;
} = {}): IPolicy {
  const retryPolicy = retry(handleAll, {
    // This is actually the maximum number of retries, not the maximum total
    // number of invocations
    maxAttempts: maxRetries,
    backoff: new ExponentialBackoff(),
  });

  const circuitBreakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: circuitBreakDuration,
    breaker: new ConsecutiveBreaker(maxConsecutiveFailures),
  });

  if (onBreak) {
    circuitBreakerPolicy.onBreak(onBreak);
  }

  if (onDegraded) {
    retryPolicy.onGiveUp(() => {
      if (circuitBreakerPolicy.state === CircuitState.Closed) {
        onDegraded();
      }
    });
    retryPolicy.onSuccess(({ duration }) => {
      if (
        circuitBreakerPolicy.state === CircuitState.Closed &&
        duration > degradedThreshold
      ) {
        onDegraded();
      }
    });
  }

  return wrap(retryPolicy, circuitBreakerPolicy);
}
