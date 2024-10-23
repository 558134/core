import {
  isCaipNamespace,
  isCaipChainId,
  parseCaipChainId,
} from '@metamask/utils';
import type {
  CaipChainId,
  CaipReference,
  CaipAccountId,
  KnownCaipNamespace,
  CaipNamespace,
  Json,
} from '@metamask/utils';

// These External prefixed types represent the CAIP-217
// Scope and ScopeObject as defined in the spec.
export type ExternalScopeString = CaipChainId | CaipNamespace;
export type ExternalScopeObject = Omit<ScopeObject, 'accounts'> & {
  references?: CaipReference[];
  accounts?: CaipAccountId[];
};
export type ExternalScopesObject = Record<
  ExternalScopeString,
  ExternalScopeObject
>;

// These non-prefixed types represent CAIP-217 Scope and
// ScopeObject as defined by the spec but without
// namespace-only Scopes (except for "wallet") and without
// the `references` array of CAIP References on the ScopeObject.
// These deviations from the spec are necessary as MetaMask
// does not support wildcarded Scopes, i.e. Scopes that only
// specify a namespace but no specific reference.
export type ScopeString = CaipChainId | KnownCaipNamespace.Wallet;
export type ScopeObject = {
  methods: string[];
  notifications: string[];
  accounts: CaipAccountId[];
  rpcDocuments?: string[];
  rpcEndpoints?: string[];
};
export type ScopesObject = Record<CaipChainId, ScopeObject> & {
  [KnownCaipNamespace.Wallet]?: ScopeObject;
};

export type ScopedProperties = Record<CaipChainId, Record<string, Json>> & {
  [KnownCaipNamespace.Wallet]?: Record<string, Json>;
};

export const parseScopeString = (
  scopeString: string,
): {
  namespace?: string;
  reference?: string;
} => {
  if (isCaipNamespace(scopeString)) {
    return {
      namespace: scopeString,
    };
  }
  if (isCaipChainId(scopeString)) {
    return parseCaipChainId(scopeString);
  }

  return {};
};

// ScopeString for ecosystems that aren't chain specific
export enum KnownWalletScopeString {
  Eip155 = 'wallet:eip155',
}

// Known CAIP Namespaces excluding "wallet"
export type NonWalletKnownCaipNamespace = Exclude<
  KnownCaipNamespace,
  KnownCaipNamespace.Wallet
>;
