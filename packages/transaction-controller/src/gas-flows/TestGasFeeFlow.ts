import {
  convertHexToDecimal,
  hexToBN,
  toHex,
} from '@metamask/controller-utils';

import { BN } from 'ethereumjs-util';
import type {
  GasFeeEstimatesLevel,
  GasFeeFlow,
  GasFeeFlowRequest,
  GasFeeFlowResponse,
  TransactionMeta,
} from '../types';
import { CHAIN_IDS } from '../constants';

const MULTIPLIER = 10e17;

const LEVEL_INCREMENTS = {
  low: 0,
  medium: 1,
  high: 2,
};

type Level = keyof typeof LEVEL_INCREMENTS;

export class TestGasFeeFlow implements GasFeeFlow {
  #increment = 0;

  matchesTransaction(transactionMeta: TransactionMeta): boolean {
    return (
      transactionMeta.chainId ===
      convertHexToDecimal(CHAIN_IDS.SEPOLIA).toString()
    );
  }

  async getGasFees(request: GasFeeFlowRequest): Promise<GasFeeFlowResponse> {
    const { transactionMeta } = request;

    this.#increment += 1;

    const gasRaw = transactionMeta.transaction.gas;
    const gasBN = BN.isBN(gasRaw) ? gasRaw : hexToBN(gasRaw as string);
    const gas = gasBN.toNumber();

    return {
      estimates: {
        low: this.#getFeeLevel('low', gas),
        medium: this.#getFeeLevel('medium', gas),
        high: this.#getFeeLevel('high', gas),
      },
    };
  }

  #getFeeLevel(level: Level, gas: number): GasFeeEstimatesLevel {
    const maxFeePerGas = Math.floor(
      ((this.#increment + LEVEL_INCREMENTS[level]) * MULTIPLIER) / gas,
    );

    const maxPriorityFeePerGas = Math.floor(maxFeePerGas * 0.2);

    return {
      maxFeePerGas: toHex(maxFeePerGas),
      maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
    };
  }
}
