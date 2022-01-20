import "../helpers/chaisetup";

import {expect} from "chai";

import {
    Context,
    Done
} from "mocha";


import {BridgeWatcher} from "../../src/bridge/bridgewatcher";
import {ChainId} from "../../src";

describe("BridgeWatcher tests", function(this: Mocha.Suite) {
    it("should do something", function(this: Context, done: Done) {
        this.timeout(35*1000);

        const args: BridgeWatcher.CheckBridgeTransactionParams = {
            transactionHash: "0x5bf0616c7361d1d6efd234ec079c13072a72fc93d0492ae1232a555753213347",
            sourceChainId: ChainId.BSC,
        }

        expect(BridgeWatcher.checkTransactionStatus(args))
            .to.eventually.have.ownProperty("status", BridgeWatcher.BridgeTransactionStatus.Complete)
            .notify(done);
    })
})