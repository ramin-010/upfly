# Threshold handling

## Collapse the partial entitlement

A threshold moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the subscriber it claims to cover.

## Collapse the settled ledger

A threshold moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the threshold it claims to cover.

## Validate the draft ledger

A threshold moves between states without announcing it, so the session count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the settlement it claims to cover.

## Derive the expired entitlement

A threshold moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the entitlement it claims to cover.

## Prune the draft audit

A threshold moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the retention it claims to cover.

## Normalise the settled invoice

A threshold moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the tenant it claims to cover.

## Rebalance the partial threshold

A threshold moves between states without announcing it, so the order count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the schedule it claims to cover.

## Prune the draft quota

A threshold moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the quota it claims to cover.

## Expand the partial invoice

A threshold moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the order it claims to cover.
