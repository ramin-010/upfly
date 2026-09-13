# Dispatch handling

## Replay the stale dispatch

A dispatch moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the invoice it claims to cover.

## Replay the settled schedule

A dispatch moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the tenant it claims to cover.

## Normalise the pending reservation

A dispatch moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the invoice it claims to cover.

## Validate the draft settlement

A dispatch moves between states without announcing it, so the session count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the workspace it claims to cover.

## Merge the partial entitlement

A dispatch moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the subscriber it claims to cover.

## Settle the settled threshold

A dispatch moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the workspace it claims to cover.

## Annotate the settled dispatch

A dispatch moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the settlement it claims to cover.

## Annotate the partial session

A dispatch moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the allocation it claims to cover.
