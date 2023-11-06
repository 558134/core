import { EventEmitter } from 'events';
import { addHexPrefix, bufferToHex } from 'ethereumjs-util';
import { errorCodes, ethErrors } from 'eth-rpc-errors';
import MethodRegistry from 'eth-method-registry';
import EthQuery from 'eth-query';
import Common from '@ethereumjs/common';
import { TransactionFactory, TypedTransaction } from '@ethereumjs/tx';
import { v1 as random } from 'uuid';
import { Mutex } from 'async-mutex';
import {
  BaseController,
  BaseConfig,
  BaseState,
  RestrictedControllerMessenger,
} from '@metamask/base-controller';
import type {
  NetworkState,
  ProviderProxy,
  BlockTrackerProxy,
} from '@metamask/network-controller';
import { query, NetworkType, RPC } from '@metamask/controller-utils';
import NonceTracker from 'nonce-tracker';
import {
  AcceptResultCallbacks,
  AddApprovalRequest,
  AddResult,
} from '@metamask/approval-controller';
import { GasFeeState } from '@metamask/gas-fee-controller';
import {
  getAndFormatTransactionsForNonceTracker,
  normalizeTransaction,
  validateTransaction,
  getIncreasedPriceFromExisting,
  isEIP1559Transaction,
  isGasPriceValue,
  isFeeMarketEIP1559Values,
  validateGasValues,
  validateMinimumIncrease,
} from './utils/utils';
import { IncomingTransactionHelper } from './helpers/IncomingTransactionHelper';
import { EtherscanRemoteTransactionSource } from './helpers/EtherscanRemoteTransactionSource';
import {
  Transaction,
  TransactionMeta,
  TransactionStatus,
  WalletDevice,
} from './types';
import { PendingTransactionTracker } from './helpers/PendingTransactionTracker';
import { estimateGas, updateGas } from './utils/gas';
import { updateGasFees } from './utils/gas-fees';

const HARDFORK = 'london';

/**
 * @type Result
 * @property result - Promise resolving to a new transaction hash
 * @property transactionMeta - Meta information about this new transaction
 */
export interface Result {
  result: Promise<string>;
  transactionMeta: TransactionMeta;
}

export interface GasPriceValue {
  gasPrice: string;
}

export interface FeeMarketEIP1559Values {
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

/**
 * @type TransactionConfig
 *
 * Transaction controller configuration
 * @property provider - Provider used to create a new underlying EthQuery instance
 * @property sign - Method used to sign transactions
 */
export interface TransactionConfig extends BaseConfig {
  sign?: (transaction: Transaction, from: string) => Promise<any>;
  txHistoryLimit: number;
}

/**
 * @type MethodData
 *
 * Method data registry object
 * @property registryMethod - Registry method raw string
 * @property parsedRegistryMethod - Registry method object, containing name and method arguments
 */
export interface MethodData {
  registryMethod: string;
  parsedRegistryMethod: Record<string, unknown>;
}

/**
 * @type TransactionState
 *
 * Transaction controller state
 * @property transactions - A list of TransactionMeta objects
 * @property methodData - Object containing all known method data information
 */
export interface TransactionState extends BaseState {
  transactions: TransactionMeta[];
  methodData: { [key: string]: MethodData };
  lastFetchedBlockNumbers: { [key: string]: number };
}

/**
 * The name of the {@link TransactionController}.
 */
const controllerName = 'TransactionController';

/**
 * The external actions available to the {@link TransactionController}.
 */
type AllowedActions = AddApprovalRequest;

/**
 * The messenger of the {@link TransactionController}.
 */
export type TransactionControllerMessenger = RestrictedControllerMessenger<
  typeof controllerName,
  AllowedActions,
  never,
  AllowedActions['type'],
  never
>;

/**
 * Multiplier used to determine a transaction's increased gas fee during cancellation
 */
export const CANCEL_RATE = 1.5;

/**
 * Multiplier used to determine a transaction's increased gas fee during speed up
 */
export const SPEED_UP_RATE = 1.1;

/**
 * Controller responsible for submitting and managing transactions.
 */
export class TransactionController extends BaseController<
  TransactionConfig,
  TransactionState
> {
  private ethQuery: any;

  private nonceTracker: NonceTracker;

  private registry: any;

  private provider: ProviderProxy;

  private mutex = new Mutex();

  private getCurrentAccountEIP1559Compatibility: () => Promise<boolean>;

  private getCurrentNetworkEIP1559Compatibility: () => Promise<boolean>;

  private getGasFeeEstimates: () => Promise<GasFeeState>;

  private getNetworkState: () => NetworkState;

  private messagingSystem: TransactionControllerMessenger;

  private blockTracker: BlockTrackerProxy;

  private incomingTransactionHelper: IncomingTransactionHelper;

  private pendingTransactionTracker: PendingTransactionTracker;

  private failTransaction(transactionMeta: TransactionMeta, error: Error) {
    const newTransactionMeta = {
      ...transactionMeta,
      error,
      status: TransactionStatus.failed,
    };
    this.updateTransaction(newTransactionMeta);
    this.hub.emit(`${transactionMeta.id}:finished`, newTransactionMeta);
  }

  private async registryLookup(fourBytePrefix: string): Promise<MethodData> {
    const registryMethod = await this.registry.lookup(fourBytePrefix);
    const parsedRegistryMethod = this.registry.parse(registryMethod);
    return { registryMethod, parsedRegistryMethod };
  }

  /**
   * EventEmitter instance used to listen to specific transactional events
   */
  hub = new EventEmitter();

  /**
   * Name of this controller used during composition
   */
  override name = 'TransactionController';

  /**
   * Method used to sign transactions
   */
  sign?: (
    transaction: TypedTransaction,
    from: string,
  ) => Promise<TypedTransaction>;

  /**
   * Creates a TransactionController instance.
   *
   * @param options - The controller options.
   * @param options.blockTracker - The block tracker used to poll for new blocks data.
   * @param options.getCurrentAccountEIP1559Compatibility - Whether or not the account supports EIP-1559.
   * @param options.getCurrentNetworkEIP1559Compatibility - Whether or not the network supports EIP-1559.
   * @param options.getGasFeeEstimates - Callback to retrieve gas fee estimates.
   * @param options.getNetworkState - Gets the state of the network controller.
   * @param options.getSelectedAddress - Gets the address of the currently selected account.
   * @param options.incomingTransactions - Configuration options for incoming transaction support.
   * @param options.incomingTransactions.includeTokenTransfers - Whether or not to include ERC20 token transfers.
   * @param options.incomingTransactions.isEnabled - Whether or not incoming transaction retrieval is enabled.
   * @param options.incomingTransactions.queryEntireHistory - Whether to initially query the entire transaction history or only recent blocks.
   * @param options.incomingTransactions.updateTransactions - Whether or not to update local transactions using remote transaction data.
   * @param options.messenger - The controller messenger.
   * @param options.onNetworkStateChange - Allows subscribing to network controller state changes.
   * @param options.pendingTransactions - Configuration options for pending transaction support.
   * @param options.pendingTransactions.isResubmitEnabled - Whether transaction publishing is automatically retried.
   * @param options.provider - The provider used to create the underlying EthQuery instance.
   * @param config - Initial options used to configure this controller.
   * @param state - Initial state to set on this controller.
   */
  constructor(
    {
      blockTracker,
      getCurrentAccountEIP1559Compatibility,
      getCurrentNetworkEIP1559Compatibility,
      getGasFeeEstimates,
      getNetworkState,
      getSelectedAddress,
      incomingTransactions = {},
      messenger,
      onNetworkStateChange,
      pendingTransactions = {},
      provider,
    }: {
      blockTracker: BlockTrackerProxy;
      getCurrentAccountEIP1559Compatibility: () => Promise<boolean>;
      getCurrentNetworkEIP1559Compatibility: () => Promise<boolean>;
      getGasFeeEstimates?: () => Promise<GasFeeState>;
      getNetworkState: () => NetworkState;
      getSelectedAddress: () => string;
      incomingTransactions: {
        includeTokenTransfers?: boolean;
        isEnabled?: () => boolean;
        queryEntireHistory?: boolean;
        updateTransactions?: boolean;
      };
      messenger: TransactionControllerMessenger;
      onNetworkStateChange: (listener: (state: NetworkState) => void) => void;
      pendingTransactions: {
        isResubmitEnabled?: boolean;
      };
      provider: ProviderProxy;
    },
    config?: Partial<TransactionConfig>,
    state?: Partial<TransactionState>,
  ) {
    super(config, state);

    this.defaultConfig = {
      txHistoryLimit: 40,
    };

    this.defaultState = {
      methodData: {},
      transactions: [],
      lastFetchedBlockNumbers: {},
    };

    this.initialize();
    this.provider = provider;
    this.getCurrentAccountEIP1559Compatibility =
      getCurrentAccountEIP1559Compatibility;
    this.getCurrentNetworkEIP1559Compatibility =
      getCurrentNetworkEIP1559Compatibility;
    this.getGasFeeEstimates =
      getGasFeeEstimates || (() => Promise.resolve({} as GasFeeState));
    this.getNetworkState = getNetworkState;
    this.ethQuery = new EthQuery(provider);
    this.registry = new MethodRegistry({ provider });
    this.messagingSystem = messenger;

    this.nonceTracker = new NonceTracker({
      provider,
      blockTracker,
      getPendingTransactions: this.getNonceTrackerTransactions.bind(
        this,
        TransactionStatus.submitted,
      ),
      getConfirmedTransactions: this.getNonceTrackerTransactions.bind(
        this,
        TransactionStatus.confirmed,
      ),
    });

    this.incomingTransactionHelper = new IncomingTransactionHelper({
      blockTracker,
      getCurrentAccount: getSelectedAddress,
      getLastFetchedBlockNumbers: () => this.state.lastFetchedBlockNumbers,
      getLocalTransactions: () => this.state.transactions,
      getNetworkState,
      isEnabled: incomingTransactions.isEnabled,
      queryEntireHistory: incomingTransactions.queryEntireHistory,
      remoteTransactionSource: new EtherscanRemoteTransactionSource({
        includeTokenTransfers: incomingTransactions.includeTokenTransfers,
      }),
      transactionLimit: this.config.txHistoryLimit,
      updateTransactions: incomingTransactions.updateTransactions,
    });

    this.incomingTransactionHelper.hub.on(
      'transactions',
      this.onIncomingTransactions.bind(this),
    );

    this.incomingTransactionHelper.hub.on(
      'updatedLastFetchedBlockNumbers',
      this.onUpdatedLastFetchedBlockNumbers.bind(this),
    );

    this.pendingTransactionTracker = new PendingTransactionTracker({
      approveTransaction: this.approveTransaction.bind(this),
      blockTracker,
      getChainId: this.getChainId.bind(this),
      getEthQuery: () => this.ethQuery,
      getTransactions: () => this.state.transactions,
      isResubmitEnabled: pendingTransactions.isResubmitEnabled,
      nonceTracker: this.nonceTracker,
      onStateChange: this.subscribe.bind(this),
      publishTransaction: this.publishTransaction.bind(this),
    });

    this.addPendingTransactionTrackerListeners();

    onNetworkStateChange(() => {
      this.ethQuery = new EthQuery(this.provider);
      this.registry = new MethodRegistry({ provider: this.provider });
    });
  }

  /**
   * Handle new method data request.
   *
   * @param fourBytePrefix - The method prefix.
   * @returns The method data object corresponding to the given signature prefix.
   */
  async handleMethodData(fourBytePrefix: string): Promise<MethodData> {
    const releaseLock = await this.mutex.acquire();
    try {
      const { methodData } = this.state;
      const knownMethod = Object.keys(methodData).find(
        (knownFourBytePrefix) => fourBytePrefix === knownFourBytePrefix,
      );
      if (knownMethod) {
        return methodData[fourBytePrefix];
      }
      const registry = await this.registryLookup(fourBytePrefix);
      this.update({
        methodData: { ...methodData, ...{ [fourBytePrefix]: registry } },
      });
      return registry;
    } finally {
      releaseLock();
    }
  }

  /**
   * Add a new unapproved transaction to state. Parameters will be validated, a
   * unique transaction id will be generated, and gas and gasPrice will be calculated
   * if not provided. If A `<tx.id>:unapproved` hub event will be emitted once added.
   *
   * @param transaction - The transaction object to add.
   * @param opts - Additional options to control how the transaction is added.
   * @param opts.deviceConfirmedOn - An enum to indicate what device confirmed the transaction.
   * @param opts.origin - The origin of the transaction request, such as a dApp hostname.
   * @param opts.securityAlertResponse - Response from security validator.
   * @returns Object containing a promise resolving to the transaction hash if approved.
   */
  async addTransaction(
    transaction: Transaction,
    {
      deviceConfirmedOn,
      origin,
      securityAlertResponse,
    }: {
      deviceConfirmedOn?: WalletDevice;
      origin?: string;
      securityAlertResponse?: Record<string, unknown>;
    } = {},
  ): Promise<Result> {
    const { providerConfig, networkId } = this.getNetworkState();
    const isEIP1559Compatible = await this.getEIP1559Compatibility();
    const { transactions } = this.state;

    transaction = normalizeTransaction(transaction);
    validateTransaction(transaction);

    const transactionMeta: TransactionMeta = {
      id: random(),
      networkID: networkId ?? undefined,
      chainId: providerConfig.chainId,
      origin,
      status: TransactionStatus.unapproved as TransactionStatus.unapproved,
      time: Date.now(),
      transaction,
      deviceConfirmedOn,
      verifiedOnBlockchain: false,
      securityAlertResponse,
    };

    await updateGas({
      ethQuery: this.ethQuery,
      providerConfig: this.getNetworkState().providerConfig,
      txMeta: transactionMeta,
    });

    await updateGasFees({
      eip1559: isEIP1559Compatible,
      ethQuery: this.ethQuery,
      getGasFeeEstimates: this.getGasFeeEstimates.bind(this),
      txMeta: transactionMeta,
    });

    transactions.push(transactionMeta);
    this.update({ transactions: this.trimTransactionsForState(transactions) });
    this.hub.emit(`unapprovedTransaction`, transactionMeta);

    return {
      result: this.processApproval(transactionMeta),
      transactionMeta,
    };
  }

  startIncomingTransactionPolling() {
    this.incomingTransactionHelper.start();
  }

  stopIncomingTransactionPolling() {
    this.incomingTransactionHelper.stop();
  }

  async updateIncomingTransactions() {
    await this.incomingTransactionHelper.update();
  }

  private getChainId(): string {
    const { providerConfig } = this.getNetworkState();
    return providerConfig.chainId;
  }

  prepareUnsignedEthTx(txParams: Record<string, unknown>): TypedTransaction {
    return TransactionFactory.fromTxData(txParams, {
      common: this.getCommonConfiguration(),
      freeze: false,
    });
  }

  /**
   * `@ethereumjs/tx` uses `@ethereumjs/common` as a configuration tool for
   * specifying which chain, network, hardfork and EIPs to support for
   * a transaction. By referencing this configuration, and analyzing the fields
   * specified in txParams, @ethereumjs/tx is able to determine which EIP-2718
   * transaction type to use.
   *
   * @returns {Common} common configuration object
   */

  getCommonConfiguration(): Common {
    const {
      networkId,
      providerConfig: { type: chain, chainId, nickname: name },
    } = this.getNetworkState();

    if (
      chain !== RPC &&
      chain !== 'linea-goerli' &&
      chain !== 'linea-mainnet'
    ) {
      return new Common({ chain, hardfork: HARDFORK });
    }

    const customChainParams = {
      name,
      chainId: parseInt(chainId, undefined),
      networkId: networkId === null ? NaN : parseInt(networkId, undefined),
    };

    return Common.forCustomChain(
      NetworkType.mainnet,
      customChainParams,
      HARDFORK,
    );
  }

  /**
   * Attempts to cancel a transaction based on its ID by setting its status to "rejected"
   * and emitting a `<tx.id>:finished` hub event.
   *
   * @param transactionID - The ID of the transaction to cancel.
   * @param gasValues - The gas values to use for the cancellation transation.
   */
  async stopTransaction(
    transactionID: string,
    gasValues?: GasPriceValue | FeeMarketEIP1559Values,
  ) {
    if (gasValues) {
      validateGasValues(gasValues);
    }
    const transactionMeta = this.state.transactions.find(
      ({ id }) => id === transactionID,
    );
    if (!transactionMeta) {
      return;
    }

    if (!this.sign) {
      throw new Error('No sign method defined.');
    }

    // gasPrice (legacy non EIP1559)
    const minGasPrice = getIncreasedPriceFromExisting(
      transactionMeta.transaction.gasPrice,
      CANCEL_RATE,
    );

    const gasPriceFromValues = isGasPriceValue(gasValues) && gasValues.gasPrice;

    const newGasPrice =
      (gasPriceFromValues &&
        validateMinimumIncrease(gasPriceFromValues, minGasPrice)) ||
      minGasPrice;

    // maxFeePerGas (EIP1559)
    const existingMaxFeePerGas = transactionMeta.transaction?.maxFeePerGas;
    const minMaxFeePerGas = getIncreasedPriceFromExisting(
      existingMaxFeePerGas,
      CANCEL_RATE,
    );
    const maxFeePerGasValues =
      isFeeMarketEIP1559Values(gasValues) && gasValues.maxFeePerGas;
    const newMaxFeePerGas =
      (maxFeePerGasValues &&
        validateMinimumIncrease(maxFeePerGasValues, minMaxFeePerGas)) ||
      (existingMaxFeePerGas && minMaxFeePerGas);

    // maxPriorityFeePerGas (EIP1559)
    const existingMaxPriorityFeePerGas =
      transactionMeta.transaction?.maxPriorityFeePerGas;
    const minMaxPriorityFeePerGas = getIncreasedPriceFromExisting(
      existingMaxPriorityFeePerGas,
      CANCEL_RATE,
    );
    const maxPriorityFeePerGasValues =
      isFeeMarketEIP1559Values(gasValues) && gasValues.maxPriorityFeePerGas;
    const newMaxPriorityFeePerGas =
      (maxPriorityFeePerGasValues &&
        validateMinimumIncrease(
          maxPriorityFeePerGasValues,
          minMaxPriorityFeePerGas,
        )) ||
      (existingMaxPriorityFeePerGas && minMaxPriorityFeePerGas);

    const txParams =
      newMaxFeePerGas && newMaxPriorityFeePerGas
        ? {
            from: transactionMeta.transaction.from,
            gasLimit: transactionMeta.transaction.gas,
            maxFeePerGas: newMaxFeePerGas,
            maxPriorityFeePerGas: newMaxPriorityFeePerGas,
            type: 2,
            nonce: transactionMeta.transaction.nonce,
            to: transactionMeta.transaction.from,
            value: '0x0',
          }
        : {
            from: transactionMeta.transaction.from,
            gasLimit: transactionMeta.transaction.gas,
            gasPrice: newGasPrice,
            nonce: transactionMeta.transaction.nonce,
            to: transactionMeta.transaction.from,
            value: '0x0',
          };

    const unsignedEthTx = this.prepareUnsignedEthTx(txParams);

    const signedTx = await this.sign(
      unsignedEthTx,
      transactionMeta.transaction.from,
    );
    const rawTx = bufferToHex(signedTx.serialize());
    await query(this.ethQuery, 'sendRawTransaction', [rawTx]);
    transactionMeta.status = TransactionStatus.cancelled;
    this.hub.emit(`${transactionMeta.id}:finished`, transactionMeta);
  }

  /**
   * Attempts to speed up a transaction increasing transaction gasPrice by ten percent.
   *
   * @param transactionID - The ID of the transaction to speed up.
   * @param gasValues - The gas values to use for the speed up transation.
   */
  async speedUpTransaction(
    transactionID: string,
    gasValues?: GasPriceValue | FeeMarketEIP1559Values,
  ) {
    if (gasValues) {
      validateGasValues(gasValues);
    }
    const transactionMeta = this.state.transactions.find(
      ({ id }) => id === transactionID,
    );
    /* istanbul ignore next */
    if (!transactionMeta) {
      return;
    }

    /* istanbul ignore next */
    if (!this.sign) {
      throw new Error('No sign method defined.');
    }

    const { transactions } = this.state;

    // gasPrice (legacy non EIP1559)
    const minGasPrice = getIncreasedPriceFromExisting(
      transactionMeta.transaction.gasPrice,
      SPEED_UP_RATE,
    );

    const gasPriceFromValues = isGasPriceValue(gasValues) && gasValues.gasPrice;

    const newGasPrice =
      (gasPriceFromValues &&
        validateMinimumIncrease(gasPriceFromValues, minGasPrice)) ||
      minGasPrice;

    // maxFeePerGas (EIP1559)
    const existingMaxFeePerGas = transactionMeta.transaction?.maxFeePerGas;
    const minMaxFeePerGas = getIncreasedPriceFromExisting(
      existingMaxFeePerGas,
      SPEED_UP_RATE,
    );
    const maxFeePerGasValues =
      isFeeMarketEIP1559Values(gasValues) && gasValues.maxFeePerGas;
    const newMaxFeePerGas =
      (maxFeePerGasValues &&
        validateMinimumIncrease(maxFeePerGasValues, minMaxFeePerGas)) ||
      (existingMaxFeePerGas && minMaxFeePerGas);

    // maxPriorityFeePerGas (EIP1559)
    const existingMaxPriorityFeePerGas =
      transactionMeta.transaction?.maxPriorityFeePerGas;
    const minMaxPriorityFeePerGas = getIncreasedPriceFromExisting(
      existingMaxPriorityFeePerGas,
      SPEED_UP_RATE,
    );
    const maxPriorityFeePerGasValues =
      isFeeMarketEIP1559Values(gasValues) && gasValues.maxPriorityFeePerGas;
    const newMaxPriorityFeePerGas =
      (maxPriorityFeePerGasValues &&
        validateMinimumIncrease(
          maxPriorityFeePerGasValues,
          minMaxPriorityFeePerGas,
        )) ||
      (existingMaxPriorityFeePerGas && minMaxPriorityFeePerGas);

    const txParams =
      newMaxFeePerGas && newMaxPriorityFeePerGas
        ? {
            ...transactionMeta.transaction,
            gasLimit: transactionMeta.transaction.gas,
            maxFeePerGas: newMaxFeePerGas,
            maxPriorityFeePerGas: newMaxPriorityFeePerGas,
            type: 2,
          }
        : {
            ...transactionMeta.transaction,
            gasLimit: transactionMeta.transaction.gas,
            gasPrice: newGasPrice,
          };

    const unsignedEthTx = this.prepareUnsignedEthTx(txParams);

    const signedTx = await this.sign(
      unsignedEthTx,
      transactionMeta.transaction.from,
    );
    const rawTx = bufferToHex(signedTx.serialize());
    const hash = await query(this.ethQuery, 'sendRawTransaction', [rawTx]);
    const baseTransactionMeta = {
      ...transactionMeta,
      id: random(),
      time: Date.now(),
      hash,
    };
    const newTransactionMeta =
      newMaxFeePerGas && newMaxPriorityFeePerGas
        ? {
            ...baseTransactionMeta,
            transaction: {
              ...transactionMeta.transaction,
              maxFeePerGas: newMaxFeePerGas,
              maxPriorityFeePerGas: newMaxPriorityFeePerGas,
            },
          }
        : {
            ...baseTransactionMeta,
            transaction: {
              ...transactionMeta.transaction,
              gasPrice: newGasPrice,
            },
          };
    transactions.push(newTransactionMeta);
    this.update({ transactions: this.trimTransactionsForState(transactions) });
    this.hub.emit(`${transactionMeta.id}:speedup`, newTransactionMeta);
  }

  /**
   * Estimates required gas for a given transaction.
   *
   * @param transaction - The transaction to estimate gas for.
   * @returns The gas and gas price.
   */
  async estimateGas(transaction: Transaction) {
    const { estimatedGas, simulationFails } = await estimateGas(
      transaction,
      this.ethQuery,
    );

    return { gas: estimatedGas, simulationFails };
  }

  /**
   * Updates an existing transaction in state.
   *
   * @param transactionMeta - The new transaction to store in state.
   */
  updateTransaction(transactionMeta: TransactionMeta) {
    const { transactions } = this.state;
    transactionMeta.transaction = normalizeTransaction(
      transactionMeta.transaction,
    );
    validateTransaction(transactionMeta.transaction);
    const index = transactions.findIndex(({ id }) => transactionMeta.id === id);
    transactions[index] = transactionMeta;
    this.update({ transactions: this.trimTransactionsForState(transactions) });
  }

  /**
   * Removes all transactions from state, optionally based on the current network.
   *
   * @param ignoreNetwork - Determines whether to wipe all transactions, or just those on the
   * current network. If `true`, all transactions are wiped.
   */
  wipeTransactions(ignoreNetwork?: boolean) {
    /* istanbul ignore next */
    if (ignoreNetwork) {
      this.update({ transactions: [] });
      return;
    }
    const { providerConfig, networkId: currentNetworkID } =
      this.getNetworkState();
    const { chainId: currentChainId } = providerConfig;
    const newTransactions = this.state.transactions.filter(
      ({ networkID, chainId }) => {
        // Using fallback to networkID only when there is no chainId present. Should be removed when networkID is completely removed.
        const isCurrentNetwork =
          chainId === currentChainId ||
          (!chainId && networkID === currentNetworkID);
        return !isCurrentNetwork;
      },
    );

    this.update({
      transactions: this.trimTransactionsForState(newTransactions),
    });
  }

  /**
   * Trim the amount of transactions that are set on the state. Checks
   * if the length of the tx history is longer then desired persistence
   * limit and then if it is removes the oldest confirmed or rejected tx.
   * Pending or unapproved transactions will not be removed by this
   * operation. For safety of presenting a fully functional transaction UI
   * representation, this function will not break apart transactions with the
   * same nonce, created on the same day, per network. Not accounting for transactions of the same
   * nonce, same day and network combo can result in confusing or broken experiences
   * in the UI. The transactions are then updated using the BaseController update.
   *
   * @param transactions - The transactions to be applied to the state.
   * @returns The trimmed list of transactions.
   */
  private trimTransactionsForState(
    transactions: TransactionMeta[],
  ): TransactionMeta[] {
    const nonceNetworkSet = new Set();

    const txsToKeep = transactions
      .sort((a, b) => (a.time > b.time ? -1 : 1)) // Descending time order
      .filter((tx) => {
        const { chainId, networkID, status, transaction, time } = tx;
        if (transaction) {
          const key = `${transaction.nonce}-${chainId ?? networkID}-${new Date(
            time,
          ).toDateString()}`;
          if (nonceNetworkSet.has(key)) {
            return true;
          } else if (
            nonceNetworkSet.size < this.config.txHistoryLimit ||
            !this.isFinalState(status)
          ) {
            nonceNetworkSet.add(key);
            return true;
          }
        }
        return false;
      });

    txsToKeep.reverse(); // Ascending time order
    return txsToKeep;
  }

  /**
   * Determines if the transaction is in a final state.
   *
   * @param status - The transaction status.
   * @returns Whether the transaction is in a final state.
   */
  private isFinalState(status: TransactionStatus): boolean {
    return (
      status === TransactionStatus.rejected ||
      status === TransactionStatus.confirmed ||
      status === TransactionStatus.failed ||
      status === TransactionStatus.cancelled
    );
  }

  private async processApproval(
    transactionMeta: TransactionMeta,
  ): Promise<string> {
    const transactionId = transactionMeta.id;
    let resultCallbacks: AcceptResultCallbacks | undefined;

    try {
      const acceptResult = await this.requestApproval(transactionMeta);
      resultCallbacks = acceptResult.resultCallbacks;

      const { meta, isCompleted } = this.isTransactionCompleted(transactionId);

      if (meta && !isCompleted) {
        await this.approveTransaction(transactionId);
      }
    } catch (error: any) {
      const { meta, isCompleted } = this.isTransactionCompleted(transactionId);

      if (meta && !isCompleted) {
        if (error.code === errorCodes.provider.userRejectedRequest) {
          this.cancelTransaction(transactionId);

          throw ethErrors.provider.userRejectedRequest(
            'User rejected the transaction',
          );
        } else {
          this.failTransaction(meta, error);
        }
      }
    }

    const finalMeta = this.getTransaction(transactionId);

    switch (finalMeta?.status) {
      case TransactionStatus.failed:
        resultCallbacks?.error(finalMeta.error);
        throw ethErrors.rpc.internal(finalMeta.error.message);

      case TransactionStatus.cancelled:
        const cancelError = ethErrors.rpc.internal(
          'User cancelled the transaction',
        );

        resultCallbacks?.error(cancelError);
        throw cancelError;

      case TransactionStatus.submitted:
        resultCallbacks?.success();
        return finalMeta.hash as string;

      default:
        const internalError = ethErrors.rpc.internal(
          `MetaMask Tx Signature: Unknown problem: ${JSON.stringify(
            finalMeta || transactionId,
          )}`,
        );

        resultCallbacks?.error(internalError);
        throw internalError;
    }
  }

  private async requestApproval(txMeta: TransactionMeta): Promise<AddResult> {
    const id = this.getApprovalId(txMeta);
    const { origin } = txMeta;
    const type = 'transaction';
    const requestData = { txId: txMeta.id };

    return this.messagingSystem.call(
      'ApprovalController:addRequest',
      {
        id,
        origin: origin || 'metamask',
        type,
        requestData,
        expectsResult: true,
      },
      true,
    ) as Promise<AddResult>;
  }

  private getApprovalId(txMeta: TransactionMeta) {
    return String(txMeta.id);
  }

  /**
   * Approves a transaction and updates it's status in state. If this is not a
   * retry transaction, a nonce will be generated. The transaction is signed
   * using the sign configuration property, then published to the blockchain.
   * A `<tx.id>:finished` hub event is fired after success or failure.
   *
   * @param transactionID - The ID of the transaction to approve.
   */
  private async approveTransaction(transactionID: string) {
    const { transactions } = this.state;
    const releaseLock = await this.mutex.acquire();
    const { providerConfig } = this.getNetworkState();
    const { chainId: currentChainId } = providerConfig;
    const index = transactions.findIndex(({ id }) => transactionID === id);
    const transactionMeta = transactions[index];
    const {
      transaction: { nonce, from },
    } = transactionMeta;
    let nonceLock;
    try {
      if (!this.sign) {
        releaseLock();
        this.failTransaction(
          transactionMeta,
          new Error('No sign method defined.'),
        );
        return;
      } else if (!currentChainId) {
        releaseLock();
        this.failTransaction(transactionMeta, new Error('No chainId defined.'));
        return;
      }

      const chainId = parseInt(currentChainId, undefined);
      const { approved: status } = TransactionStatus;
      let nonceToUse = nonce;
      // if a nonce already exists on the transactionMeta it means this is a speedup or cancel transaction
      // so we want to reuse that nonce and hope that it beats the previous attempt to chain. Otherwise use a new locked nonce
      if (!nonceToUse) {
        nonceLock = await this.nonceTracker.getNonceLock(from);
        nonceToUse = addHexPrefix(nonceLock.nextNonce.toString(16));
      }

      transactionMeta.status = status;
      transactionMeta.transaction.nonce = nonceToUse;
      transactionMeta.transaction.chainId = chainId;

      const baseTxParams = {
        ...transactionMeta.transaction,
        gasLimit: transactionMeta.transaction.gas,
      };

      const isEIP1559 = isEIP1559Transaction(transactionMeta.transaction);

      const txParams = isEIP1559
        ? {
            ...baseTxParams,
            estimatedBaseFee: transactionMeta.transaction.estimatedBaseFee,
            // specify type 2 if maxFeePerGas and maxPriorityFeePerGas are set
            type: 2,
          }
        : baseTxParams;

      const unsignedEthTx = this.prepareUnsignedEthTx(txParams);
      const signedTx = await this.sign(unsignedEthTx, from);
      transactionMeta.status = TransactionStatus.signed;
      this.updateTransaction(transactionMeta);
      const rawTx = bufferToHex(signedTx.serialize());

      transactionMeta.rawTx = rawTx;
      this.updateTransaction(transactionMeta);
      const hash = await this.publishTransaction(rawTx);
      transactionMeta.hash = hash;
      transactionMeta.status = TransactionStatus.submitted;
      this.updateTransaction(transactionMeta);
      this.hub.emit(`${transactionMeta.id}:finished`, transactionMeta);
    } catch (error: any) {
      this.failTransaction(transactionMeta, error);
    } finally {
      // must set transaction to submitted/failed before releasing lock
      if (nonceLock) {
        nonceLock.releaseLock();
      }
      releaseLock();
    }
  }

  private async publishTransaction(rawTransaction: string): Promise<string> {
    return await query(this.ethQuery, 'sendRawTransaction', [rawTransaction]);
  }

  /**
   * Cancels a transaction based on its ID by setting its status to "rejected"
   * and emitting a `<tx.id>:finished` hub event.
   *
   * @param transactionID - The ID of the transaction to cancel.
   */
  private cancelTransaction(transactionID: string) {
    const transactionMeta = this.state.transactions.find(
      ({ id }) => id === transactionID,
    );
    if (!transactionMeta) {
      return;
    }
    transactionMeta.status = TransactionStatus.rejected;
    this.hub.emit(`${transactionMeta.id}:finished`, transactionMeta);
    const transactions = this.state.transactions.filter(
      ({ id }) => id !== transactionID,
    );
    this.update({ transactions: this.trimTransactionsForState(transactions) });
  }

  /**
   * Whether the transaction has at least completed all local processing.
   *
   * @param status - The transaction status.
   * @returns Whether the transaction is in a final state.
   */
  private isLocalFinalState(status: TransactionStatus): boolean {
    return [
      TransactionStatus.cancelled,
      TransactionStatus.confirmed,
      TransactionStatus.failed,
      TransactionStatus.rejected,
      TransactionStatus.submitted,
    ].includes(status);
  }

  private getTransaction(transactionID: string): TransactionMeta | undefined {
    const { transactions } = this.state;
    return transactions.find(({ id }) => id === transactionID);
  }

  private isTransactionCompleted(transactionid: string): {
    meta?: TransactionMeta;
    isCompleted: boolean;
  } {
    const transaction = this.getTransaction(transactionid);

    if (!transaction) {
      return { meta: undefined, isCompleted: false };
    }

    const isCompleted = this.isLocalFinalState(transaction.status);

    return { meta: transaction, isCompleted };
  }

  private onIncomingTransactions({
    added,
    updated,
  }: {
    added: TransactionMeta[];
    updated: TransactionMeta[];
  }) {
    const { transactions: currentTransactions } = this.state;

    const updatedTransactions = [
      ...added,
      ...currentTransactions.map((originalTransaction) => {
        const updatedTransaction = updated.find(
          ({ hash }) => hash === originalTransaction.hash,
        );

        return updatedTransaction ?? originalTransaction;
      }),
    ];

    this.update({
      transactions: this.trimTransactionsForState(updatedTransactions),
    });

    this.hub.emit('incomingTransactions', { added, updated });
  }

  private onUpdatedLastFetchedBlockNumbers({
    lastFetchedBlockNumbers,
    blockNumber,
  }: {
    lastFetchedBlockNumbers: {
      [key: string]: number;
    };
    blockNumber: number;
  }) {
    this.update({ lastFetchedBlockNumbers });
    this.hub.emit('incomingTransactionBlock', blockNumber);
  }

  /**
   * Method to set transaction status to dropped.
   *
   * @param transactionMeta - TransactionMeta of transaction to be marked as dropped.
   */
  private setTransactionStatusDropped(transactionMeta: TransactionMeta) {
    transactionMeta.status = TransactionStatus.dropped;
    this.updateTransaction(transactionMeta);
  }

  private getNonceTrackerTransactions(
    status: TransactionStatus,
    address: string,
  ) {
    const { chainId: currentChainId } = this.getNetworkState().providerConfig;

    return getAndFormatTransactionsForNonceTracker(
      currentChainId,
      address,
      status,
      this.state.transactions,
    );
  }

  private async getEIP1559Compatibility() {
    const currentNetworkIsEIP1559Compatible =
      await this.getCurrentNetworkEIP1559Compatibility();

    const currentAccountIsEIP1559Compatible =
      this.getCurrentAccountEIP1559Compatibility?.() ?? true;

    return (
      currentNetworkIsEIP1559Compatible && currentAccountIsEIP1559Compatible
    );
  }

  private addPendingTransactionTrackerListeners() {
    this.pendingTransactionTracker.hub.on(
      'transaction-confirmed',
      (transactionMeta: TransactionMeta) =>
        this.hub.emit(`${transactionMeta.id}:confirmed`, transactionMeta),
    );

    this.pendingTransactionTracker.hub.on(
      'transaction-dropped',
      this.setTransactionStatusDropped.bind(this),
    );

    this.pendingTransactionTracker.hub.on(
      'transaction-failed',
      this.failTransaction.bind(this),
    );

    this.pendingTransactionTracker.hub.on(
      'transaction-updated',
      this.updateTransaction.bind(this),
    );
  }
}

export default TransactionController;
