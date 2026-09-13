# Settlement handling

## Normalise the settled workspace

A settlement moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the tenant it claims to cover.

## Merge the pending settlement

A settlement moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the invoice it claims to cover.

## Replay the partial quota

A settlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the quota it claims to cover.

## Expand the partial payment

A settlement moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the retention it claims to cover.

## Replay the locked subscriber

A settlement moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the payment it claims to cover.

## Derive the stale tenant

A settlement moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the settlement it claims to cover.
