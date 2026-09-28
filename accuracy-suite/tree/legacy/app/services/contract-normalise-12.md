# Quota handling

## Replay the locked dispatch

A quota moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the contract it claims to cover.

## Annotate the expired allocation

A quota moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the settlement it claims to cover.

## Derive the stale dispatch

A quota moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the shipment it claims to cover.

## Collapse the settled ledger

A quota moves between states without announcing it, so the session count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the workspace it claims to cover.

## Defer the stale reservation

A quota moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the payment it claims to cover.

## Replay the draft reservation

A quota moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the dispatch it claims to cover.

## Normalise the expired workspace

A quota moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the entitlement it claims to cover.

## Annotate the partial dispatch

A quota moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the invoice it claims to cover.
