// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IBondAsset {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice First-loss custody for provider-funded service covenants.
/// @dev The manager may lock, release, or slash only covenant-specific amounts.
contract ProviderBondVault {
    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error WithdrawalDelayTooShort();
    error InsufficientAvailableBond();
    error WithdrawalAlreadyQueued();
    error WithdrawalNotQueued();
    error WithdrawalNotReady();
    error CovenantAlreadyLocked();
    error CovenantNotActive();
    error InvalidSlashAmount();
    error TokenTransferFailed();
    error FeeOnTransferUnsupported();
    error Reentrancy();
    error ManagerAlreadyInitialized();
    error ManagerNotInitialized();

    uint256 public constant MIN_WITHDRAWAL_DELAY = 8 days;

    struct BondAccount {
        uint256 balance;
        uint256 locked;
        uint256 queuedWithdrawal;
        uint64 withdrawalReadyAt;
    }

    struct CovenantLock {
        address provider;
        uint256 amount;
        bool active;
    }

    IBondAsset public immutable asset;
    uint256 public immutable withdrawalDelay;
    address public owner;
    address public pendingOwner;
    address public manager;
    bool public managerInitialized;

    mapping(address provider => BondAccount account) private accounts;
    mapping(bytes32 covenantId => CovenantLock covenantLock) public covenantLocks;

    uint256 private entered = 1;

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ManagerUpdated(address indexed previousManager, address indexed newManager);
    event BondDeposited(address indexed funder, address indexed provider, uint256 amount);
    event BondLocked(bytes32 indexed covenantId, address indexed provider, uint256 amount);
    event BondReleased(bytes32 indexed covenantId, address indexed provider, uint256 amount);
    event BondSlashed(
        bytes32 indexed covenantId,
        address indexed provider,
        address indexed recipient,
        uint256 payout,
        uint256 unlockedRemainder
    );
    event WithdrawalQueued(address indexed provider, uint256 amount, uint256 readyAt);
    event WithdrawalCancelled(address indexed provider, uint256 amount);
    event WithdrawalExecuted(address indexed provider, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address asset_, address owner_, uint256 withdrawalDelay_) {
        if (asset_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (withdrawalDelay_ < MIN_WITHDRAWAL_DELAY) revert WithdrawalDelayTooShort();
        asset = IBondAsset(asset_);
        owner = owner_;
        withdrawalDelay = withdrawalDelay_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function account(address provider) external view returns (BondAccount memory) {
        return accounts[provider];
    }

    function availableBond(address provider) public view returns (uint256) {
        BondAccount storage current = accounts[provider];
        return current.balance - current.locked - current.queuedWithdrawal;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function initializeManager(address nextManager) external onlyOwner {
        if (nextManager == address(0)) revert ZeroAddress();
        if (managerInitialized) revert ManagerAlreadyInitialized();
        manager = nextManager;
        managerInitialized = true;
        emit ManagerUpdated(address(0), nextManager);
    }

    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    function depositFor(address provider, uint256 amount) public nonReentrant {
        if (!managerInitialized) revert ManagerNotInitialized();
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBalance = asset.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert FeeOnTransferUnsupported();
        accounts[provider].balance += amount;
        emit BondDeposited(msg.sender, provider, amount);
    }

    function requestWithdrawal(uint256 amount) external {
        BondAccount storage current = accounts[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (current.queuedWithdrawal != 0) revert WithdrawalAlreadyQueued();
        if (amount > availableBond(msg.sender)) revert InsufficientAvailableBond();
        current.queuedWithdrawal = amount;
        current.withdrawalReadyAt = uint64(block.timestamp + withdrawalDelay);
        emit WithdrawalQueued(msg.sender, amount, current.withdrawalReadyAt);
    }

    function cancelWithdrawal() external {
        BondAccount storage current = accounts[msg.sender];
        uint256 amount = current.queuedWithdrawal;
        if (amount == 0) revert WithdrawalNotQueued();
        current.queuedWithdrawal = 0;
        current.withdrawalReadyAt = 0;
        emit WithdrawalCancelled(msg.sender, amount);
    }

    function executeWithdrawal() external nonReentrant {
        BondAccount storage current = accounts[msg.sender];
        uint256 amount = current.queuedWithdrawal;
        if (amount == 0) revert WithdrawalNotQueued();
        if (block.timestamp < current.withdrawalReadyAt) revert WithdrawalNotReady();
        current.queuedWithdrawal = 0;
        current.withdrawalReadyAt = 0;
        current.balance -= amount;
        _safeTransfer(msg.sender, amount);
        emit WithdrawalExecuted(msg.sender, amount);
    }

    function lock(bytes32 covenantId, address provider, uint256 amount) external onlyManager {
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (covenantLocks[covenantId].provider != address(0)) revert CovenantAlreadyLocked();
        if (amount > availableBond(provider)) revert InsufficientAvailableBond();
        accounts[provider].locked += amount;
        covenantLocks[covenantId] = CovenantLock({provider: provider, amount: amount, active: true});
        emit BondLocked(covenantId, provider, amount);
    }

    function release(bytes32 covenantId) external onlyManager {
        CovenantLock storage current = covenantLocks[covenantId];
        if (!current.active) revert CovenantNotActive();
        current.active = false;
        accounts[current.provider].locked -= current.amount;
        emit BondReleased(covenantId, current.provider, current.amount);
    }

    function slash(bytes32 covenantId, address recipient, uint256 payout) external onlyManager nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        CovenantLock storage current = covenantLocks[covenantId];
        if (!current.active) revert CovenantNotActive();
        if (payout == 0 || payout > current.amount) revert InvalidSlashAmount();

        current.active = false;
        BondAccount storage providerAccount = accounts[current.provider];
        providerAccount.locked -= current.amount;
        providerAccount.balance -= payout;
        uint256 unlockedRemainder = current.amount - payout;
        _safeTransfer(recipient, payout);
        emit BondSlashed(covenantId, current.provider, recipient, payout, unlockedRemainder);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory result) =
            address(asset).call(abi.encodeWithSelector(IBondAsset.transfer.selector, to, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) =
            address(asset).call(abi.encodeWithSelector(IBondAsset.transferFrom.selector, from, to, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenTransferFailed();
    }
}
