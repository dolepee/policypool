# Liquidity Covenants: Why X Layer Markets Need Enforceable Trading Terms

Liquidity Covenant Note 01, by PolicyPool. Liquidity that can say no, or charge overflow to pay LPs first.

## The problem: liquidity is silent

Most DeFi liquidity is silent. It sits in a pool and accepts any valid swap against available reserves. An LP can adjust ranges, fees, or inventory, but the pool itself rarely says: I accept this size, I refuse that size, I accept overflow only if LPs are compensated first, I stop after this much daily flow. Those terms, when they exist at all, live in a frontend, a router, a Telegram post, or an offchain monitor, none of which the chain enforces and any of which can be bypassed.

That gap is felt most where capital is freshly exposed: new token pools get sniped, market-maker inventory gets run over by a single oversized fill, and treasuries expose liquidity with no enforceable ceiling. The market is becoming venue-rich on X Layer, with hooks, launchpads, and Exchange OS spot, perps, and outcome markets, and every one of those venues has the same unanswered question: how does a liquidity provider control the flow it exposes without hiding the rules offchain?

## What a liquidity covenant is

A liquidity covenant is a pool-level promise enforced at the execution boundary. The rule is attached to the liquidity itself and checked before capital moves, not after. In Uniswap v4 terms it runs in beforeSwap; the same idea ports to any execution surface.

Covenant types include:

- Maximum swap size.
- Rolling daily flow cap.
- Soft cap with LP surge compensation, where overflow passes only if LPs are paid first.
- Launch-period cap that relaxes later.
- Inventory-protection cap for market makers.
- Treasury or protocol-owned liquidity operating envelope.
- Optional immutable or timelocked policy mode.

## The honest line on enforcement

A covenant is mechanical, not a judgment call. PolicyPool does not rate intent or decide whether a trade is good. It enforces published numbers, and every decision is one of three objective outcomes, each written onchain as a receipt:

- ALLOW: the trade is within the covenant and clears.
- BLOCK: the trade exceeds the covenant (over max swap, or over the daily cap) and is refused in beforeSwap before liquidity is touched.
- SURGE: the trade exceeds the max swap but passes because the router pays the surge fee to in-range LPs first, in the same atomic unlock.

This is the difference between a covenant and a vague safety claim. The terms are numbers, the enforcement is onchain, and the outcome is verifiable by anyone.

## How to verify

- The covenant terms are onchain via the policy setter, not a frontend label.
- Every accept, refuse, and surge emits a receipt.
- The Covenant Registry lists each pool's terms and proof-backed totals; the receipts page and the verifier script replay the same X Layer mainnet proof set.

## The core claim

Launchpads protect projects at launch. PolicyPool protects liquidity after capital is exposed. The two are complementary, not competing: a safe launch still leaves the pool silent the moment trading opens. A covenant keeps the pool speaking for itself.

## Reference implementation

PolicyPool is live on X Layer mainnet and placed 2nd at the Hook the Future hackathon. The first adapter is a Uniswap v4 hook. Three pools are in the Covenant Registry today: Loose (V1), Strict (V1), and Surge (V2), each with onchain accept, refuse, and surge receipts. The covenant engine is execution-agnostic by design, so the same terms extend to launchpad pools and Exchange OS venues as new adapters.

## Want your pool covenanted?

Covenants start with PolicyPool's own pools. External pools are added to the registry only after a covenant review. Open an issue on the repository to request one.
