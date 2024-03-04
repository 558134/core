import type {
  GasPriceValue,
  FeeMarketEIP1559Values,
} from '../TransactionController';
import type { TransactionParams } from '../types';
import * as util from './utils';

const MAX_FEE_PER_GAS = 'maxFeePerGas';
const MAX_PRIORITY_FEE_PER_GAS = 'maxPriorityFeePerGas';
const GAS_PRICE = 'gasPrice';
const FAIL = 'lol';
const PASS = '0x1';

describe('utils', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeTxParams', () => {
    const commonInput = {
      data: 'data',
      from: 'FROM',
      gas: 'gas',
      gasPrice: 'gasPrice',
      nonce: 'nonce',
      to: 'TO',
      value: 'value',
      maxFeePerGas: 'maxFeePerGas',
      maxPriorityFeePerGas: 'maxPriorityFeePerGas',
      estimatedBaseFee: 'estimatedBaseFee',
    };

    it('normalizeTransaction', () => {
      const normalized = util.normalizeTxParams({
        ...commonInput,
      });
      expect(normalized).toStrictEqual({
        data: '0xdata',
        from: '0xfrom',
        gas: '0xgas',
        gasPrice: '0xgasPrice',
        nonce: '0xnonce',
        to: '0xto',
        value: '0xvalue',
        maxFeePerGas: '0xmaxFeePerGas',
        maxPriorityFeePerGas: '0xmaxPriorityFeePerGas',
        estimatedBaseFee: '0xestimatedBaseFee',
      });
    });

    it('normalizeTransaction if type is zero', () => {
      const normalized = util.normalizeTxParams({
        ...commonInput,
        type: '0x0',
      });
      expect(normalized).toStrictEqual({
        data: '0xdata',
        from: '0xfrom',
        gas: '0xgas',
        gasPrice: '0xgasPrice',
        nonce: '0xnonce',
        to: '0xto',
        value: '0xvalue',
        maxFeePerGas: '0xmaxFeePerGas',
        maxPriorityFeePerGas: '0xmaxPriorityFeePerGas',
        estimatedBaseFee: '0xestimatedBaseFee',
        type: '0x0',
      });
    });

    it('sets value if not specified', () => {
      expect(util.normalizeTxParams({ from: '0xfrom' })).toStrictEqual({
        from: '0xfrom',
        value: '0x0',
      });
    });
  });

  describe('isEIP1559Transaction', () => {
    it('should detect EIP1559 transaction', () => {
      const tx: TransactionParams = { from: '' };
      const eip1559tx: TransactionParams = {
        ...tx,
        maxFeePerGas: '2',
        maxPriorityFeePerGas: '3',
      };
      expect(util.isEIP1559Transaction(eip1559tx)).toBe(true);
      expect(util.isEIP1559Transaction(tx)).toBe(false);
    });
  });

  describe('validateGasValues', () => {
    it('should throw when provided invalid gas values', () => {
      const gasValues: GasPriceValue = {
        [GAS_PRICE]: FAIL,
      };
      expect(() => util.validateGasValues(gasValues)).toThrow(TypeError);
      expect(() => util.validateGasValues(gasValues)).toThrow(
        `expected hex string for ${GAS_PRICE} but received: ${FAIL}`,
      );
    });

    it('should throw when any provided gas values are invalid', () => {
      const gasValues: FeeMarketEIP1559Values = {
        [MAX_PRIORITY_FEE_PER_GAS]: PASS,
        [MAX_FEE_PER_GAS]: FAIL,
      };
      expect(() => util.validateGasValues(gasValues)).toThrow(TypeError);
      expect(() => util.validateGasValues(gasValues)).toThrow(
        `expected hex string for ${MAX_FEE_PER_GAS} but received: ${FAIL}`,
      );
    });

    it('should return true when provided valid gas values', () => {
      const gasValues: FeeMarketEIP1559Values = {
        [MAX_FEE_PER_GAS]: PASS,
        [MAX_PRIORITY_FEE_PER_GAS]: PASS,
      };
      expect(() => util.validateGasValues(gasValues)).not.toThrow(TypeError);
    });
  });

  describe('isFeeMarketEIP1559Values', () => {
    it('should detect if isFeeMarketEIP1559Values', () => {
      const gasValues = {
        [MAX_PRIORITY_FEE_PER_GAS]: PASS,
        [MAX_FEE_PER_GAS]: FAIL,
      };
      expect(util.isFeeMarketEIP1559Values(gasValues)).toBe(true);
      expect(util.isGasPriceValue(gasValues)).toBe(false);
    });
  });

  describe('isGasPriceValue', () => {
    it('should detect if isGasPriceValue', () => {
      const gasValues: GasPriceValue = {
        [GAS_PRICE]: PASS,
      };
      expect(util.isGasPriceValue(gasValues)).toBe(true);
      expect(util.isFeeMarketEIP1559Values(gasValues)).toBe(false);
    });
  });

  describe('getIncreasedPriceHex', () => {
    it('should get increased price from number as hex', () => {
      expect(util.getIncreasedPriceHex(1358778842, 1.1)).toBe('0x5916a6d6');
    });
  });

  describe('getIncreasedPriceFromExisting', () => {
    it('should get increased price from hex as hex', () => {
      expect(util.getIncreasedPriceFromExisting('0x50fd51da', 1.1)).toBe(
        '0x5916a6d6',
      );
    });
  });

  describe('validateMinimumIncrease', () => {
    it('should throw if increase does not meet minimum requirement', () => {
      expect(() =>
        util.validateMinimumIncrease('0x50fd51da', '0x5916a6d6'),
      ).toThrow(Error);

      expect(() =>
        util.validateMinimumIncrease('0x50fd51da', '0x5916a6d6'),
      ).toThrow(
        'The proposed value: 1358778842 should meet or exceed the minimum value: 1494656726',
      );
    });

    it('should not throw if increase meets minimum requirement', () => {
      expect(() =>
        util.validateMinimumIncrease('0x5916a6d6', '0x5916a6d6'),
      ).not.toThrow(Error);
    });

    it('should not throw if increase exceeds minimum requirement', () => {
      expect(() =>
        util.validateMinimumIncrease('0x7162a5ca', '0x5916a6d6'),
      ).not.toThrow(Error);
    });
  });

  describe('normalizeTxError', () => {
    const errorBase = {
      name: 'TxError',
      message: 'An error occurred',
      stack: 'Error stack trace',
    };
    it('returns the error object with no code and rpc properties', () => {
      const normalizedError = util.normalizeTxError(errorBase);

      expect(normalizedError).toStrictEqual({
        ...errorBase,
        code: undefined,
        rpc: undefined,
      });
    });

    it('returns the error object with code and rpc properties', () => {
      const error = {
        ...errorBase,
        code: 'ERROR_CODE',
        value: { code: 'rpc data' },
      };

      const normalizedError = util.normalizeTxError(error);

      expect(normalizedError).toStrictEqual({
        ...errorBase,
        code: 'ERROR_CODE',
        rpc: { code: 'rpc data' },
      });
    });
  });

  describe('normalizeGasFeeValues', () => {
    it('returns normalized object if legacy gas fees', () => {
      expect(
        // TODO: Replace `any` with type
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        util.normalizeGasFeeValues({ gasPrice: '1A', test: 'value' } as any),
      ).toStrictEqual({ gasPrice: '0x1A' });
    });

    it('returns normalized object if 1559 gas fees', () => {
      expect(
        util.normalizeGasFeeValues({
          maxFeePerGas: '1A',
          maxPriorityFeePerGas: '2B3C',
          test: 'value',
          // TODO: Replace `any` with type
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ).toStrictEqual({ maxFeePerGas: '0x1A', maxPriorityFeePerGas: '0x2B3C' });
    });

    it('returns empty 1559 object if missing gas fees', () => {
      expect(
        util.normalizeGasFeeValues({
          test: 'value',
          // TODO: Replace `any` with type
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ).toStrictEqual({
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      });
    });
  });

  describe('pickMiddleFeeElement', () => {
    it('picks the middle element from an array with an odd length', () => {
      const fees = [
        { maxFeePerGas: 300, maxPriorityFeePerGas: 30 },
        { maxFeePerGas: 100, maxPriorityFeePerGas: 10 },
        { maxFeePerGas: 200, maxPriorityFeePerGas: 20 },
      ];
      const expected = { maxFeePerGas: 200, maxPriorityFeePerGas: 20 };
      expect(util.pickMiddleFeeElement(fees)).toStrictEqual(expected);
    });

    it('picks the middle-right element from an array with an even length', () => {
      const fees = [
        { maxFeePerGas: 400, maxPriorityFeePerGas: 40 },
        { maxFeePerGas: 100, maxPriorityFeePerGas: 10 },
        { maxFeePerGas: 300, maxPriorityFeePerGas: 30 },
        { maxFeePerGas: 200, maxPriorityFeePerGas: 20 },
      ];
      const expected = { maxFeePerGas: 300, maxPriorityFeePerGas: 30 };
      expect(util.pickMiddleFeeElement(fees)).toStrictEqual(expected);
    });

    it('handles an array with a single element', () => {
      const fees = [{ maxFeePerGas: 100, maxPriorityFeePerGas: 10 }];
      const expected = { maxFeePerGas: 100, maxPriorityFeePerGas: 10 };
      expect(util.pickMiddleFeeElement(fees)).toStrictEqual(expected);
    });

    it('handles an empty array', () => {
      const fees = [] as {
        maxFeePerGas: number;
        maxPriorityFeePerGas: number;
      }[];
      expect(util.pickMiddleFeeElement(fees)).toBeUndefined();
    });

    it('correctly sorts the array before picking the middle element', () => {
      const fees = [
        { maxFeePerGas: 500, maxPriorityFeePerGas: 50 },
        { maxFeePerGas: 100, maxPriorityFeePerGas: 10 },
        { maxFeePerGas: 400, maxPriorityFeePerGas: 40 },
        { maxFeePerGas: 200, maxPriorityFeePerGas: 20 },
        { maxFeePerGas: 300, maxPriorityFeePerGas: 30 },
      ];
      const expected = { maxFeePerGas: 300, maxPriorityFeePerGas: 30 };
      expect(util.pickMiddleFeeElement(fees)).toStrictEqual(expected);
    });
  });
});
