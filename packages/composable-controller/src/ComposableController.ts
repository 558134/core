import { BaseController, BaseControllerV1 } from '@metamask/base-controller';
import type {
  ActionConstraint,
  BaseConfig,
  BaseState,
  EventConstraint,
  RestrictedControllerMessenger,
  StateConstraint,
  StateMetadata,
} from '@metamask/base-controller';
import type { Patch } from 'immer';

export const controllerName = 'ComposableController';

/**
 * A universal subtype of all controller instances that extend from `BaseControllerV1`.
 * Any `BaseControllerV1` instance can be assigned to this type.
 *
 * Note that this type is not the widest subtype or narrowest supertype of all `BaseControllerV1` instances.
 * This type is therefore unsuitable for general use as a type constraint, and is only intended for use within the ComposableController.
 */
export type BaseControllerV1Instance =
  // `any` is used so that all `BaseControllerV1` instances are assignable to this type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BaseControllerV1<any, any>;

/**
 * A universal subtype of all controller instances that extend from `BaseController` (formerly `BaseControllerV2`).
 * Any `BaseController` instance can be assigned to this type.
 *
 * Note that this type is not the widest subtype or narrowest supertype of all `BaseController` instances.
 * This type is therefore unsuitable for general use as a type constraint, and is only intended for use within the ComposableController.
 *
 * For this reason, we only look for `BaseController` properties that we use in the ComposableController (name and state).
 */
export type BaseControllerInstance = {
  name: string;
  state: StateConstraint;
};

/**
 * A universal subtype of all controller instances that extend from `BaseController` (formerly `BaseControllerV2`) or `BaseControllerV1`.
 * Any `BaseController` or `BaseControllerV1` instance can be assigned to this type.
 *
 * Note that this type is not the widest subtype or narrowest supertype of all `BaseController` and `BaseControllerV1` instances.
 * This type is therefore unsuitable for general use as a type constraint, and is only intended for use within the ComposableController.
 */
export type ControllerInstance =
  | BaseControllerV1Instance
  | BaseControllerInstance;

/**
 * A narrowest supertype of all `RestrictedControllerMessenger` instances.
 */
type RestrictedControllerMessengerConstraint = RestrictedControllerMessenger<
  string,
  ActionConstraint,
  EventConstraint,
  string,
  string
>;

/**
 * Determines if the given controller is an instance of `BaseControllerV1`
 * @param controller - Controller instance to check
 * @returns True if the controller is an instance of `BaseControllerV1`
 */
export function isBaseControllerV1(
  controller: ControllerInstance,
): controller is BaseControllerV1<
  BaseConfig & Record<string, unknown>,
  BaseState & Record<string, unknown>
> {
  return (
    'name' in controller &&
    typeof controller.name === 'string' &&
    'defaultConfig' in controller &&
    typeof controller.defaultConfig === 'object' &&
    'defaultState' in controller &&
    typeof controller.defaultState === 'object' &&
    'disabled' in controller &&
    typeof controller.disabled === 'boolean' &&
    controller instanceof BaseControllerV1
  );
}

/**
 * Determines if the given controller is an instance of `BaseController`
 * @param controller - Controller instance to check
 * @returns True if the controller is an instance of `BaseController`
 */
export function isBaseController(
  controller: ControllerInstance,
): controller is BaseController<
  string,
  StateConstraint,
  RestrictedControllerMessengerConstraint
> {
  return (
    'name' in controller &&
    typeof controller.name === 'string' &&
    'state' in controller &&
    typeof controller.state === 'object' &&
    controller instanceof BaseController
  );
}

/**
 *
 */
// TODO: Replace all instances with `ControllerStateChangeEvent` once `BaseControllerV2` migrations are completed for all controllers.
type LegacyControllerStateChangeEvent<
  ControllerName extends string,
  ControllerState extends ControllerInstance['state'],
> = {
  type: `${ControllerName}:stateChange`;
  payload: [ControllerState, Patch[]];
};

// TODO: Replace `any` with `Json` once `BaseControllerV2` migrations are completed for all controllers.
export type ComposableControllerStateConstraint = {
  // `any` is used here to disable the `BaseController` type constraint which expects state properties to extend `Record<string, Json>`.
  // `ComposableController` state needs to accommodate `BaseControllerV1` state objects that may have properties wider than `Json`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: Record<string, any>;
};

export type ComposableControllerStateChangeEvent<
  ComposableControllerState extends ComposableControllerStateConstraint,
> = LegacyControllerStateChangeEvent<
  typeof controllerName,
  ComposableControllerState
>;

export type ComposableControllerEvents<
  ComposableControllerState extends ComposableControllerStateConstraint,
> = ComposableControllerStateChangeEvent<ComposableControllerState>;

type ChildControllerStateChangeEvents<
  ComposableControllerState extends ComposableControllerStateConstraint,
> = ComposableControllerState extends Record<infer ControllerName, never>
  ? ControllerName extends string
    ? {
        type: `${ControllerName}:stateChange`;
        payload: [ComposableControllerState[ControllerName], Patch[]];
      }
    : never
  : never;

type AllowedEvents<
  ComposableControllerState extends ComposableControllerStateConstraint,
> = ChildControllerStateChangeEvents<ComposableControllerState>;

export type ComposableControllerMessenger<
  ComposableControllerState extends ComposableControllerStateConstraint,
> = RestrictedControllerMessenger<
  typeof controllerName,
  never,
  | ComposableControllerEvents<ComposableControllerState>
  | AllowedEvents<ComposableControllerState>,
  never,
  AllowedEvents<ComposableControllerState>['type']
>;

/**
 * Controller that can be used to compose multiple controllers together.
 * @template ChildControllers
 * @template ComposedControllerState
 * @template ComposedControllerStateChangeEvent
 * @template ChildControllersStateChangeEvents
 * @template ComposedControllerMessenger
 * @template MessengerArgument
 */
export class ComposableController<
  ComposableControllerState extends ComposableControllerStateConstraint,
  ComposedControllerMessenger extends ComposableControllerMessenger<ComposableControllerState>,
  MessengerArgument extends ComposedControllerMessenger = ComposedControllerMessenger,
> extends BaseController<
  typeof controllerName,
  ComposableControllerState,
  ComposedControllerMessenger
> {
  /**
   * Creates a ComposableController instance.
   *
   * @param options - Initial options used to configure this controller
   * @param options.controllers - List of child controller instances to compose.
   * @param options.messenger - A restricted controller messenger.
   */

  constructor({
    controllers,
    messenger,
  }: {
    controllers: ControllerInstance[];
    messenger: MessengerArgument;
  }) {
    if (messenger === undefined) {
      throw new Error(`Messaging system is required`);
    }

    super({
      name: controllerName,
      metadata: controllers.reduce<StateMetadata<ComposableControllerState>>(
        (metadata, controller) => ({
          ...metadata,
          [controller.name]: isBaseController(controller)
            ? controller.metadata
            : { persist: true, anonymous: true },
        }),
        {} as never,
      ),
      state: controllers.reduce<ComposableControllerState>(
        (state, controller) => {
          return { ...state, [controller.name]: controller.state };
        },
        {} as never,
      ),
      messenger,
    });

    controllers.forEach((controller) =>
      this.#updateChildController(controller),
    );
  }

  /**
   * Constructor helper that subscribes to child controller state changes.
   * @param controller - Controller instance to update
   */
  #updateChildController(controller: ControllerInstance): void {
    if (!isBaseController(controller) && !isBaseControllerV1(controller)) {
      throw new Error(
        'Invalid controller: controller must extend from BaseController or BaseControllerV1',
      );
    }

    const { name } = controller;
    if (
      (isBaseControllerV1(controller) && 'messagingSystem' in controller) ||
      isBaseController(controller)
    ) {
      this.messagingSystem.subscribe(
        `${name}:stateChange`,
        (childState: Record<string, unknown>) => {
          this.update((state) => {
            Object.assign(state, { [name]: childState });
          });
        },
      );
    } else if (isBaseControllerV1(controller)) {
      controller.subscribe((childState) => {
        this.update((state) => {
          Object.assign(state, { [name]: childState });
        });
      });
    }
  }
}

export default ComposableController;
