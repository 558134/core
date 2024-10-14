import { toHex } from '@metamask/controller-utils';
import type { CaipAccountId, Hex } from '@metamask/utils';
import {
  isCaipChainId,
  isCaipNamespace,
  KnownCaipNamespace,
  parseCaipAccountId,
  parseCaipChainId,
} from '@metamask/utils';

import type { NonWalletKnownCaipNamespace, ExternalScopeString } from './types';
import {
  KnownNotifications,
  KnownRpcMethods,
  KnownWalletNamespaceRpcMethods,
  KnownWalletRpcMethods,
  parseScopeString,
} from './types';

// TODO Maybe this gets DRY'ed into utils?.. It's used in TokenDetectionController too
/**
 * Checks if two strings are equal, ignoring case.
 *
 * @param value1 - The first string to compare.
 * @param value2 - The second string to compare.
 * @returns `true` if the strings are equal, ignoring case; otherwise, `false`.
 */
function isEqualCaseInsensitive(value1: string, value2: string): boolean {
  if (typeof value1 !== 'string' || typeof value2 !== 'string') {
    return false;
  }
  return value1.toLowerCase() === value2.toLowerCase();
}

export const isSupportedScopeString = (
  scopeString: string,
  isChainIdSupported: (chainId: Hex) => boolean,
) => {
  const isNamespaceScoped = isCaipNamespace(scopeString);
  const isChainScoped = isCaipChainId(scopeString);

  if (isNamespaceScoped) {
    switch (scopeString) {
      case KnownCaipNamespace.Wallet:
        return true;
      case KnownCaipNamespace.Eip155:
        return true;
      default:
        return false;
    }
  }

  if (isChainScoped) {
    const { namespace, reference } = parseCaipChainId(scopeString);
    switch (namespace) {
      case KnownCaipNamespace.Wallet:
        if (reference === KnownCaipNamespace.Eip155) {
          return true;
        }
        return false;
      case KnownCaipNamespace.Eip155:
        return isChainIdSupported(toHex(reference));
      default:
        return false;
    }
  }

  return false;
};

export const isSupportedAccount = (
  account: CaipAccountId,
  getInternalAccounts: () => { type: string; address: string }[],
) => {
  const {
    address,
    chain: { namespace },
  } = parseCaipAccountId(account);
  switch (namespace) {
    case KnownCaipNamespace.Eip155:
      try {
        return getInternalAccounts().some(
          (internalAccount) =>
            ['eip155:eoa', 'eip155:erc4337'].includes(internalAccount.type) &&
            isEqualCaseInsensitive(address, internalAccount.address),
        );
      } catch (err) {
        console.log('failed to check if account is supported by wallet', err);
      }
      return false;
    default:
      return false;
  }
};

export const isSupportedMethod = (
  scopeString: ExternalScopeString,
  method: string,
): boolean => {
  const { namespace, reference } = parseScopeString(scopeString);

  if (namespace === KnownCaipNamespace.Wallet) {
    if (reference) {
      return (
        KnownWalletNamespaceRpcMethods[
          reference as NonWalletKnownCaipNamespace
        ] || []
      ).includes(method);
    }

    return KnownWalletRpcMethods.includes(method);
  }

  return (
    KnownRpcMethods[namespace as NonWalletKnownCaipNamespace] || []
  ).includes(method);
};

export const isSupportedNotification = (
  scopeString: ExternalScopeString,
  notification: string,
): boolean => {
  const { namespace } = parseScopeString(scopeString);

  return (
    KnownNotifications[namespace as NonWalletKnownCaipNamespace] || []
  ).includes(notification);
};
