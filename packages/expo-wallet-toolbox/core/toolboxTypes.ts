/**
 * Flat aliases for @bsv/wallet-toolbox-mobile types that the package exports
 * only under its `sdk` namespace. Since 2.13 the toolbox ships as one bundle
 * whose exports map exposes just the package root, so the former
 * `out/src/...` deep imports no longer resolve.
 */
import type { sdk } from '@bsv/wallet-toolbox-mobile'

export type AuthId = sdk.AuthId
export type BsvExchangeRate = sdk.BsvExchangeRate
export type FindCertificateFieldsArgs = sdk.FindCertificateFieldsArgs
export type FindCertificatesArgs = sdk.FindCertificatesArgs
export type FindCommissionsArgs = sdk.FindCommissionsArgs
export type FindForUserSincePagedArgs = sdk.FindForUserSincePagedArgs
export type FindMonitorEventsArgs = sdk.FindMonitorEventsArgs
export type FindOutputBasketsArgs = sdk.FindOutputBasketsArgs
export type FindOutputTagMapsArgs = sdk.FindOutputTagMapsArgs
export type FindOutputTagsArgs = sdk.FindOutputTagsArgs
export type FindOutputsArgs = sdk.FindOutputsArgs
export type FindProvenTxReqsArgs = sdk.FindProvenTxReqsArgs
export type FindProvenTxsArgs = sdk.FindProvenTxsArgs
export type FindSyncStatesArgs = sdk.FindSyncStatesArgs
export type FindTransactionsArgs = sdk.FindTransactionsArgs
export type FindTxLabelMapsArgs = sdk.FindTxLabelMapsArgs
export type FindTxLabelsArgs = sdk.FindTxLabelsArgs
export type FindUsersArgs = sdk.FindUsersArgs
export type PostBeefResult = sdk.PostBeefResult
export type PostTxResultForTxid = sdk.PostTxResultForTxid
export type ProcessSyncChunkResult = sdk.ProcessSyncChunkResult
export type ProvenOrRawTx = sdk.ProvenOrRawTx
export type ProvenTxReqStatus = sdk.ProvenTxReqStatus
export type PurgeParams = sdk.PurgeParams
export type PurgeResults = sdk.PurgeResults
export type RequestSyncChunkArgs = sdk.RequestSyncChunkArgs
export type StorageProcessActionArgs = sdk.StorageProcessActionArgs
export type StorageProcessActionResults = sdk.StorageProcessActionResults
export type SyncChunk = sdk.SyncChunk
export type TrxToken = sdk.TrxToken
export type UpdateProvenTxReqWithNewProvenTxArgs = sdk.UpdateProvenTxReqWithNewProvenTxArgs
export type WalletServicesOptions = sdk.WalletServicesOptions
