import {
  HEX_STR_TRANSACTION_VERSION_1,
  HEX_STR_TRANSACTION_VERSION_2,
  HEX_STR_TRANSACTION_VERSION_3,
  NetworkName,
  StarknetChainId,
} from '../constants';
import { LibraryError } from '../provider/errors';
import {
  AccountInvocationItem,
  AccountInvocations,
  BigNumberish,
  BlockIdentifier,
  BlockTag,
  Call,
  DeclareContractTransaction,
  DeployAccountContractTransaction,
  Invocation,
  InvocationsDetailsWithNonce,
  RPC,
  RpcProviderOptions,
  TransactionType,
  getEstimateFeeBulkOptions,
  getSimulateTransactionOptions,
  waitForTransactionOptions,
} from '../types';
import { CallData } from '../utils/calldata';
import { isSierra } from '../utils/contract';
import fetch from '../utils/fetchPonyfill';
import { getSelector, getSelectorFromName, getVersionsByType } from '../utils/hash';
import { stringify } from '../utils/json';
import { getHexStringArray, toHex, toStorageKey } from '../utils/num';
import { Block, getDefaultNodeUrl, isV3Tx, wait } from '../utils/provider';
import { decompressProgram, signatureToHexArray } from '../utils/stark';

const defaultOptions = {
  headers: { 'Content-Type': 'application/json' },
  blockIdentifier: BlockTag.pending,
  retries: 200,
};

export class RpcChannel {
  public nodeUrl: string;

  public headers: object;

  readonly retries: number;

  readonly blockIdentifier: BlockIdentifier;

  private chainId?: StarknetChainId;

  readonly waitMode: Boolean; // behave like web2 rpc and return when tx is processed

  readonly version = 'v0_6';

  constructor(optionsOrProvider?: RpcProviderOptions) {
    const { nodeUrl, retries, headers, blockIdentifier, chainId, waitMode } =
      optionsOrProvider || {};
    if (Object.values(NetworkName).includes(nodeUrl as NetworkName)) {
      this.nodeUrl = getDefaultNodeUrl(nodeUrl as NetworkName, optionsOrProvider?.default);
    } else if (nodeUrl) {
      this.nodeUrl = nodeUrl;
    } else {
      this.nodeUrl = getDefaultNodeUrl(undefined, optionsOrProvider?.default);
    }
    this.retries = retries || defaultOptions.retries;
    this.headers = { ...defaultOptions.headers, ...headers };
    this.blockIdentifier = blockIdentifier || defaultOptions.blockIdentifier;
    this.chainId = chainId;
    this.waitMode = waitMode || false;
  }

  public fetch(method: string, params?: object, id: string | number = 0) {
    const rpcRequestBody: RPC.JRPC.RequestBody = {
      id,
      jsonrpc: '2.0',
      method,
      ...(params && { params }),
    };
    return fetch(this.nodeUrl, {
      method: 'POST',
      body: stringify(rpcRequestBody),
      headers: this.headers as Record<string, string>,
    });
  }

  protected errorHandler(method: string, params: any, rpcError?: RPC.JRPC.Error, otherError?: any) {
    if (rpcError) {
      const { code, message, data } = rpcError;
      throw new LibraryError(
        `RPC: ${method} with params ${stringify(params)}\n ${code}: ${message}: ${stringify(data)}`
      );
    }
    if (otherError instanceof LibraryError) {
      throw otherError;
    }
    if (otherError) {
      throw Error(otherError.message);
    }
  }

  protected async fetchEndpoint<T extends keyof RPC.V0_6.Methods>(
    method: T,
    params?: RPC.V0_6.Methods[T]['params']
  ): Promise<RPC.V0_6.Methods[T]['result']> {
    try {
      const rawResult = await this.fetch(method, params);
      const { error, result } = await rawResult.json();
      this.errorHandler(method, params, error);
      return result as RPC.V0_6.Methods[T]['result'];
    } catch (error: any) {
      this.errorHandler(method, params, error?.response?.data, error);
      throw error;
    }
  }

  public async getChainId() {
    this.chainId ??= (await this.fetchEndpoint('starknet_chainId')) as StarknetChainId;
    return this.chainId;
  }

  public getSpecVersion() {
    return this.fetchEndpoint('starknet_specVersion');
  }

  public getNonceForAddress(
    contractAddress: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const contract_address = toHex(contractAddress);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getNonce', {
      contract_address,
      block_id,
    });
  }

  /**
   * Get the most recent accepted block hash and number
   */
  public getBlockLatestAccepted() {
    return this.fetchEndpoint('starknet_blockHashAndNumber');
  }

  /**
   * Get the most recent accepted block number
   * redundant use getBlockLatestAccepted();
   * @returns Number of the latest block
   */
  public getBlockNumber() {
    return this.fetchEndpoint('starknet_blockNumber');
  }

  public getBlockWithTxHashes(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockWithTxHashes', { block_id });
  }

  public getBlockWithTxs(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockWithTxs', { block_id });
  }

  public getBlockStateUpdate(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getStateUpdate', { block_id });
  }

  public getBlockTransactionsTraces(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_traceBlockTransactions', { block_id });
  }

  public getBlockTransactionCount(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockTransactionCount', { block_id });
  }

  public getTransactionByHash(txHash: BigNumberish) {
    const transaction_hash = toHex(txHash);
    return this.fetchEndpoint('starknet_getTransactionByHash', {
      transaction_hash,
    });
  }

  public getTransactionByBlockIdAndIndex(blockIdentifier: BlockIdentifier, index: number) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getTransactionByBlockIdAndIndex', { block_id, index });
  }

  public getTransactionReceipt(txHash: BigNumberish) {
    const transaction_hash = toHex(txHash);
    return this.fetchEndpoint('starknet_getTransactionReceipt', { transaction_hash });
  }

  public getTransactionTrace(txHash: BigNumberish) {
    const transaction_hash = toHex(txHash);
    return this.fetchEndpoint('starknet_traceTransaction', { transaction_hash });
  }

  /**
   * Get the status of a transaction
   */
  public getTransactionStatus(transactionHash: BigNumberish) {
    const transaction_hash = toHex(transactionHash);
    return this.fetchEndpoint('starknet_getTransactionStatus', { transaction_hash });
  }

  /**
   * @param invocations AccountInvocations
   * @param simulateTransactionOptions blockIdentifier and flags to skip validation and fee charge<br/>
   * - blockIdentifier<br/>
   * - skipValidate (default false)<br/>
   * - skipFeeCharge (default true)<br/>
   */
  public simulateTransaction(
    invocations: AccountInvocations,
    {
      blockIdentifier = this.blockIdentifier,
      skipValidate = false,
      skipFeeCharge = true,
    }: getSimulateTransactionOptions = {}
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    const simulationFlags = [];
    if (skipValidate) simulationFlags.push(RPC.V0_6.ESimulationFlag.SKIP_VALIDATE);
    if (skipFeeCharge) simulationFlags.push(RPC.V0_6.ESimulationFlag.SKIP_FEE_CHARGE);

    return this.fetchEndpoint('starknet_simulateTransactions', {
      block_id,
      transactions: invocations.map((it) => this.buildTransaction(it)),
      simulation_flags: simulationFlags,
    });
  }

  public async waitForTransaction(txHash: BigNumberish, options?: waitForTransactionOptions) {
    const transactionHash = toHex(txHash);
    let { retries } = this;
    let onchain = false;
    let isErrorState = false;
    const retryInterval = options?.retryInterval ?? 5000;
    const errorStates: any = options?.errorStates ?? [
      RPC.V0_6.ETransactionStatus.REJECTED,
      RPC.V0_6.ETransactionExecutionStatus.REVERTED,
    ];
    const successStates: any = options?.successStates ?? [
      RPC.V0_6.ETransactionExecutionStatus.SUCCEEDED,
      RPC.V0_6.ETransactionStatus.ACCEPTED_ON_L2,
      RPC.V0_6.ETransactionStatus.ACCEPTED_ON_L1,
    ];

    let txStatus: RPC.V0_6.TransactionStatus;
    while (!onchain) {
      // eslint-disable-next-line no-await-in-loop
      await wait(retryInterval);
      try {
        // eslint-disable-next-line no-await-in-loop
        txStatus = await this.getTransactionStatus(transactionHash);

        const executionStatus = txStatus.execution_status;
        const finalityStatus = txStatus.finality_status;

        if (!finalityStatus) {
          // Transaction is potentially NOT_RECEIVED or RPC not Synced yet
          // so we will retry '{ retries }' times
          const error = new Error('waiting for transaction status');
          throw error;
        }

        if (successStates.includes(executionStatus) || successStates.includes(finalityStatus)) {
          onchain = true;
        } else if (errorStates.includes(executionStatus) || errorStates.includes(finalityStatus)) {
          const message = `${executionStatus}: ${finalityStatus}`;
          const error = new Error(message) as Error & { response: RPC.V0_6.TransactionStatus };
          error.response = txStatus;
          isErrorState = true;
          throw error;
        }
      } catch (error) {
        if (error instanceof Error && isErrorState) {
          throw error;
        }

        if (retries <= 0) {
          throw new Error(`waitForTransaction timed-out with retries ${this.retries}`);
        }
      }

      retries -= 1;
    }

    /**
     * For some nodes even though the transaction has executionStatus SUCCEEDED finalityStatus ACCEPTED_ON_L2, getTransactionReceipt returns "Transaction hash not found"
     * Retry until rpc is actually ready to work with txHash
     */
    let txReceipt = null;
    while (txReceipt === null) {
      try {
        // eslint-disable-next-line no-await-in-loop
        txReceipt = await this.getTransactionReceipt(transactionHash);
      } catch (error) {
        if (retries <= 0) {
          throw new Error(`waitForTransaction timed-out with retries ${this.retries}`);
        }
      }
      retries -= 1;
      // eslint-disable-next-line no-await-in-loop
      await wait(retryInterval);
    }
    return txReceipt as RPC.V0_6.SPEC.TXN_RECEIPT;
  }

  public getStorageAt(
    contractAddress: BigNumberish,
    key: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const contract_address = toHex(contractAddress);
    const parsedKey = toStorageKey(key);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getStorageAt', {
      contract_address,
      key: parsedKey,
      block_id,
    });
  }

  public getClassHashAt(
    contractAddress: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const contract_address = toHex(contractAddress);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClassHashAt', {
      block_id,
      contract_address,
    });
  }

  public getClass(
    classHash: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const class_hash = toHex(classHash);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClass', {
      class_hash,
      block_id,
    });
  }

  public getClassAt(
    contractAddress: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const contract_address = toHex(contractAddress);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClassAt', {
      block_id,
      contract_address,
    });
  }

  public getEstimateFee(
    invocations: AccountInvocations,
    { blockIdentifier = this.blockIdentifier }: getEstimateFeeBulkOptions
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_estimateFee', {
      request: invocations.map((it) => this.buildTransaction(it, 'fee')),
      block_id,
    });
  }

  public async invoke(functionInvocation: Invocation, details: InvocationsDetailsWithNonce) {
    let promise;
    if (!isV3Tx(details)) {
      // V1
      promise = this.fetchEndpoint('starknet_addInvokeTransaction', {
        invoke_transaction: {
          sender_address: functionInvocation.contractAddress,
          calldata: CallData.toHex(functionInvocation.calldata),
          type: RPC.V0_6.ETransactionType.INVOKE,
          max_fee: toHex(details.maxFee || 0),
          version: HEX_STR_TRANSACTION_VERSION_1,
          signature: signatureToHexArray(functionInvocation.signature),
          nonce: toHex(details.nonce),
        },
      });
    } else {
      // V3
      promise = this.fetchEndpoint('starknet_addInvokeTransaction', {
        invoke_transaction: {
          type: RPC.V0_6.ETransactionType.INVOKE,
          sender_address: functionInvocation.contractAddress,
          calldata: CallData.toHex(functionInvocation.calldata),
          version: HEX_STR_TRANSACTION_VERSION_3,
          signature: signatureToHexArray(functionInvocation.signature),
          nonce: toHex(details.nonce),
          resource_bounds: details.resourceBounds,
          tip: toHex(details.tip),
          paymaster_data: details.paymasterData.map((it) => toHex(it)),
          account_deployment_data: details.accountDeploymentData.map((it) => toHex(it)),
          nonce_data_availability_mode: details.nonceDataAvailabilityMode,
          fee_data_availability_mode: details.feeDataAvailabilityMode,
        },
      });
    }

    return this.waitMode ? this.waitForTransaction((await promise).transaction_hash) : promise;
  }

  public async declare(
    { contract, signature, senderAddress, compiledClassHash }: DeclareContractTransaction,
    details: InvocationsDetailsWithNonce
  ) {
    let promise;
    if (!isSierra(contract) && !isV3Tx(details)) {
      // V1 Cairo 0
      promise = this.fetchEndpoint('starknet_addDeclareTransaction', {
        declare_transaction: {
          type: RPC.V0_6.ETransactionType.DECLARE,
          contract_class: {
            program: contract.program,
            entry_points_by_type: contract.entry_points_by_type,
            abi: contract.abi,
          },
          version: HEX_STR_TRANSACTION_VERSION_1,
          max_fee: toHex(details.maxFee || 0),
          signature: signatureToHexArray(signature),
          sender_address: senderAddress,
          nonce: toHex(details.nonce),
        },
      });
    } else if (isSierra(contract) && !isV3Tx(details)) {
      // V2 Cairo1
      promise = this.fetchEndpoint('starknet_addDeclareTransaction', {
        declare_transaction: {
          type: RPC.V0_6.ETransactionType.DECLARE,
          contract_class: {
            sierra_program: decompressProgram(contract.sierra_program),
            contract_class_version: contract.contract_class_version,
            entry_points_by_type: contract.entry_points_by_type,
            abi: contract.abi,
          },
          compiled_class_hash: compiledClassHash || '',
          version: HEX_STR_TRANSACTION_VERSION_2,
          max_fee: toHex(details.maxFee || 0),
          signature: signatureToHexArray(signature),
          sender_address: senderAddress,
          nonce: toHex(details.nonce),
        },
      });
    } else if (isSierra(contract) && isV3Tx(details)) {
      // V3 Cairo1
      promise = this.fetchEndpoint('starknet_addDeclareTransaction', {
        declare_transaction: {
          type: RPC.V0_6.ETransactionType.DECLARE,
          sender_address: senderAddress,
          compiled_class_hash: compiledClassHash || '',
          version: HEX_STR_TRANSACTION_VERSION_3,
          signature: signatureToHexArray(signature),
          nonce: toHex(details.nonce),
          contract_class: {
            sierra_program: decompressProgram(contract.sierra_program),
            contract_class_version: contract.contract_class_version,
            entry_points_by_type: contract.entry_points_by_type,
            abi: contract.abi,
          },
          resource_bounds: details.resourceBounds,
          tip: toHex(details.tip),
          paymaster_data: details.paymasterData.map((it) => toHex(it)),
          account_deployment_data: details.accountDeploymentData.map((it) => toHex(it)),
          nonce_data_availability_mode: details.nonceDataAvailabilityMode,
          fee_data_availability_mode: details.feeDataAvailabilityMode,
        },
      });
    } else {
      throw Error('declare unspotted parameters');
    }

    return this.waitMode ? this.waitForTransaction((await promise).transaction_hash) : promise;
  }

  public async deployAccount(
    { classHash, constructorCalldata, addressSalt, signature }: DeployAccountContractTransaction,
    details: InvocationsDetailsWithNonce
  ) {
    const version = details.version ? toHex(details.version) : '0x3';
    let promise;
    if (!isV3Tx(details)) {
      promise = this.fetchEndpoint('starknet_addDeployAccountTransaction', {
        deploy_account_transaction: {
          constructor_calldata: CallData.toHex(constructorCalldata || []),
          class_hash: toHex(classHash),
          contract_address_salt: toHex(addressSalt || 0),
          type: RPC.V0_6.ETransactionType.DEPLOY_ACCOUNT,
          max_fee: toHex(details.maxFee || 0),
          version: version as RPC.V0_6.SPEC.DEPLOY_ACCOUNT_TXN_V1['version'], // todo: rethink
          signature: signatureToHexArray(signature),
          nonce: toHex(details.nonce),
        },
      });
    } else {
      promise = this.fetchEndpoint('starknet_addDeployAccountTransaction', {
        deploy_account_transaction: {
          type: RPC.V0_6.ETransactionType.DEPLOY_ACCOUNT,
          version: version as RPC.V0_6.SPEC.DEPLOY_ACCOUNT_TXN_V3['version'], // todo: rethink
          signature: signatureToHexArray(signature),
          nonce: toHex(details.nonce),
          contract_address_salt: toHex(addressSalt || 0),
          constructor_calldata: CallData.toHex(constructorCalldata || []),
          class_hash: toHex(classHash),
          resource_bounds: details.resourceBounds,
          tip: toHex(details.tip),
          paymaster_data: details.paymasterData.map((it) => toHex(it)),
          account_deployment_data: details.accountDeploymentData.map((it) => toHex(it)),
          nonce_data_availability_mode: details.nonceDataAvailabilityMode,
          fee_data_availability_mode: details.feeDataAvailabilityMode,
        },
      });
    }

    return this.waitMode ? this.waitForTransaction((await promise).transaction_hash) : promise;
  }

  public callContract(call: Call, blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_call', {
      request: {
        contract_address: call.contractAddress,
        entry_point_selector: getSelectorFromName(call.entrypoint),
        calldata: CallData.toHex(call.calldata),
      },
      block_id,
    });
  }

  /**
   * NEW: Estimate the fee for a message from L1
   * @param message Message From L1
   */
  public estimateMessageFee(
    message: RPC.V0_6.L1Message,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const { from_address, to_address, entry_point_selector, payload } = message;
    const formattedMessage = {
      from_address: toHex(from_address),
      to_address: toHex(to_address),
      entry_point_selector: getSelector(entry_point_selector),
      payload: getHexStringArray(payload),
    };

    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_estimateMessageFee', {
      message: formattedMessage,
      block_id,
    });
  }

  /**
   * Returns an object about the sync status, or false if the node is not synching
   * @returns Object with the stats data
   */
  public getSyncingStats() {
    return this.fetchEndpoint('starknet_syncing');
  }

  /**
   * Returns all events matching the given filter
   * @returns events and the pagination of the events
   */
  public getEvents(eventFilter: RPC.V0_6.EventFilter) {
    return this.fetchEndpoint('starknet_getEvents', { filter: eventFilter });
  }

  public buildTransaction(
    invocation: AccountInvocationItem,
    versionType?: 'fee' | 'transaction'
  ): RPC.V0_6.BaseTransaction {
    const defaultVersions = getVersionsByType(versionType);
    let details;

    if (!isV3Tx(invocation)) {
      // V0,V1,V2
      details = {
        signature: signatureToHexArray(invocation.signature),
        nonce: toHex(invocation.nonce),
        max_fee: toHex(invocation.maxFee || 0),
      };
    } else {
      // V3
      details = {
        signature: signatureToHexArray(invocation.signature),
        nonce: toHex(invocation.nonce),
        resource_bounds: invocation.resourceBounds,
        tip: toHex(invocation.tip),
        paymaster_data: invocation.paymasterData.map((it) => toHex(it)),
        account_deployment_data: invocation.accountDeploymentData.map((it) => toHex(it)),
        nonce_data_availability_mode: invocation.nonceDataAvailabilityMode,
        fee_data_availability_mode: invocation.feeDataAvailabilityMode,
      };
    }

    if (invocation.type === TransactionType.INVOKE) {
      return {
        // v0 v1 v3
        type: RPC.V0_6.ETransactionType.INVOKE, // Diff between sequencer and rpc invoke type
        sender_address: invocation.contractAddress,
        calldata: CallData.toHex(invocation.calldata),
        version: toHex(invocation.version || defaultVersions.v3),
        ...details,
      } as RPC.V0_6.SPEC.BROADCASTED_INVOKE_TXN;
    }
    if (invocation.type === TransactionType.DECLARE) {
      if (!isSierra(invocation.contract)) {
        // Cairo 0 - v1
        return {
          type: invocation.type,
          contract_class: invocation.contract,
          sender_address: invocation.senderAddress,
          version: toHex(invocation.version || defaultVersions.v1),
          ...details,
        } as RPC.V0_6.SPEC.BROADCASTED_DECLARE_TXN_V1;
      }
      return {
        // Cairo 1 - v2 v3
        type: invocation.type,
        contract_class: {
          ...invocation.contract,
          sierra_program: decompressProgram(invocation.contract.sierra_program),
        },
        compiled_class_hash: invocation.compiledClassHash || '',
        sender_address: invocation.senderAddress,
        version: toHex(invocation.version || defaultVersions.v3),
        ...details,
      } as RPC.V0_6.SPEC.BROADCASTED_DECLARE_TXN;
    }
    if (invocation.type === TransactionType.DEPLOY_ACCOUNT) {
      // v1 v3
      return {
        type: invocation.type,
        constructor_calldata: CallData.toHex(invocation.constructorCalldata || []),
        class_hash: toHex(invocation.classHash),
        contract_address_salt: toHex(invocation.addressSalt || 0),
        version: toHex(
          invocation.version || defaultVersions.v3
        ) as RPC.V0_6.SPEC.INVOKE_TXN['version'],
        ...details,
      } as RPC.V0_6.SPEC.BROADCASTED_DEPLOY_ACCOUNT_TXN;
    }
    throw Error('RPC buildTransaction received unknown TransactionType');
  }
}