import type {
  AccountsControllerAccountAddedEvent,
  AccountsControllerAccountRemovedEvent,
  AccountsControllerListMultichainAccountsAction,
} from '@metamask/accounts-controller';
import {
  BaseController,
  type ControllerGetStateAction,
  type ControllerStateChangeEvent,
  type RestrictedControllerMessenger,
} from '@metamask/base-controller';
import {
  BtcAccountType,
  KeyringClient,
  type Balance,
  type CaipAssetType,
  type InternalAccount,
  isEvmAccountType,
} from '@metamask/keyring-api';
import type { HandleSnapRequest } from '@metamask/snaps-controllers';
import type { SnapId } from '@metamask/snaps-sdk';
import { HandlerType } from '@metamask/snaps-utils';
import type { Json, JsonRpcRequest } from '@metamask/utils';
import { validate, Network } from 'bitcoin-address-validation';
import type { Draft } from 'immer';

import { BalancesTracker } from './BalancesTracker';

const controllerName = 'MultichainBalancesController';

/**
 * State used by the {@link MultichainBalancesController} to cache account balances.
 */
export type MultichainBalancesControllerState = {
  balances: {
    [account: string]: {
      [asset: string]: {
        amount: string;
        unit: string;
      };
    };
  };
};

/**
 * Default state of the {@link MultichainBalancesController}.
 */
export const defaultState: MultichainBalancesControllerState = { balances: {} };

/**
 * Returns the state of the {@link MultichainBalancesController}.
 */
export type MultichainBalancesControllerGetStateAction =
  ControllerGetStateAction<
    typeof controllerName,
    MultichainBalancesControllerState
  >;

/**
 * Updates the balances of all supported accounts.
 */
export type MultichainBalancesControllerUpdateBalancesAction = {
  type: `${typeof controllerName}:updateBalances`;
  handler: MultichainBalancesController['updateBalances'];
};

/**
 * Event emitted when the state of the {@link MultichainBalancesController} changes.
 */
export type MultichainBalancesControllerStateChange =
  ControllerStateChangeEvent<
    typeof controllerName,
    MultichainBalancesControllerState
  >;

/**
 * Actions exposed by the {@link MultichainBalancesController}.
 */
export type MultichainBalancesControllerActions =
  | MultichainBalancesControllerGetStateAction
  | MultichainBalancesControllerUpdateBalancesAction;

/**
 * Events emitted by {@link MultichainBalancesController}.
 */
export type MultichainBalancesControllerEvents =
  MultichainBalancesControllerStateChange;

/**
 * Actions that this controller is allowed to call.
 */
export type AllowedActions =
  | HandleSnapRequest
  | AccountsControllerListMultichainAccountsAction;

/**
 * Events that this controller is allowed to subscribe.
 */
export type AllowedEvents =
  | AccountsControllerAccountAddedEvent
  | AccountsControllerAccountRemovedEvent;

/**
 * Messenger type for the MultichainBalancesController.
 */
export type MultichainBalancesControllerMessenger =
  RestrictedControllerMessenger<
    typeof controllerName,
    MultichainBalancesControllerActions | AllowedActions,
    MultichainBalancesControllerEvents | AllowedEvents,
    AllowedActions['type'],
    AllowedEvents['type']
  >;

/**
 * {@link multichainBalancesController}'s metadata.
 *
 * This allows us to choose if fields of the state should be persisted or not
 * using the `persist` flag; and if they can be sent to Sentry or not, using
 * the `anonymous` flag.
 */
const multichainBalancesControllerMetadata = {
  balances: {
    persist: true,
    anonymous: false,
  },
};

const BTC_TESTNET_ASSETS = ['bip122:000000000933ea01ad0ee984209779ba/slip44:0'];
const BTC_MAINNET_ASSETS = ['bip122:000000000019d6689c085ae165831e93/slip44:0'];
const BTC_AVG_BLOCK_TIME = 10 * 60 * 1000; // 10 minutes in milliseconds

// NOTE: We set an interval of half the average block time to mitigate when our interval
// is de-synchronized with the actual block time.
export const BALANCES_UPDATE_TIME = BTC_AVG_BLOCK_TIME / 2;

/**
 * The MultichainBalancesController is responsible for fetching and caching account
 * balances.
 */
export class MultichainBalancesController extends BaseController<
  typeof controllerName,
  MultichainBalancesControllerState,
  MultichainBalancesControllerMessenger
> {
  #tracker: BalancesTracker;

  constructor({
    messenger,
    state,
  }: {
    messenger: MultichainBalancesControllerMessenger;
    state: MultichainBalancesControllerState;
  }) {
    super({
      messenger,
      name: controllerName,
      metadata: multichainBalancesControllerMetadata,
      state: {
        ...defaultState,
        ...state,
      },
    });

    this.#tracker = new BalancesTracker(
      async (accountId: string) => await this.#updateBalance(accountId),
    );

    // Register all non-EVM accounts into the tracker
    for (const account of this.#listAccounts()) {
      if (this.#isNonEvmAccount(account)) {
        this.#tracker.track(account.id, BALANCES_UPDATE_TIME);
      }
    }

    this.messagingSystem.subscribe(
      'AccountsController:accountAdded',
      (account) => this.#handleOnAccountAdded(account),
    );
    this.messagingSystem.subscribe(
      'AccountsController:accountRemoved',
      (account) => this.#handleOnAccountRemoved(account),
    );
  }

  /**
   * Starts the polling process.
   */
  async start(): Promise<void> {
    this.#tracker.start();
  }

  /**
   * Stops the polling process.
   */
  async stop(): Promise<void> {
    this.#tracker.stop();
  }

  /**
   * Lists the multichain accounts coming from the `AccountsController`.
   *
   * @returns A list of multichain accounts.
   */
  #listMultichainAccounts(): InternalAccount[] {
    return this.messagingSystem.call(
      'AccountsController:listMultichainAccounts',
    );
  }

  /**
   * Lists the accounts that we should get balances for.
   *
   * Currently, we only get balances for P2WPKH accounts, but this will change
   * in the future when we start support other non-EVM account types.
   *
   * @returns A list of accounts that we should get balances for.
   */
  #listAccounts(): InternalAccount[] {
    const accounts = this.#listMultichainAccounts();

    return accounts.filter((account) => account.type === BtcAccountType.P2wpkh);
  }

  /**
   * Get a non-EVM account from its ID.
   *
   * @param accountId - The account ID.
   * @returns The non-EVM account.
   */
  #getAccount(accountId: string): InternalAccount {
    const account: InternalAccount | undefined =
      this.#listMultichainAccounts().find(
        (multichainAccount) => multichainAccount.id === accountId,
      );

    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }
    if (!this.#isNonEvmAccount(account)) {
      throw new Error(`Account is not a non-EVM account: ${accountId}`);
    }
    return account;
  }

  /**
   * Updates the balances of one account. This method doesn't return
   * anything, but it updates the state of the controller.
   *
   * @param accountId - The account ID.
   */
  async #updateBalance(accountId: string) {
    const account = this.#getAccount(accountId);
    const partialState: MultichainBalancesControllerState = { balances: {} };

    if (account.metadata.snap) {
      partialState.balances[account.id] = await this.#getBalances(
        account.id,
        account.metadata.snap.id,
        validate(account.address, Network.mainnet)
          ? BTC_MAINNET_ASSETS
          : BTC_TESTNET_ASSETS,
      );
    }

    this.update((state: Draft<MultichainBalancesControllerState>) => ({
      ...state,
      balances: {
        ...state.balances,
        ...partialState.balances,
      },
    }));
  }

  /**
   * Updates the balances of one account. This method doesn't return
   * anything, but it updates the state of the controller.
   *
   * @param accountId - The account ID.
   */
  async updateBalance(accountId: string) {
    // NOTE: No need to track the account here, since we start tracking those when
    // the "AccountsController:accountAdded" is fired.
    await this.#tracker.updateBalance(accountId);
  }

  /**
   * Updates the balances of all supported accounts. This method doesn't return
   * anything, but it updates the state of the controller.
   */
  async updateBalances() {
    await this.#tracker.updateBalances();
  }

  /**
   * Checks for non-EVM accounts.
   *
   * @param account - The new account to be checked.
   * @returns True if the account is a non-EVM account, false otherwise.
   */
  #isNonEvmAccount(account: InternalAccount): boolean {
    return (
      !isEvmAccountType(account.type) &&
      // Non-EVM accounts are backed by a Snap for now
      account.metadata.snap !== undefined
    );
  }

  /**
   * Handles changes when a new account has been added.
   *
   * @param account - The new account being added.
   */
  async #handleOnAccountAdded(account: InternalAccount) {
    if (!this.#isNonEvmAccount(account)) {
      // Nothing to do here for EVM accounts
      return;
    }

    this.#tracker.track(account.id, BTC_AVG_BLOCK_TIME);
    // NOTE: Unfortunately, we cannot update the balance right away here, because
    // messenger's events are running synchronously and fetching the balance is
    // asynchronous.
    // Updating the balance here would resume at some point but the event emitter
    // will not `await` this (so we have no real control "when" the balance will
    // really be updated), see:
    // - https://github.com/MetaMask/core/blob/v213.0.0/packages/accounts-controller/src/AccountsController.ts#L1036-L1039
  }

  /**
   * Handles changes when a new account has been removed.
   *
   * @param accountId - The account ID being removed.
   */
  async #handleOnAccountRemoved(accountId: string) {
    if (this.#tracker.isTracked(accountId)) {
      this.#tracker.untrack(accountId);
    }

    if (accountId in this.state.balances) {
      this.update((state: Draft<MultichainBalancesControllerState>) => {
        delete state.balances[accountId];
        return state;
      });
    }
  }

  /**
   * Get the balances for an account.
   *
   * @param accountId - ID of the account to get balances for.
   * @param snapId - ID of the Snap which manages the account.
   * @param assetTypes - Array of asset types to get balances for.
   * @returns A map of asset types to balances.
   */
  async #getBalances(
    accountId: string,
    snapId: string,
    assetTypes: CaipAssetType[],
  ): Promise<Record<CaipAssetType, Balance>> {
    return await this.#getClient(snapId).getAccountBalances(
      accountId,
      assetTypes,
    );
  }

  /**
   * Gets a `KeyringClient` for a Snap.
   *
   * @param snapId - ID of the Snap to get the client for.
   * @returns A `KeyringClient` for the Snap.
   */
  #getClient(snapId: string): KeyringClient {
    return new KeyringClient({
      send: async (request: JsonRpcRequest) =>
        (await this.messagingSystem.call('SnapController:handleRequest', {
          snapId: snapId as SnapId,
          origin: 'metamask',
          handler: HandlerType.OnKeyringRequest,
          request,
        })) as Promise<Json>,
    });
  }
}
