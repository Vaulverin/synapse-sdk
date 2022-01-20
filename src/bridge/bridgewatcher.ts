import {Bridge} from "./bridge";

import {newProviderForNetwork} from "../rpcproviders";

import {rejectPromise, makeKappa} from "../common/utils";

import {SynapseEntities} from "../entities";

import {keccak256} from "@ethersproject/keccak256"
import {toUtf8Bytes} from "@ethersproject/strings"
import {Filter} from "@ethersproject/providers";
import {BigNumber} from "@ethersproject/bignumber";
import {SynapseContracts} from "../common";
import {hexZeroPad} from "@ethersproject/bytes";
import {getAddress} from "@ethersproject/address";

export namespace BridgeWatcher {
    export interface CheckBridgeTransactionParams {
        transactionHash:      string,
        sourceChainId:        number,
        destintationChainId?: number,
    }

    export interface ChainTransactionInfo {
        transactionHash: string,
        chainId:         number,
        from:            string,
        to:              string,
        blockNum?:       number,
        confirmations:   number,
        pending:         boolean,
    }

    export interface BridgeTransactionStatusResponse {
        sourceChainTransaction:       ChainTransactionInfo,
        destinationChainTransaction?: ChainTransactionInfo,
        status:                       BridgeTransactionStatus,
    }

    export enum BridgeTransactionStatus {
        PendingSourceChain     = "Waiting for transaction to be mined on source chain",
        NeedsConfsSourceChain  = "Waiting for required number of confirmations on source chain",
        PendingCreditDestChain = "Waiting to be credited on destination chain",
        Complete               = "Completed",
    }

    interface UserBridgeTxn {
        to:      string,
        chainId: number,
    }

    const
        tokenDepositEvent           = "TokenDeposit(address,uint256,address,uint256)",
        tokenDepositAndSwapEvent    = "TokenDepositAndSwap(address,uint256,address,uint256,uint8,uint8,uint256,uint256)",
        tokenMintEvent              = "TokenMint(address,address,uint256,uint256,bytes32)",
        tokenMintAndSwapEvent       = "TokenMintAndSwap(address,address,uint256,uint256,uint8,uint8,uint256,uint256,bool,bytes32)",
        tokenRedeemEvent            = "TokenRedeem(address,uint256,address,uint256)",
        tokenRedeemAndRemoveEvent   = "TokenRedeemAndRemove(address,uint256,address,uint256,uint8,uint256,uint256)",
        tokenRedeemAndSwapEvent     = "TokenRedeemAndSwap(address,uint256,address,uint256,uint8,uint8,uint256,uint256)",
        tokenWithdrawEvent          = "TokenWithdraw(address,address,uint256,uint256,bytes32)",
        tokenWithdrawAndRemoveEvent = "TokenWithdrawAndRemove(address,address,uint256,uint256,uint8,uint256,uint256,bool,bytes32)";

    const hashEventName = (event: string): string => keccak256(toUtf8Bytes(event));

    const desiredEventTopicHashes: string[] = [
        hashEventName(tokenDepositEvent),
        hashEventName(tokenDepositAndSwapEvent),
        hashEventName(tokenMintEvent),
        hashEventName(tokenMintAndSwapEvent),
        hashEventName(tokenRedeemEvent),
        hashEventName(tokenRedeemAndRemoveEvent),
        hashEventName(tokenRedeemAndSwapEvent),
        hashEventName(tokenWithdrawEvent),
        hashEventName(tokenWithdrawAndRemoveEvent),
    ]

    export async function checkTransactionStatus(args: CheckBridgeTransactionParams): Promise<BridgeTransactionStatusResponse> {
        const srcTxn = await getTxn(args.transactionHash, args.sourceChainId);

        if (srcTxn.pending) {
            return {
                sourceChainTransaction: srcTxn,
                status:                 BridgeTransactionStatus.PendingSourceChain,
            }
        }

        const reqConfs = Bridge.getRequiredConfirmationsForBridge(srcTxn.chainId);
        if (srcTxn.confirmations < reqConfs) {
            return {
                sourceChainTransaction: srcTxn,
                status:                 BridgeTransactionStatus.NeedsConfsSourceChain,
            }
        }

        const userSendEvent = await getUserSendEvent(srcTxn);
        if (userSendEvent === null) {
            return null
        }

        let destBridge = new Bridge.SynapseBridge({network: userSendEvent.chainId})
        const kappa = makeKappa(srcTxn.transactionHash);

        const kappaExists: boolean = await destBridge.kappaExists({kappa});

        if (!kappaExists) {
            return {
                sourceChainTransaction: srcTxn,
                status: BridgeTransactionStatus.PendingCreditDestChain,
            }
        }

        const outputTxn = await getDestinationChainTxn(srcTxn, userSendEvent);
        if (outputTxn === null) {
            return {
                sourceChainTransaction: srcTxn,
                status: BridgeTransactionStatus.Complete,
            }
        }

        let tempRet: BridgeTransactionStatusResponse = {
            sourceChainTransaction:      srcTxn,
            destinationChainTransaction: outputTxn,
            status: BridgeTransactionStatus.Complete,
        }

        console.log(tempRet);

        return null;
    }

    async function getTxn(txid: string, chainId: number): Promise<ChainTransactionInfo> {
        const provider = newProviderForNetwork(chainId);

        return provider.getTransaction(txid)
            .then(({hash, blockNumber, confirmations, from, to}): ChainTransactionInfo =>
                ({
                    chainId, from, to,
                    transactionHash: hash,
                    blockNum:        blockNumber,
                    confirmations:   confirmations,
                    pending:         (typeof blockNumber === 'undefined')
                })
            )
            .catch(rejectPromise)
    }

    async function getUserSendEvent(txn: ChainTransactionInfo): Promise<UserBridgeTxn> {
        const
            provider = newProviderForNetwork(txn.chainId),
            bridge   = SynapseEntities.synapseBridge({chainId: txn.chainId, signerOrProvider: provider});

        const txnReceipt = await provider.getTransactionReceipt(txn.transactionHash);
        let bridgeEvent = txnReceipt.logs.find((logItem) => desiredEventTopicHashes.includes(logItem.topics[0]))
        if (typeof bridgeEvent === "undefined") {
            return null
        }

        let
            parsed = bridge.interface.parseLog(bridgeEvent),
            {to, chainId} = parsed.args;

        chainId = BigNumber.from(chainId).toNumber();

        return {to, chainId}
    }

    async function getDestinationChainTxn(txn: ChainTransactionInfo, userSendEvent: UserBridgeTxn): Promise<ChainTransactionInfo> {
        const provider = newProviderForNetwork(userSendEvent.chainId);

        const filter: Filter = {
            address: getAddress(SynapseContracts.bridgeAddressForChain(userSendEvent.chainId)),
            topics: [
                null,
                hexZeroPad(getAddress(userSendEvent.to), 32),
                makeKappa(txn.transactionHash),
            ],
        }

        let allLogs = await provider.getLogs(filter);
        if (allLogs.length === 0) {
            return null
        }

        let
            eventLog = allLogs[0],
            eventTxn = await provider.getTransactionReceipt(eventLog.transactionHash);

        return {
            transactionHash: eventTxn.transactionHash,
            blockNum:        eventTxn.blockNumber,
            confirmations:   eventTxn.confirmations,
            pending:         (typeof eventTxn.blockNumber === "undefined"),
            from:             SynapseContracts.bridgeAddressForChain(userSendEvent.chainId),
            to:               userSendEvent.to,
            chainId:          userSendEvent.chainId,
        }
    }
}