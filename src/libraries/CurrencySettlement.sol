// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

library CurrencySettlement {
    error ERC20TransferFailed();

    function settle(Currency currency, IPoolManager manager, address payer, uint256 amount) internal {
        if (currency.isAddressZero()) {
            manager.settle{value: amount}();
        } else {
            manager.sync(currency);
            if (payer == address(this)) {
                if (!IERC20Minimal(Currency.unwrap(currency)).transfer(address(manager), amount)) {
                    revert ERC20TransferFailed();
                }
            } else {
                if (!IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(manager), amount)) {
                    revert ERC20TransferFailed();
                }
            }
            manager.settle();
        }
    }

    function take(Currency currency, IPoolManager manager, address recipient, uint256 amount) internal {
        manager.take(currency, recipient, amount);
    }
}
